/**
 * 功能概述：验证 Core 的幂等入口保留 kind/reference 校验并只广播新提交赢家。
 * 主要职责：以 PGlite 检查 registerOnce、跨 kind commitTerminal 和 claim 输出保护。
 * 代码库关系：使用生产 Core、Registry、Database；失败事务不能变成 live 事件。
 * 输入输出与副作用：测试创建隔离数据库，所有事实只写入该测试数据库。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createTestingDatabase } from "./testing.js";
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { InformationCore } from "@kaguya/engine";
import { InformationKindRegistry } from "@kaguya/engine";
const output = defineInformationKind({
  kind: "test.output",
  displayName: "Test Output",
  description: "Information carried by the test.output kind.",
  payloadSchema: z.object({ value: z.number() }).strict(),
  references: {},
  log: { enabled: false },
});
const failed = defineInformationKind({
  kind: "test.failed",
  displayName: "Test Failed",
  description: "Information carried by the test.failed kind.",
  payloadSchema: z.object({ value: z.number() }).strict(),
  references: {},
  log: { enabled: false },
});
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});
it("returns operation and terminal winners without duplicate live notifications", async () => {
  const db = await createTestingDatabase();
  resources.push(() => db.close());
  await db.prepareSchema();
  const registry = new InformationKindRegistry();
  registry.register(output);
  registry.register(failed);
  let id = 0;
  const core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: () => `atom-${++id}`,
  });
  await core.start();
  resources.push(() => core.close());
  const observed: string[] = [];
  core.on(output, { consumerId: "test.observer" }, (a) => {
    observed.push(a.informationId);
  });
  const input = {
    occurredAt: new Date().toISOString(),
    source: "module:test",
    payload: { value: 1 },
    references: [],
  };
  const [a, b] = await Promise.all([
    core.registerOnce("test.operation", "key", output, input),
    core.registerOnce("test.operation", "key", output, input),
  ]);
  expect(a.informationId).toBe(b.informationId);
  expect(observed).toEqual([a.informationId]);
  const done = await core.commitTerminal(
    "test.terminal",
    a.informationId,
    output,
    input,
  );
  const loser = await core.commitTerminal(
    "test.terminal",
    a.informationId,
    failed,
    input,
  );
  expect(loser).toEqual(done);
  expect(observed).toHaveLength(2);
  await expect(
    core.registerOnce("test.operation", "other", output, {
      ...input,
      payload: { value: "bad" as never },
    }),
  ).rejects.toThrow();
});

it("bounds close even when a committed durable output is stuck in a live observer", async () => {
  const db = await createTestingDatabase();
  resources.push(() => db.close());
  await db.prepareSchema();
  const registry = new InformationKindRegistry();
  registry.register(output);
  let id = 0;
  const core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: () => `close-${++id}`,
    drainTimeoutMs: 20,
  });
  await core.start();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  core.on(output, { consumerId: "test.observer" }, async () => {
    entered = true;
    await gate;
  });
  const write = core.registerOnce("test.close", "key", output, {
    occurredAt: new Date().toISOString(),
    source: "module:test",
    payload: { value: 1 },
    references: [],
  });
  await vi.waitFor(() => expect(entered).toBe(true));
  const closed = core.close();
  let stopped = false;
  void closed.then(() => {
    stopped = true;
  });
  try {
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 500 });
  } finally {
    release();
    await write;
    await closed;
  }
});
