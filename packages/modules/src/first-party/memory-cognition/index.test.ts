/**
 * 功能概述：验证在线认知快照选择只消费已完成、同范围、同 provider 版本的证据。
 * ledger 测试替身记录明确来源链，覆盖空快照替代旧事实、跨范围证据拒绝和可选消费路径；
 * 不调用外部模型，不模拟或实现任何事实演化算法。
 */
import { describe, expect, it, vi } from "vitest";
import { createCognitionMemorySelector } from "./index.js";
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
async function select(snapshots = [snapshot], evidence = inbound) {
  const find = vi.fn(async () => snapshots);
  const ids = await createCognitionMemorySelector(identity).select({
    sourceAtom: candidate,
    ledger: {
      find,
      retrieve: async () => [],
      related: async (query) =>
        query.from[0] === "candidate"
          ? [inbound]
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
});
