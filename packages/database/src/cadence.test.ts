/**
 * 功能概述：通过真实 Core 与持久唯一槽位检验 cadence 时间链，避免测试替身掩盖 SQL 查询限制。
 * 测试保留 PGlite 账本并重建 Core/coordinator，注入固定时钟检查合并补跑、并发停用与替换。
 * 只提交 scheduler 事实，不安装任何在线模块或真实计时器。
 */
import { randomUUID } from "node:crypto";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { CadenceCoordinator, cadenceInformationKinds } from "@kaguya/scheduler";
import { expect, it } from "vitest";
import { createTestingDatabase } from "./testing.js";
it("persists one cadence successor per boundary across restart and disable races", async () => {
  const database = await createTestingDatabase();
  await database.prepareSchema();
  const makeRegistry = () => {
    const registry = new InformationKindRegistry();
    for (const definition of cadenceInformationKinds)
      registry.register(definition);
    return registry;
  };
  let now = new Date("2026-09-01T00:00:00.000Z");
  const options = {
    store: database.information,
    nextInformationId: randomUUID,
    now: () => now,
  };
  let core = new InformationCore({ ...options, registry: makeRegistry() });
  await core.start();
  const definition = {
    anchor: now.toISOString(),
    intervalMs: 1000,
    activationRevision: "one",
    scopeKey: "projection",
  };
  const timers = {
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
  };
  const make = () =>
    new CadenceCoordinator({
      core,
      definitions: [definition],
      now: () => now,
      timers,
    });
  let coordinator = make();
  try {
    await coordinator.start();
    await coordinator.stop();
    await core.close();
    now = new Date("2026-09-01T00:01:40.900Z");
    core = new InformationCore({ ...options, registry: makeRegistry() });
    await core.start();
    coordinator = make();
    const contender = make();
    await Promise.all([coordinator.start(), contender.start()]);
    await contender.stop();
    const ticks = await database.information.find({
      kinds: ["scheduler.cadence.tick"],
      order: "asc",
      limit: 10,
    });
    expect(ticks).toHaveLength(2);
    expect(ticks[1]!.payload).toMatchObject({
      windowIndex: 100,
      missedCount: 100,
    });
    const id = String(ticks[0]!.payload.definitionInformationId);
    now = new Date("2026-09-01T00:01:41.000Z");
    await Promise.all([coordinator.runOnce(), coordinator.disable(id)]);
    const before = (
      await database.information.find({
        kinds: ["scheduler.cadence.tick"],
        limit: 10,
      })
    ).length;
    now = new Date("2026-09-01T01:00:00.000Z");
    await coordinator.runOnce();
    expect(
      await database.information.find({
        kinds: ["scheduler.cadence.tick"],
        limit: 10,
      }),
    ).toHaveLength(before);
  } finally {
    await coordinator.stop();
    await core.close();
    await database.close();
  }
});
