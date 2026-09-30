import { describe, expect, it } from "vitest";
import {
  PERSON_PROFILE_REVISION_KIND,
  emptyPersonProfileMetadata,
  emptyPersonProfileSections,
} from "@kaguya/schema";
import { loadFirstPartyPromptTemplates } from "../node/prompt-templates.js";
import {
  frozenSpeakerName,
  renderPersonProfileSections,
  selectActivePersonProfiles,
} from "./person-profile.js";
import { compileLightPrompt } from "./router/light.js";
import { compileMessagePrompt } from "./heavy/message-prompt.js";
import { atom, fixture, identity } from "./heavy/test-fixtures.js";

const templates = loadFirstPartyPromptTemplates();
const entry = (text: string) => ({
  id: "00000000-0000-4000-8000-000000000001",
  text,
  source: "manual" as const,
  evidenceInformationIds: [] as [],
});

describe("person profile prompt", () => {
  it("previews an accountless person without inventing an account", () => {
    const rendered = renderPersonProfileSections(
      { ...emptyPersonProfileSections(), identity: [entry("17 岁的高中生")] },
      "person:iroha-id",
      {
        personInformationId: "iroha-id",
        metadata: {
          ...emptyPersonProfileMetadata(),
          primaryName: "酒寄彩叶",
        },
      },
    );
    expect(rendered).toContain('主称呼："酒寄彩叶"');
    expect(rendered).toContain("人物ID：iroha-id");
    expect(rendered).not.toContain("账号");
  });

  it("bounds each person block and uses uncertain notes only as a fallback", () => {
    const uncertain = {
      ...emptyPersonProfileSections(),
      uncertainNotes: [entry("可能喜欢古典音乐")],
    };
    expect(renderPersonProfileSections(uncertain, "speaker:42")).toContain(
      "可能喜欢古典音乐",
    );
    const established = {
      ...uncertain,
      stableFacts: [entry("x".repeat(500)), entry("y".repeat(500))],
    };
    const rendered = renderPersonProfileSections(established, "speaker:42");
    expect(rendered).not.toContain("可能喜欢古典音乐");
    expect(Array.from(rendered).length).toBeLessThanOrEqual(900);
    const withNames = renderPersonProfileSections(established, "speaker:42", {
      personInformationId: "person-42",
      metadata: {
        ...emptyPersonProfileMetadata(),
        primaryName: "主".repeat(100),
        aliases: Array.from({ length: 8 }, (_, index) => ({
          ...entry(`别${index}`.repeat(50)),
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      },
    });
    expect(Array.from(withNames).length).toBeLessThanOrEqual(900);
  });

  it("uses the same frozen revision in Light and Heavy after later edits", () => {
    const f = fixture(["聊聊星空"]);
    const selected = {
      personInformationId: "person-1",
      profileInformationId: "profile-1",
      speakerKey: "speaker:sender-0",
    };
    const metadata = {
      ...emptyPersonProfileMetadata(),
      primaryName: "小艾",
      aliases: [
        { ...entry("艾同学"), id: "00000000-0000-4000-8000-000000000002" },
      ],
      nameReason: "人工确认",
      knownStatus: "unknown" as const,
    };
    const inputs = (f.turn.payload as any).inputs.map(
      (input: any, index: number) => ({
        ...input,
        source: {
          ...input.source,
          sender: {
            userId: input.source.senderId,
            nickname: index === 0 ? "动态昵称" : "其他人",
            card: "错误群名片",
          },
        },
      }),
    );
    const turn = atom(
      f.turn.informationId,
      f.turn.kind,
      {
        ...f.turn.payload,
        inputs,
        personProfiles: [selected],
        personNames: [
          {
            personInformationId: "person-1",
            speakerKey: "speaker:sender-0",
            initialName: "首次昵称",
          },
        ],
      },
      [
        ...f.turn.references,
        { relation: "core:uses-context", informationId: "profile-1" },
      ],
    );
    const original = atom("profile-1", PERSON_PROFILE_REVISION_KIND, {
      personInformationId: "person-1",
      revision: 1,
      previousRevisionInformationId: null,
      sections: {
        ...emptyPersonProfileSections(),
        stableFacts: [entry("喜欢天文学")],
      },
      metadata,
    });
    const edited = atom("profile-2", PERSON_PROFILE_REVISION_KIND, {
      personInformationId: "person-1",
      revision: 2,
      sections: {
        ...emptyPersonProfileSections(),
        stableFacts: [entry("喜欢园艺")],
      },
      previousRevisionInformationId: "profile-1",
    });
    const atoms = [f.intent, turn, f.raw, ...f.messages, original, edited];
    const planner = compileLightPrompt(
      identity,
      atoms,
      turn,
      templates.light,
    );
    const composer = compileMessagePrompt(
      templates.heavy,
      identity,
      atoms,
      f.intent.informationId,
    );
    expect(planner.text).toBe(
      compileLightPrompt(
        identity,
        atoms.filter((item) => item.informationId !== "profile-2"),
        turn,
        templates.light,
      ).text,
    );
    expect(composer.text).toBe(
      compileMessagePrompt(
        templates.heavy,
        identity,
        atoms.filter((item) => item.informationId !== "profile-2"),
        f.intent.informationId,
      ).text,
    );
    for (const prompt of [planner, composer]) {
      expect(prompt.text).toContain("喜欢天文学");
      expect(prompt.text).not.toContain("喜欢园艺");
      expect(prompt.text).toContain("小艾（sender-0）");
      expect(prompt.text).toContain("艾同学");
      expect(prompt.text).not.toContain("错误群名片");
      expect(prompt.text).not.toContain("人工确认");
      expect(prompt.text).not.toContain("未认识");
      const turnVariable = prompt.variables.find(
        (variable) => variable.name === "scope_context",
      );
      expect(turnVariable?.content).toContain("聊聊星空");
      expect(turnVariable?.content).not.toContain("错误群名片");
      expect(
        prompt.variables.find((variable) => variable.name === "person_profiles")
          ?.informationIds,
      ).toEqual(["profile-1"]);
    }
    expect(
      planner.variables.find((variable) => variable.name === "person_profiles")
        ?.content,
    ).toBe(
      renderPersonProfileSections(
        original.payload.sections as any,
        selected.speakerKey,
        { personInformationId: "person-1", metadata, initialName: "首次昵称" },
      ),
    );
  });

  it("selects stable speaker and group mention/reply bindings without guessing unresolved people", () => {
    const active = {
      byPerson: new Map([
        ["speaker-person", "speaker-profile"],
        ["mention-person", "mention-profile"],
        ["reply-person", "reply-profile"],
      ]),
      byAccount: new Map([
        [
          '["qq","adapter","mentioned"]',
          {
            personInformationId: "mention-person",
            profileInformationId: "mention-profile",
          },
        ],
        [
          '["qq","adapter","replied"]',
          {
            personInformationId: "reply-person",
            profileInformationId: "reply-profile",
          },
        ],
      ]),
    };
    const inputs = [
      {
        personInformationId: "speaker-person",
        source: {
          platform: "qq",
          adapterId: "adapter",
          senderId: "speaker",
          mentions: [
            { kind: "user", id: "mentioned" },
            { kind: "user", id: "unknown" },
          ],
          replyTo: { senderId: "replied" },
        },
      },
    ];
    expect(
      selectActivePersonProfiles(inputs, true, active).map(
        (item) => item.personInformationId,
      ),
    ).toEqual(["speaker-person", "mention-person", "reply-person"]);
    expect(selectActivePersonProfiles(inputs, false, active)).toHaveLength(1);
    expect(
      selectActivePersonProfiles(
        [{ source: inputs[0]!.source }],
        false,
        active,
      ),
    ).toEqual([]);
  });

  it("keeps equal raw account IDs separate across platforms in frozen labels", () => {
    const names = [
      {
        personInformationId: "qq-person",
        speakerKey: "speaker:42",
        platform: "qq",
        adapterId: "adapter",
        initialName: "QQ 初名",
      },
      {
        personInformationId: "other-person",
        speakerKey: "speaker:42",
        platform: "discord",
        adapterId: "adapter",
        initialName: "Discord 初名",
      },
    ];
    expect(
      frozenSpeakerName(
        {
          platform: "qq",
          adapterId: "adapter",
          senderId: "42",
          sender: { nickname: "动态昵称" },
        },
        [],
        names,
        [],
      ),
    ).toBe("QQ 初名（42）");
    expect(
      frozenSpeakerName(
        {
          platform: "discord",
          adapterId: "adapter",
          senderId: "42",
          sender: { nickname: "动态昵称" },
        },
        [],
        names,
        [],
      ),
    ).toBe("Discord 初名（42）");
  });
});
