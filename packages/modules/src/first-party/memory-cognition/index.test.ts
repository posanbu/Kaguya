/**
 * 功能概述：验证在线认知快照选择只消费已完成、同范围、同 provider 版本的证据。
 * ledger 测试替身记录明确来源链，覆盖空快照替代旧事实、Web conversationId 范围隔离、
 * 旧 Web 键兼容、跨范围证据拒绝和可选消费路径；Web 隔离不改变 Identity 对长期认知的准入限制。
 * 不调用外部模型，不模拟或实现任何事实演化算法。
 */
import { describe, expect, it, vi } from "vitest";
import { cognitionScopeKey, createCognitionMemorySelector } from "./index.js";
const source = {
  platform: "qq",
  adapterId: "qq",
  senderId: "user",
  platformMessageId: "message",
  destination: { kind: "group", groupId: "group" },
};
const base = {
  occurredAt: "2026-09-01T00:00:00.000Z",
  source: "module:test",
  references: [],
};
const inbound: any = {
  ...base,
  informationId: "inbound",
  kind: "core.message.inbound.text",
  payload: { text: "hello", source },
};
const candidate: any = {
  ...base,
  informationId: "candidate",
  kind: "agent.turn.candidate",
  payload: { asOf: "2026-09-01T00:01:00.000Z" },
};
const memory: any = {
  ...base,
  informationId: "memory",
  kind: "core.memory.text",
  references: [{ relation: "core:uses-context", informationId: "inbound" }],
  payload: { text: "provider fact" },
};
const identity = { providerId: "test", revision: "v1" };
const snapshot: any = {
  ...base,
  informationId: "snapshot",
  kind: "agent.memory.cognition.completed",
  payload: {
    identity,
    scopeKey: JSON.stringify([
      source.platform,
      source.adapterId,
      source.senderId,
      source.destination,
    ]),
    asOf: base.occurredAt,
    status: "completed",
    memoryInformationId: "memory",
  },
};
async function select(
  snapshots = [snapshot],
  evidence = inbound,
  current = inbound,
) {
  const find = vi.fn(async () => snapshots);
  const ids = await createCognitionMemorySelector(identity).select({
    sourceAtom: candidate,
    ledger: {
      find,
      retrieve: async () => [],
      related: async (query) =>
        query.from[0] === "candidate"
          ? [current]
          : query.relation === "agent:evidence"
            ? [evidence]
            : [memory],
    },
  });
  return { ids, find };
}
describe("completed cognition selection", () => {
  it("selects a snapshot with its exact provider, scope and cutoff", async () => {
    const result = await select();
    expect(result.ids).toEqual(["memory"]);
    expect(result.find).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadContains: { identity, scopeKey: snapshot.payload.scopeKey },
        occurredBefore: candidate.payload.asOf,
      }),
    );
  });
  it("lets a newer empty snapshot supersede older facts", async () => {
    const result = await select([
      snapshot,
      {
        ...snapshot,
        informationId: "empty",
        payload: {
          ...snapshot.payload,
          status: "empty",
          memoryInformationId: null,
          asOf: "2026-09-01T00:00:30.000Z",
        },
      },
    ]);
    expect(result.ids).toEqual([]);
  });
  it("rejects evidence from another chat scope", async () => {
    const result = await select([snapshot], {
      ...inbound,
      payload: {
        ...inbound.payload,
        source: { ...source, destination: { kind: "group", groupId: "other" } },
      },
    });
    expect(result.ids).toEqual([]);
  });

  it("preserves Web conversation boundaries in scope queries and evidence validation", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const webSource = {
      ...source,
      platform: "web",
      adapterId: "web.ui.main",
      destination: { kind: "web", conversationId },
    };
    const webInbound = {
      ...inbound,
      payload: { ...inbound.payload, source: webSource },
    };
    const scopeKey = JSON.stringify([
      "web",
      "web.ui.main",
      "user",
      { kind: "web", conversationId },
    ]);
    const webSnapshot = {
      ...snapshot,
      payload: { ...snapshot.payload, scopeKey },
    };
    const nextSource = { ...webSource, platformMessageId: "next" };
    expect(cognitionScopeKey(nextSource)).toBe(scopeKey);
    expect(
      cognitionScopeKey({ ...webSource, destination: { kind: "web" } }),
    ).toBe(JSON.stringify(["web", "web.ui.main", "user", { kind: "web" }]));
    const selected = await select([webSnapshot], webInbound, webInbound);
    expect(selected.ids).toEqual(["memory"]);
    expect(selected.find).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadContains: { identity, scopeKey },
      }),
    );
    const rejected = await select(
      [webSnapshot],
      {
        ...webInbound,
        payload: {
          ...webInbound.payload,
          source: {
            ...webSource,
            destination: {
              kind: "web",
              conversationId: "22222222-2222-4222-8222-222222222222",
            },
          },
        },
      },
      webInbound,
    );
    expect(rejected.ids).toEqual([]);
  });
});
