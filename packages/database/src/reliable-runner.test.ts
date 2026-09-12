/**
 * 功能概述：验证可靠执行器的持久恢复、输出后重投、耗尽和停止 fencing。
 * 主要职责：使用生产数据库，控制 handler 的失败/阻塞来覆盖真实执行窗口；
 * 校验默认 claim 的有效期覆盖 300 秒模型预算，避免延长模型超时后提前 fencing。
 * 代码库关系：Core 注入 Runner 所需原子与事务端口，测试不绕过幂等注册。
 * 输入输出与副作用：各例隔离 PGlite，停止 runner 后关闭数据库；忽略 abort 的 handler 也不能迟到写入。
 */
import { afterEach, expect, it, vi } from "vitest";
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import * as engine from "@kaguya/engine";
import { createTestingDatabase } from "./testing.js";
const source = defineInformationKind({
  kind: "test.source",
  displayName: "Test Source",
  description: "Information carried by the test.source kind.",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const output = defineInformationKind({
  kind: "test.output",
  displayName: "Test Output",
  description: "Information carried by the test.output kind.",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
async function setup() {
  const db = await createTestingDatabase();
  clean.push(() => db.close());
  await db.prepareSchema();
  const registry = new engine.InformationKindRegistry();
  registry.register(source);
  registry.register(output);
  let id = 0;
  const core = new engine.InformationCore({
    registry,
    store: db.information,
    nextInformationId: () => `runner-${++id}`,
  });
  await core.start();
  clean.push(() => core.close());
  return { db, core };
}
const input = () => ({
  occurredAt: new Date().toISOString(),
  source: "module:test",
  payload: {},
  references: [],
});
it("replays output-before-ack failure without duplicating output", async () => {
  expect(typeof engine.ReliableInformationRunner).toBe("function");
  const { core, db } = await setup();
  let calls = 0;
  const runner = new engine.ReliableInformationRunner({
    core,
    retryDelayMs: 0,
    pollIntervalMs: 5,
    subscriptions: [
      {
        subscriptionId: "test.consumer",
        kind: source.kind,
        handle: async (atom) => {
          await core.registerOnce(
            "test.output.v1",
            atom.informationId,
            output,
            input(),
          );
          if (++calls === 1) throw new Error("after commit");
        },
      },
    ],
  });
  clean.push(() => runner.stop());
  await runner.start();
  await core.register(source, input());
  await vi.waitFor(async () => {
    expect(calls).toBe(2);
    expect((await db.information.reliable.health()).pending).toBe(0);
  });
  expect(
    await db.information.find({ kinds: [output.kind], limit: 10 }),
  ).toHaveLength(1);
});
it("bounds poison retries and persists visible exhaustion", async () => {
  expect(typeof engine.ReliableInformationRunner).toBe("function");
  const { core, db } = await setup();
  let calls = 0;
  const runner = new engine.ReliableInformationRunner({
    core,
    maxAttempts: 2,
    retryDelayMs: 0,
    pollIntervalMs: 5,
    subscriptions: [
      {
        subscriptionId: "test.poison",
        kind: source.kind,
        handle: async () => {
          calls++;
          throw new Error("secret body");
        },
      },
    ],
  });
  clean.push(() => runner.stop());
  await runner.start();
  await core.register(source, input());
  await vi.waitFor(async () =>
    expect((await db.information.reliable.health()).exhausted).toBe(1),
  );
  expect(calls).toBe(2);
  const exhausted = await db.information.find({
    kinds: ["execution.exhausted"],
    limit: 10,
  });
  expect(exhausted).toHaveLength(1);
  expect(JSON.stringify(exhausted)).not.toContain("secret body");
});
it.each([false, true])(
  "stops boundedly and fences late output while a replacement resumes pending work (drain=%s)",
  async (drain) => {
    expect(typeof engine.ReliableInformationRunner).toBe("function");
    const { core, db } = await setup();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let lateRejected = false;
    const first = new engine.ReliableInformationRunner({
      core,
      pollIntervalMs: 5,
      drainTimeoutMs: 50,
      subscriptions: [
        {
          subscriptionId: "test.restart",
          kind: source.kind,
          handle: async (atom) => {
            entered = true;
            await gate;
            try {
              await core.registerOnce(
                "test.output.v1",
                atom.informationId,
                output,
                input(),
              );
            } catch {
              lateRejected = true;
            }
          },
        },
      ],
    });
    await first.start();
    await core.register(source, input());
    await vi.waitFor(() => expect(entered).toBe(true));
    await first.stop({ drain });
    release();
    await vi.waitFor(() => expect(lateRejected).toBe(true));
    const second = new engine.ReliableInformationRunner({
      core,
      pollIntervalMs: 5,
      subscriptions: [
        {
          subscriptionId: "test.restart",
          kind: source.kind,
          handle: async (atom) => {
            await core.registerOnce(
              "test.output.v1",
              atom.informationId,
              output,
              input(),
            );
          },
        },
      ],
    });
    clean.push(() => second.stop());
    await second.start();
    await vi.waitFor(async () =>
      expect((await db.information.reliable.health()).pending).toBe(0),
    );
    expect(
      await db.information.find({ kinds: [output.kind], limit: 10 }),
    ).toHaveLength(1);
  },
);

it("exhausts handlers that ignore lease abort without running forever", async () => {
  const { core, db } = await setup();
  let calls = 0;
  const runner = new engine.ReliableInformationRunner({
    core,
    leaseMs: 30,
    maxAttempts: 2,
    pollIntervalMs: 5,
    subscriptions: [
      {
        subscriptionId: "test.expiry",
        kind: source.kind,
        handle: async () => {
          calls++;
          await new Promise<void>(() => {});
        },
      },
    ],
  });
  clean.push(() => runner.stop());
  await runner.start();
  await core.register(source, input());
  await vi.waitFor(
    async () =>
      expect((await db.information.reliable.health()).exhausted).toBe(1),
    { timeout: 3000 },
  );
  expect(calls).toBe(2);
});

it("propagates shutdown into a pending exhaustion commit", async () => {
  const { core, db } = await setup();
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const exhaust = core.exhaustClaim.bind(core);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(core, "exhaustClaim").mockImplementation(async (claim) => {
    entered = true;
    await gate;
    try {
      return await exhaust(claim);
    } finally {
      finish();
    }
  });
  const runner = new engine.ReliableInformationRunner({
    core,
    maxAttempts: 1,
    pollIntervalMs: 5,
    drainTimeoutMs: 20,
    subscriptions: [
      {
        subscriptionId: "test.exhaustabort",
        kind: source.kind,
        handle: async () => {
          throw new Error("poison");
        },
      },
    ],
  });
  await runner.start();
  await core.register(source, input());
  await vi.waitFor(() => expect(entered).toBe(true));
  await runner.stop();
  release();
  await finished;
  expect((await db.information.reliable.health()).exhausted).toBe(0);
  expect(
    await db.information.find({ kinds: ["execution.exhausted"], limit: 10 }),
  ).toHaveLength(0);
});

it("gives the default claim enough time for a 300 second model call and commit", async () => {
  const { core, db } = await setup();
  const claim = vi.spyOn(db.information.reliable, "claim");
  let called = false;
  const runner = new engine.ReliableInformationRunner({
    core,
    subscriptions: [
      {
        subscriptionId: "test.timeout-budget",
        kind: source.kind,
        handle: () => {
          called = true;
        },
      },
    ],
  });
  clean.push(() => runner.stop());
  await runner.start();
  await core.register(source, input());
  await vi.waitFor(() => expect(called).toBe(true));
  expect(claim).toHaveBeenCalledWith("test.timeout-budget", 330_000);
});

it("lets an active handler commit during graceful drain without claiming another input", async () => {
  const { core, db } = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handler = vi.fn(async (atom: { informationId: string }) => {
    entered.resolve();
    await release.promise;
    await core.registerOnce(
      "test.drain.output",
      atom.informationId,
      output,
      input(),
    );
  });
  const runner = new engine.ReliableInformationRunner({
    core,
    pollIntervalMs: 5,
    drainTimeoutMs: 1000,
    subscriptions: [
      { subscriptionId: "test.drain", kind: source.kind, handle: handler },
    ],
  });
  clean.push(() => runner.stop());
  await runner.start();
  await core.register(source, input());
  await entered.promise;
  const stopping = runner.stop({ drain: true });
  await core.register(source, input());
  release.resolve();
  await stopping;
  expect(handler).toHaveBeenCalledTimes(1);
  expect(
    await db.information.find({ kinds: [output.kind], limit: 10 }),
  ).toHaveLength(1);
  expect((await db.information.reliable.health()).pending).toBe(1);
});
