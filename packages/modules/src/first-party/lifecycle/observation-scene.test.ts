/**
 * 功能概述：验证完整 scene 的解析和 Lifecycle 只读选择，覆盖冒号碰撞与历史调度归属。
 * 主要职责：合成账本按真实 find/related 条件返回候选、来源和调度；验证旧事实引用链及歧义保留。
 * 代码库关系：直接运行 observation-scene 与 observation-state；真实 Core/数据库恢复由 index.test.ts 覆盖。
 * 输入输出与副作用：固定原子、无计时等待、无数据库或外部调用；断言精确选中身份而非只检查数量。
 */
import { expect, it } from "vitest";
import {
  freezeInformationAtom,
  informationIdSchema,
  jsonObjectSchema,
  sceneIdentity,
  type SceneAddress,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { resolveObservationAddress } from "./observation-scene.js";
import {
  heartbeatScopeSelector,
  heartbeatObservationSelector,
  scopeOf,
} from "./observation-state.js";

const first: SceneAddress = {
  platform: "a:b",
  adapterId: "c",
  destination: { kind: "group", groupId: "d" },
};
const second: SceneAddress = {
  platform: "a",
  adapterId: "b:c",
  destination: { kind: "group", groupId: "d" },
};
function atom(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  references: { relation: string; informationId: string }[] = [],
): DeepReadonly<InformationAtom> {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse(id),
    kind,
    occurredAt: "2026-11-07T00:00:00.000Z",
    source: "core:test",
    payload: jsonObjectSchema.parse(payload),
    references: references.map((r) => ({
      ...r,
      informationId: informationIdSchema.parse(r.informationId),
    })),
  });
}
const candidate = atom("candidate-a", "agent.heartbeat.candidate", {
  ...first,
  scopeKey: scopeOf(first),
});
const outcome = atom(
  "outcome-a",
  "agent.attention.arousal.completed",
  {
    candidateInformationId: candidate.informationId,
    scopeKey: scopeOf(first),
    outcome: "defer",
  },
  [{ relation: "core:status-of", informationId: candidate.informationId }],
);
const schedule = atom(
  "schedule-a",
  "core.schedule.one-shot.requested",
  { input: { purpose: "observation-recheck", scopeKey: scopeOf(first) } },
  [{ relation: "core:caused-by", informationId: outcome.informationId }],
);
const inbound = atom("inbound-b", "core.message.inbound.text", {
  source: second,
});
const rows = [candidate, outcome, schedule, inbound];
const read = async (id: string) => rows.find((a) => a.informationId === id);

it("recovers old schedules through their source chain without decoding the colliding alias", async () => {
  expect(scopeOf(first)).toBe(scopeOf(second));
  expect(sceneIdentity(first)).not.toBe(sceneIdentity(second));
  expect(await resolveObservationAddress(schedule, read)).toEqual(first);
  const modern = atom("schedule-b", schedule.kind, {
    input: { scopeKey: scopeOf(second), sceneAddress: second },
  });
  expect(await resolveObservationAddress(modern, read)).toEqual(second);
});

it("leaves ambiguous, inconsistent and orphaned legacy owners unassigned", async () => {
  const orphan = atom("orphan", schedule.kind, {
    input: { scopeKey: scopeOf(first) },
  });
  expect(await resolveObservationAddress(orphan, read)).toBeUndefined();
  const ambiguous = atom("ambiguous", schedule.kind, schedule.payload, [
    { relation: "core:caused-by", informationId: candidate.informationId },
    { relation: "core:status-of", informationId: inbound.informationId },
  ]);
  expect(await resolveObservationAddress(ambiguous, read)).toBeUndefined();
  const mismatched = atom(
    "mismatched",
    schedule.kind,
    { input: { scopeKey: "unrelated" } },
    [...schedule.references],
  );
  expect(await resolveObservationAddress(mismatched, read)).toBeUndefined();
});

function contains(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== "object") return actual === expected;
  return Boolean(
    actual &&
    typeof actual === "object" &&
    Object.entries(expected).every(([k, v]) =>
      contains((actual as Record<string, unknown>)[k], v),
    ),
  );
}
function ledgerFor(
  atoms: readonly DeepReadonly<InformationAtom>[],
): InformationSelectorLedger {
  return {
    find: async (query) => {
      let selected = atoms.filter(
        (a) =>
          (!query.informationIds ||
            query.informationIds.includes(a.informationId)) &&
          (!query.kinds || query.kinds.includes(a.kind)) &&
          (!query.payloadContains ||
            contains(a.payload, query.payloadContains)) &&
          (!query.scopeKey ||
            String(
              a.payload.scopeKey ??
                (a.payload.input as Record<string, unknown> | undefined)
                  ?.scopeKey ??
                (a.payload.source
                  ? scopeOf(a.payload.source as unknown as SceneAddress)
                  : ""),
            ) === query.scopeKey),
      );
      if (query.order === "desc") selected = [...selected].reverse();
      return selected.slice(0, query.limit);
    },
    related: async (query) =>
      atoms
        .filter((a) =>
          query.direction === "outgoing"
            ? atoms.some(
                (source) =>
                  query.from.includes(source.informationId) &&
                  source.references.some(
                    (r) =>
                      r.relation === query.relation &&
                      r.informationId === a.informationId,
                  ),
              )
            : a.references.some(
                (r) =>
                  r.relation === query.relation &&
                  query.from.includes(r.informationId),
              ),
        )
        .slice(0, query.limit),
    retrieve: async () => [],
  };
}

it("does not select the other scene candidate or legacy timer", async () => {
  const ledger = ledgerFor(rows);
  expect(
    await heartbeatScopeSelector.select({ sourceAtom: inbound, ledger }),
  ).toEqual([]);
  expect(
    await heartbeatObservationSelector.select({ sourceAtom: inbound, ledger }),
  ).toEqual([inbound.informationId]);
  expect(
    await heartbeatScopeSelector.select({ sourceAtom: candidate, ledger }),
  ).toEqual([schedule.informationId, outcome.informationId]);
});
