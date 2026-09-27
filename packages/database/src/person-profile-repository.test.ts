import { describe, expect, it } from "vitest";
import {
  PERSON_PROFILE_REVISION_KIND,
  emptyPersonProfileMetadata,
  emptyPersonProfileSections,
  freezeInformationAtom,
  informationAtomSchema,
} from "@kaguya/schema";
import { createTestingDatabase } from "./testing.js";

function atom(
  informationId: string,
  kind: string,
  payload: Record<string, unknown>,
  references: { relation: string; informationId: string }[] = [],
) {
  return freezeInformationAtom(
    informationAtomSchema.parse({
      informationId,
      kind,
      payload,
      references,
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "test:person-profile",
    }),
  );
}

describe("person profile repository", () => {
  it("saves immutable revisions, rejects stale edits, and only changes a new startup snapshot", async () => {
    const database = await createTestingDatabase();
    try {
      await database.prepareSchema();
      await database.information.synchronizeKinds([
        "core.message.inbound.text",
        "memory.identity.person.entity",
        "memory.identity.platform.account.entity",
        "memory.identity.platform.account.binding",
        PERSON_PROFILE_REVISION_KIND,
      ]);
      await database.information.append(
        atom("account-1", "memory.identity.platform.account.entity", {
          platform: "qq",
          adapterId: "adapter",
          accountId: "42",
        }),
        [],
      );
      await database.information.append(
        atom("inbound-1", "core.message.inbound.text", {
          source: {
            sender: { nickname: "首次平台昵称", card: "不可用群名片" },
          },
        }),
        [],
      );
      await database.information.append(
        atom("person-1", "memory.identity.person.entity", { accountId: "42" }, [
          { relation: "core:caused-by", informationId: "inbound-1" },
        ]),
        [{ relation: "core:caused-by", required: true, multiple: false }],
      );
      await database.information.append(
        atom(
          "binding-1",
          "memory.identity.platform.account.binding",
          { accountId: "42", personInformationId: "person-1" },
          [{ relation: "core:binds", informationId: "account-1" }],
        ),
        [
          {
            relation: "core:binds",
            required: true,
            multiple: false,
            targetKinds: ["memory.identity.platform.account.entity"],
          },
        ],
      );
      const first = await database.personProfiles.save("person-1", 0, {
        ...emptyPersonProfileSections(),
        stableFacts: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            text: "喜欢天文学",
            source: "manual",
            evidenceInformationIds: [],
          },
        ],
      });
      expect(first.revision).toBe(1);
      const active = await database.personProfiles.loadActiveSnapshot();
      expect(active.byPerson.get("person-1")).toBe(first.informationId);
      expect(active.initialNames.get("person-1")).toBe("首次平台昵称");
      await database.information.append(
        atom("later-inbound", "core.message.inbound.text", {
          source: { sender: { nickname: "新昵称", card: "新群名片" } },
        }),
        [],
      );
      await database.information.append(
        atom("person-2", "memory.identity.person.entity", { accountId: "43" }, [
          { relation: "core:caused-by", informationId: "later-inbound" },
        ]),
        [{ relation: "core:caused-by", required: true, multiple: false }],
      );
      expect(
        (await database.personProfiles.loadActiveSnapshot()).initialNames.get(
          "person-1",
        ),
      ).toBe("首次平台昵称");
      expect(
        (await database.personProfiles.loadActiveSnapshot()).initialNames.get(
          "person-2",
        ),
      ).toBe("新昵称");
      expect(first.metadata).toEqual(emptyPersonProfileMetadata());
      expect(
        active.byAccount.get('["qq","adapter","42"]')?.personInformationId,
      ).toBe("person-1");
      await expect(
        database.personProfiles.save(
          "person-1",
          0,
          emptyPersonProfileSections(),
        ),
      ).rejects.toMatchObject({ code: "profile_changed", status: 409 });
      const second = await database.personProfiles.save(
        "person-1",
        1,
        emptyPersonProfileSections(),
        {
          ...emptyPersonProfileMetadata(),
          primaryName: "手工主称呼",
          aliases: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              text: "别名",
              source: "manual",
              evidenceInformationIds: [],
            },
          ],
          nameReason: "本人确认",
          knownStatus: "known",
        },
      );
      expect(second.revision).toBe(2);
      expect(second.informationId).not.toBe(first.informationId);
      expect(active.byPerson.get("person-1")).toBe(first.informationId);
      expect(active.metadataByPerson.get("person-1")?.primaryName).toBeNull();
      expect(
        (await database.personProfiles.loadActiveSnapshot()).byPerson.get(
          "person-1",
        ),
      ).toBe(second.informationId);
      expect(
        (
          await database.personProfiles.loadActiveSnapshot()
        ).metadataByPerson.get("person-1")?.primaryName,
      ).toBe("手工主称呼");
      const previous = await database.information.get(first.informationId!);
      expect(previous?.payload.sections).toEqual(first.sections);
      await database.information.append(
        atom(
          "legacy-profile",
          PERSON_PROFILE_REVISION_KIND,
          {
            personInformationId: "person-2",
            revision: 1,
            sections: emptyPersonProfileSections(),
            previousRevisionInformationId: null,
          },
          [{ relation: "memory:profile-of", informationId: "person-2" }],
        ),
        [{ relation: "memory:profile-of", required: true, multiple: false }],
      );
      expect((await database.personProfiles.get("person-2")).metadata).toEqual(
        emptyPersonProfileMetadata(),
      );
      expect(
        (
          await database.personProfiles.loadActiveSnapshot()
        ).metadataByPerson.get("person-2"),
      ).toEqual(emptyPersonProfileMetadata());
      await expect(
        database.personProfiles.get("missing-person"),
      ).rejects.toMatchObject({ code: "person_not_found", status: 404 });
    } finally {
      await database.close();
    }
  });
});
