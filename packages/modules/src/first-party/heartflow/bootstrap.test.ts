/** 验证冷启动状态只由冻结输入、身份实体来源和 Memory 开关决定。 */
import { describe, expect, it } from "vitest";
import {
  chatScopeEntityInformationKind,
  normalizeTurnBootstrap,
  personEntityInformationKind,
} from "../information-kinds.js";
import { atom } from "../message-composer/test-fixtures.js";
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
  return atom("identity-1", "agent.person.context.completed", {
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

describe("turn bootstrap projection", () => {
  it("marks the first canonical conversation and person as cold start", () => {
    const projection = buildTurnBootstrap(
      [{ inbound, identity: identity() }],
      [
        entity("scope-1", chatScopeEntityInformationKind.kind, "input-1"),
        entity("person-1", personEntityInformationKind.kind, "input-1"),
      ],
      true,
      0,
    );
    expect(projection).toEqual({
      version: 1,
      mode: "cold-start",
      memory: { state: "no-authorized-evidence", selectedCount: 0 },
      conversation: { state: "first-seen" },
      participants: [{ inputInformationId: "input-1", state: "first-seen" }],
    });
  });

  it("uses earlier entity causes and authorized memory as grounded evidence", () => {
    const projection = buildTurnBootstrap(
      [{ inbound, identity: identity() }],
      [
        entity("scope-1", chatScopeEntityInformationKind.kind, "old-input"),
        entity("person-1", personEntityInformationKind.kind, "old-input"),
      ],
      true,
      2,
    );
    expect(projection.mode).toBe("established");
    expect(projection.memory).toEqual({
      state: "available",
      selectedCount: 2,
    });
    expect(projection.conversation.state).toBe("known");
    expect(projection.participants[0]!.state).toBe("known");
  });

  it("warms an established conversation when a new person first appears", () => {
    const projection = buildTurnBootstrap(
      [{ inbound, identity: identity() }],
      [
        entity("scope-1", chatScopeEntityInformationKind.kind, "old-input"),
        entity("person-1", personEntityInformationKind.kind, "input-1"),
      ],
      true,
      0,
    );
    expect(projection).toMatchObject({
      mode: "warming",
      memory: { state: "no-authorized-evidence", selectedCount: 0 },
      conversation: { state: "known" },
      participants: [{ state: "first-seen" }],
    });
  });

  it("establishes a known conversation with a known person without memory", () => {
    const projection = buildTurnBootstrap(
      [{ inbound, identity: identity() }],
      [
        entity("scope-1", chatScopeEntityInformationKind.kind, "old-input"),
        entity("person-1", personEntityInformationKind.kind, "old-input"),
      ],
      true,
      0,
    );
    expect(projection).toMatchObject({
      mode: "established",
      memory: { state: "no-authorized-evidence", selectedCount: 0 },
      conversation: { state: "known" },
      participants: [{ state: "known" }],
    });
  });

  it("keeps ephemeral identity unresolved and distinguishes disabled memory", () => {
    const projection = buildTurnBootstrap(
      [{ inbound, identity: identity("ephemeral") }],
      [],
      false,
      0,
    );
    expect(projection).toMatchObject({
      mode: "cold-start",
      memory: { state: "disabled", selectedCount: 0 },
      conversation: { state: "ephemeral" },
      participants: [{ state: "unresolved" }],
    });
  });

  it("normalizes old facts conservatively without inventing familiarity", () => {
    expect(
      normalizeTurnBootstrap({
        inputs: [{ informationId: "input-1" }],
        memory: ["memory-1"],
      }),
    ).toEqual({
      version: 1,
      mode: "legacy-unknown",
      memory: { state: "available", selectedCount: 1 },
      conversation: { state: "unknown" },
      participants: [{ inputInformationId: "input-1", state: "unresolved" }],
    });
  });
});
