/** 验证冷启动状态只由冻结输入、身份实体来源和 Memory 开关决定。 */
import { describe, expect, it } from "vitest";
import {
  chatScopeEntityInformationKind,
  normalizeTurnBootstrap,
  personEntityInformationKind,
} from "../information-kinds.js";
import { atom } from "../heavy/test-fixtures.js";
import { buildTurnBootstrap } from "./bootstrap.js";

const inbound = atom("input-1", "core.message.inbound.text", {
  text: "hello",
  source: {
    platform: "qq",
    adapterId: "qq.main",
    destination: { kind: "private", userId: "user-1" },
    senderId: "user-1",
    platformMessageId: "message-1",
  },
});

function identity(scopeMode: "canonical" | "ephemeral" = "canonical") {
  return atom("identity-1", "memory.identity.person.context.completed", {
    status: scopeMode === "canonical" ? "complete" : "unresolved",
    scopeMode,
    platform: "qq",
    adapterId: "qq.main",
    scopeInformationId: "scope-1",
    ...(scopeMode === "canonical" ? { personInformationId: "person-1" } : {}),
  });
}

function entity(id: string, kind: string, cause: string) {
  return atom(id, kind, {}, [
    { relation: "core:caused-by", informationId: cause },
  ]);
}

describe("identity registration evidence", () => {
  it.each(["input-1", "old-input"])(
    "preserves %s evidence without inferring acquaintance",
    (cause) => {
      const projection = buildTurnBootstrap(
        [{ inbound, identity: identity() }],
        [
          entity("scope-1", chatScopeEntityInformationKind.kind, cause),
          entity("person-1", personEntityInformationKind.kind, cause),
        ],
      );
      expect(projection).toMatchObject({
        version: 2,
        participants: [
          {
            ownerId: "person:person-1",
            registration: {
              sourceIds: [cause],
              createdInCurrentInputs: cause === "input-1",
            },
          },
        ],
      });
      expect(projection).not.toHaveProperty("mode");
      expect(projection).not.toHaveProperty("memory");
      expect(projection.participants[0]).not.toHaveProperty("state");
      expect(normalizeTurnBootstrap({ bootstrap: projection })).toEqual(
        projection,
      );
    },
  );
  it("leaves missing evidence unknown", () => {
    expect(
      buildTurnBootstrap([{ inbound, identity: identity("ephemeral") }], []),
    ).toEqual({
      version: 2,
      conversation: { scopeMode: "ephemeral", registration: null },
      participants: [
        { inputInformationId: "input-1", ownerId: null, registration: null },
      ],
    });
  });
});
