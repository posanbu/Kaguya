/**
 * 功能概述：以真实 Runtime/ModuleHost 和持久队列验证 observationCapability 的声明式接入与启动恢复。
 * ready 经测试自有 bootstrap 能力登记扫描请求，durable handler 冻结一页、registerOnce 结果并确认进度。
 * 代码库关系：只使用 SDK capability 与现有 Core 原语；不自动迁移 Heartflow 或 Memory，也不调用模型和平台。
 * 输入输出与副作用：测试故意停在结果提交与进度确认之间，再关闭重建 Runtime；PostgreSQL 额外关闭重连 pool。
 * 真实数据库与队列统一使用 8 秒有界状态轮询，整个用例 15 秒；finally 顺序关闭宿主与隔离数据库。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
} from "@kaguya/database/testing";
import {
  freezeInformationAtom,
  informationIdSchema,
  z,
  type SceneAddress,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationModuleCatalog,
  defineModuleCapability,
  observationCapability,
  onInformation,
} from "@kaguya/sdk";
import { KaguyaRuntime } from "./runtime.js";

const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const PERSISTENCE_WAIT = { timeout: 8000, interval: 20 } as const;
const sourceKind = defineInformationKind({
  kind: "test.observation.source",
  displayName: "观察来源",
  description: "合成场景来源。",
  payloadSchema: z
    .object({
      source: z
        .object({
          platform: z.string(),
          adapterId: z.string(),
          destination: z
            .object({ kind: z.literal("group"), groupId: z.string() })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  references: {},
  log: { enabled: false },
});
const wakeKind = defineInformationKind({
  kind: "test.observation.wake",
  displayName: "恢复检查",
  description: "启动时的持久检查请求。",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const resultKind = defineInformationKind({
  kind: "test.observation.completed",
  displayName: "观察完成",
  description: "绑定快照的合成完成事实。",
  payloadSchema: z.object({ observationId: z.string() }).strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [wakeKind.kind],
    },
    "core:uses-context": {
      required: true,
      multiple: true,
      targetKinds: [sourceKind.kind],
    },
  },
  log: { enabled: false },
});
const bootstrap = defineModuleCapability<{ request(): Promise<void> }>(
  "test:observation-bootstrap",
  1,
);
const address: SceneAddress = {
  platform: "qq",
  adapterId: "test",
  destination: { kind: "group", groupId: "g" },
};
const input = {
  consumerId: "test-reader",
  policyVersion: "v1",
  address,
  kinds: [sourceKind.kind],
  resultKind: resultKind.kind,
};

for (const postgres of [false, true]) {
  describe.skipIf(postgres && !url)(
    postgres ? "PostgreSQL observation Runtime" : "PGlite observation Runtime",
    () => {
      it("resumes the same frozen page and committed proof on startup without any new inbound event", async () => {
        const scope = postgres
          ? await createPostgresTestingDatabaseScope(url!)
          : undefined;
        let db = scope ? await scope.connect() : await createTestingDatabase();
        let runtime: KaguyaRuntime | undefined;
        const handlerErrors: unknown[] = [];
        try {
          await db.prepareSchema();
          await db.information.synchronizeKinds([
            sourceKind.kind,
            wakeKind.kind,
            resultKind.kind,
          ]);
          async function append(
            id: string,
            occurredAt = "2026-09-25T00:00:00.000Z",
          ) {
            await db.information.append(
              freezeInformationAtom({
                informationId: informationIdSchema.parse(id),
                kind: sourceKind.kind,
                source: "test:observation",
                occurredAt,
                payload: { source: { ...address } },
                references: [],
              }),
              [],
            );
          }
          await append("a");
          await append("b");
          function create(interruptAfterProof: boolean) {
            const consumer = defineInformationModule({
              manifest: {
                protocolVersion: 1,
                definitionId: "test.observation.consumer",
                moduleVersion: "1.0.0",
                displayName: "观察消费者",
                summary: "恢复测试",
                description: "以冻结页确认独立消费进度。",
                settingsSchema: z.object({}).strict(),
                consumes: [wakeKind],
                produces: [sourceKind, resultKind],
                selectors: [],
                promptRenderers: [],
                requires: [observationCapability, bootstrap],
                provides: [],
              },
              create: (_, context) => ({
                provisions: [],
                ready: () => context.use(bootstrap).request(),
                subscriptions: [
                  onInformation(
                    wakeKind,
                    { subscriptionId: "scan", delivery: "durable" },
                    async (_, handler) => {
                      try {
                        const observations = handler.use(observationCapability);
                        // 用例仅三条来源；逐页确认，重启时即使无新输入也从数据库检查未完成页。
                        while (!handler.signal.aborted) {
                          const page = await observations.freezeNext({
                            ...input,
                            limit: 2,
                          });
                          if (!page) return;
                          const proof = await handler.registerOnce(
                            "test.observation.observe",
                            page.observationId,
                            resultKind,
                            {
                              payload: { observationId: page.observationId },
                              references: page.sourceInformationIds.map(
                                (id) => ({
                                  relation: "core:uses-context",
                                  informationId: informationIdSchema.parse(id),
                                }),
                              ),
                            },
                          );
                          if (interruptAfterProof) return;
                          await observations.finish(
                            page.observationId,
                            proof.informationId,
                          );
                        }
                      } catch (error) {
                        handlerErrors.push(String(error));
                        throw error;
                      }
                    },
                  ),
                ],
              }),
            });
            return new KaguyaRuntime({
              database: db,
              catalog: defineInformationModuleCatalog(consumer),
              activations: [
                {
                  instanceId: "test.observation.default",
                  definitionId: consumer.manifest.definitionId,
                  settings: {},
                },
              ],
              capabilities: ({ core, now }) => [
                {
                  capability: bootstrap,
                  value: {
                    request: async () => {
                      await core.register(wakeKind, {
                        occurredAt: now().toISOString(),
                        source: "test:bootstrap",
                        payload: {},
                        references: [],
                      });
                    },
                  },
                },
              ],
            });
          }
          const results = () =>
            db.information.find({
              kinds: [resultKind.kind],
              registrationOrder: true,
              order: "asc",
              limit: 10,
            });
          async function settled(expected: number) {
            try {
              await vi.waitFor(async () => {
                expect(await results()).toHaveLength(expected);
                const health = await db.information.reliable.health();
                expect(health.pending, JSON.stringify(health)).toBe(0);
              }, PERSISTENCE_WAIT);
            } catch (cause) {
              const failures = await db.information.find({
                kinds: ["consumer.failed", "execution.exhausted"],
                limit: 10,
              });
              const deliveries = await db.sql.query(
                "SELECT subscription_id,state,attempts FROM information_deliveries",
              );
              const lifecycle = await db.sql.query(
                "SELECT information_id,kind,scope_key FROM information_lifecycle",
              );
              throw new Error(
                `Observation recovery did not settle: ${JSON.stringify({ handlerErrors, failures, deliveries: deliveries.rows, lifecycle: lifecycle.rows })}`,
                { cause },
              );
            }
          }
          runtime = create(true);
          await runtime.start();
          await settled(1);
          const firstProof = (await results())[0]!;
          const page = (await db.observations.freezeNext(input))!;
          expect(page.sourceInformationIds).toEqual(["a", "b"]);
          expect(page.status).toBe("frozen");
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
          await runtime.close();
          runtime = undefined;
          // 直接落账，发生时间更早，故没有活跃 Runtime 广播；恢复扫描仍应看到它。
          await append("c", "2025-01-01T00:00:00.000Z");
          if (scope) {
            await db.close();
            db = await scope.reconnect();
          }
          runtime = create(false);
          await runtime.start();
          await settled(2);
          expect((await results())[0]!.informationId).toBe(
            firstProof.informationId,
          );
          expect(
            (await db.observations.read(page.observationId))
              ?.resultInformationId,
          ).toBe(firstProof.informationId);
          const nextId = (await db.observations.progress(input))!
            .latestObservationId!;
          expect(
            (await db.observations.read(nextId))?.sourceInformationIds,
          ).toEqual(["c"]);
          expect(await db.observations.freezeNext(input)).toBeUndefined();
          const memoryInput = { ...input, consumerId: "memory" };
          expect(
            (await db.observations.freezeNext(memoryInput))
              ?.sourceInformationIds,
          ).toEqual(["a", "b", "c"]);
          expect(
            (await db.observations.progress(memoryInput))?.throughPosition,
          ).toBe("0");
          await runtime.close();
          runtime = undefined;
          if (scope) {
            await db.close();
            db = await scope.reconnect();
          }
          runtime = create(false);
          await runtime.start();
          await settled(2);
          expect(
            await db.information.find({
              kinds: ["execution.exhausted", "consumer.failed"],
              limit: 10,
            }),
          ).toEqual([]);
        } finally {
          try {
            await runtime?.close();
          } finally {
            if (scope) await scope.close();
            else await db.close();
          }
        }
      });
    },
  );
}
