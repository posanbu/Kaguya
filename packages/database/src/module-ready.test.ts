/**
 * 功能概述：以真实数据库可靠投递证明 ready 启动根请求在首次启用时不会漏投。
 * 主要职责：比较 start 与 ready 的持久执行意图；ready 抛错后通过停止 Promise 与 Core 关闭边界验证 Runner 已停止，后续事实保留为待恢复任务。
 * 代码库关系：使用正式 ModuleHost、InformationCore、ReliableInformationRepository 与 SDK ready 生命周期协议。
 * 输入输出与副作用：每例创建隔离 PGlite，按 Host、Core、数据库顺序关闭；不请求网络或模型。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationModuleCatalog,
  onInformation,
} from "@kaguya/sdk";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import { createTestingDatabase } from "./testing.js";

const source = defineInformationKind({
  kind: "test.ready.source",
  displayName: "Readiness source",
  description: "A root fact submitted during startup.",
  payloadSchema: z.object({ stage: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});
// 与当前 Planner/PGlite fixture 一致：等待真实投递完成，最多 8 秒，满足条件即返回。
const DURABLE_WAIT = { timeout: 8000, interval: 20 } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
});

async function setup(failReady = false) {
  const database = await createTestingDatabase();
  cleanups.push(() => database.close());
  await database.prepareSchema();
  const registry = new InformationKindRegistry();
  registry.register(source);
  let sequence = 0;
  const core = new InformationCore({
    registry,
    store: database.information,
    nextInformationId: () => `ready-${++sequence}`,
  });
  await core.start();
  cleanups.push(() => core.close());
  const received: string[] = [];
  const append = (stage: string) =>
    core.register(source, {
      payload: { stage },
      source: "test:ready",
      references: [],
      occurredAt: new Date().toISOString(),
    });
  const module = defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "test.ready.module",
      displayName: "Readiness test",
      summary: "Tests durable bootstrap.",
      description:
        "Consumes facts published after its reliable subscription is installed.",
      settingsSchema: z.object({}).strict(),
      consumes: [source],
      produces: [],
      selectors: [],
      promptRenderers: [],
      requires: [],
      provides: [],
    },
    create: () => ({
      provisions: [],
      subscriptions: [
        onInformation(
          source,
          { subscriptionId: "roots.v1", delivery: "durable" },
          (atom) => {
            received.push(atom.payload.stage);
          },
        ),
      ],
      start: async () => {
        await append("start");
      },
      ready: async () => {
        if (failReady) throw new Error("ready rejected");
        await append("ready");
      },
    }),
  });
  const host = new ModuleHost({
    core,
    catalog: defineInformationModuleCatalog(module),
  });
  cleanups.push(() => host.stop());
  const activate = () =>
    host.start([
      {
        instanceId: "ready.test",
        definitionId: module.manifest.definitionId,
        settings: {},
      },
    ]);
  return { database, core, host, append, received, activate };
}

describe("durable module readiness", () => {
  it("creates a first-enable delivery for ready roots while earlier start facts are not backfilled", async () => {
    const f = await setup();
    await f.activate();
    await vi.waitFor(async () => {
      expect(f.received).toEqual(["ready"]);
      expect((await f.database.information.reliable.health()).pending).toBe(0);
    }, DURABLE_WAIT);
    const deliveries = await f.database.sql.query<{ stage: string }>(
      "SELECT a.payload->>'stage' AS stage FROM information_deliveries d JOIN information_atoms a USING(information_id) ORDER BY stage",
    );
    expect(deliveries.rows).toEqual([{ stage: "ready" }]);
    expect(
      await f.database.information.find({ kinds: [source.kind], limit: 10 }),
    ).toHaveLength(2);
  });

  it("stops the reliable runner when ready fails and preserves subsequent work for recovery", async () => {
    const f = await setup(true);
    const stopped = vi.spyOn(f.core, "stopReliableDelivery");
    await expect(f.activate()).rejects.toThrow("ready rejected");
    expect(stopped).toHaveBeenCalled();
    await f.append("after-failure");
    // Host 的失败回滚已 await Runner.stop；显式等待停止 Promise，不靠休眠猜测是否漏停。
    await Promise.all(stopped.mock.results.map((result) => result.value));
    await f.core.close();
    expect(f.received).toEqual([]);
    expect((await f.database.information.reliable.health()).pending).toBe(1);
  });
});
