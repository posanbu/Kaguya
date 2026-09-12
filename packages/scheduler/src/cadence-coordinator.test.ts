/**
 * 功能概述：以可注入时钟与原子槽位测试替身验证 cadence 的并发、停机合并和生命周期。
 * makeCore 模拟 Core 的 registerOnce/commitTerminal 唯一赢家，fixture 保留账本并重建 coordinator；
 * 测试不等待真实时间，不调用 Memory 或在线回合，专门约束时间事实与维护 request 的分离。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CadenceCoordinator,
  cadenceTickInformationKind,
  type CadenceInformationCore,
  installProjectionReconciliationConsumers,
} from "./cadence.js";
function makeCore() {
  const atoms: any[] = [];
  const slots = new Map<string, any>();
  const handlers = new Map<
    string,
    (atom: any, signal: AbortSignal) => Promise<void> | void
  >();
  const commit = async (slot: string, definition: any, input: any) => {
    if (slots.has(slot)) return slots.get(slot);
    const atom = {
      ...input,
      kind: definition.kind,
      informationId: `atom-${atoms.length}`,
    };
    atoms.push(atom);
    slots.set(slot, atom);
    return atom;
  };
  const core: CadenceInformationCore = {
    registerOnce: (op, key, def, input) =>
      commit(`once:${op}:${key}`, def, input),
    commitTerminal: (op, key, def, input) =>
      commit(`terminal:${op}:${key}`, def, input),
    onDurable: (id, _def, handler) => {
      handlers.set(id, handler);
      return () => handlers.delete(id);
    },
    find: async (query) => {
      const selected = atoms.filter(
        (atom) =>
          (!query.kinds || query.kinds.includes(atom.kind)) &&
          (!query.payloadContains ||
            Object.entries(query.payloadContains).every(
              ([key, value]) => atom.payload[key] === value,
            )),
      );
      return (
        query.order === "desc" ? [...selected].reverse() : selected
      ).slice(0, query.limit);
    },
  };
  return {
    core,
    atoms,
    handlers,
    ticks: () =>
      atoms.filter((atom) => atom.kind === cadenceTickInformationKind.kind),
  };
}
const anchor = "2026-09-01T00:00:00.000Z";
const definition = {
  anchor,
  intervalMs: 1000,
  activationRevision: "v1",
  scopeKey: "projection",
};
afterEach(() => vi.useRealTimers());
describe("CadenceCoordinator durable lifecycle", () => {
  it("coalesces downtime once and keeps fixed boundaries across restart and concurrent runners", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(anchor));
    const f = makeCore();
    const create = () =>
      new CadenceCoordinator({ core: f.core, definitions: [definition] });
    const first = create();
    await first.start();
    await first.stop();
    vi.setSystemTime(new Date(Date.parse(anchor) + 100_250));
    const second = create(),
      third = create();
    await Promise.all([second.start(), third.start()]);
    expect(f.ticks()).toHaveLength(2);
    expect(f.ticks()[1].payload).toMatchObject({
      windowIndex: 100,
      missedCount: 100,
      asOf: "2026-09-01T00:01:40.000Z",
    });
    await Promise.all([second.stop(), third.stop()]);
  });
  it("does not let a tick race past durable disable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(anchor));
    const f = makeCore();
    const coordinator = new CadenceCoordinator({
      core: f.core,
      definitions: [definition],
    });
    await coordinator.start();
    vi.setSystemTime(new Date(Date.parse(anchor) + 1000));
    await Promise.all([
      coordinator.runOnce(),
      coordinator.disable(f.atoms[0].informationId),
    ]);
    const disabledIndex = f.atoms.findIndex(
      (atom) => atom.kind === "scheduler.cadence.disabled",
    );
    expect(
      f.atoms
        .slice(disabledIndex + 1)
        .filter((atom) => atom.kind === cadenceTickInformationKind.kind),
    ).toEqual([]);
    vi.setSystemTime(new Date(Date.parse(anchor) + 5000));
    await coordinator.runOnce();
    await coordinator.stop();
    expect(
      f.atoms
        .slice(disabledIndex + 1)
        .filter((atom) => atom.kind === cadenceTickInformationKind.kind),
    ).toEqual([]);
  });
  it("passes the frozen batch budget to the real maintenance consumer", async () => {
    const f = makeCore();
    const projectPendingBatch = vi.fn(async (_limit?: number) => ({
      processed: 2,
      failed: 0,
      pending: 2,
    }));
    installProjectionReconciliationConsumers(
      f.core,
      { projectPendingBatch },
      2,
    );
    await f.handlers.get("kaguya.maintenance.reconciliation.execute")!(
      {
        informationId: "request",
        payload: {
          tickInformationId: "tick",
          scopeKey: "projection",
          batchSize: 2,
        },
      },
      new AbortController().signal,
    );
    expect(projectPendingBatch).toHaveBeenCalledWith(2);
  });
});
