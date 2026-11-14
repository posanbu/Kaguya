import { describe, expect, it, vi } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import { KaguyaRuntime } from "@kaguya/runtime";
import {
  createDeterministicModel,
  createRepeatingDeterministicModel,
  createNativeDeterministicModel,
  createNativeScriptedModel,
} from "@kaguya/llm/testing";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { z } from "@kaguya/schema";
import { nativeToolWireName } from "@kaguya/runtime";
import { createMessageComposition } from "./index.js";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InformationCore } from "@kaguya/engine";

const pg = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !pg)
  throw new Error("PostgreSQL test URL required");
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(pg
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(pg) }]
    : []),
];

describe.each(backends)(
  "continuous production composition $name",
  ({ create }) => {
    it("records acceptance before replying, links actual delivery and requires feedback from the original requester", async () => {
      // 共用原 15 秒整例上限，为关闭预留 1 秒，避免阶段上限先于整例到期。
      const deadline = performance.now() + 14_000;
      const waitForCheckpoint = (check: () => void | Promise<void>) =>
        vi.waitFor(check, {
          timeout: Math.max(1, deadline - performance.now()),
        });
      const db = await create();
      const conversationId = randomUUID();
      const scope = JSON.stringify(["web", "web.test", "web", conversationId]);
      let reply = 0;
      const failures: string[] = [];
      const originalFailure = InformationCore.prototype.recordReliableFailure;
      const failureSpy = vi
        .spyOn(InformationCore.prototype, "recordReliableFailure")
        .mockImplementation(function (this: InformationCore, claim, error) {
          failures.push(String(error));
          return originalFailure.call(this, claim, error);
        });
      const heavy = createNativeScriptedModel(async () => {
        const inbound = (
          await db.information.find({
            kinds: ["core.message.inbound.text"],
            registrationOrder: true,
            order: "desc",
            limit: 1,
          })
        )[0]!;
        const activity = (await db.continuity.read("kaguya", scope))
          ?.activities[0];
        const kind = ["accept", "deliver", "feedback"][reply++]!;
        return {
          text: JSON.stringify({
            action: "message",
            text:
              kind === "accept"
                ? "好，我稍后把笔记分享给你。"
                : kind === "deliver"
                  ? "这是约好的笔记：月球表面有环形山。"
                  : "收到，你确认的是这份笔记。",
            continuity: {
              kind,
              activityId: activity?.id ?? null,
              requestId: kind === "deliver" ? null : inbound.informationId,
              title: "分享月球笔记",
              goal: "给请求者分享阅读笔记",
              nextStep: "发送笔记正文",
              dueAt: null,
              outcome: kind === "feedback" ? "fulfilled" : null,
            },
          }),
        };
      });
      const light = createRepeatingDeterministicModel({
        action: "message",
        reason: "respond",
      });
      // 此例验证消息与履约，周期检查由 Lifecycle 的专门测试覆盖。
      const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
        (c) => ({
          ...c,
          enabled:
            c.definitionId === "agent.continuity" ||
            c.definitionId === "memory.native" ||
            c.enabled,
          settings:
            c.definitionId === "agent.continuity"
              ? { autonomous: false }
              : c.definitionId === "agent.lifecycle"
                ? { ...c.settings, pulse: { intervalMs: 60_000 } }
                : c.settings,
        }),
      );
      const runtime = new KaguyaRuntime({
        database: db,
        ...createMessageComposition(
          ({ modelTier }) => ({
            providerId: "test",
            modelId: modelTier,
            model: modelTier === "light" ? light : heavy,
          }),
          { moduleConfigs, memoryEnabled: true },
        ),
      });
      let sent = 0;
      runtime.registerTransport({
        adapterId: "web.test",
        platform: "web",
        transport: {
          sendMessage: async (target) => ({
            ok: true,
            adapterId: "web.test",
            platform: "web",
            target,
            platformMessageId: `delivered-${++sent}`,
          }),
        },
      });
      const send = async (text: string, count: number) => {
        await runtime.submit({
          platform: "web",
          adapterId: "web.test",
          platformMessageId: randomUUID(),
          occurredAt: new Date().toISOString(),
          text,
          mentions: [],
          target: { kind: "web", conversationId },
          sender: { userId: "requester" },
          raw: {},
        });
        try {
          await waitForCheckpoint(() => expect(sent).toBe(count));
        } catch {
          const facts = await db.information.find({
            occurredAfter: "2020-01-01T00:00:00Z",
            registrationOrder: true,
            order: "asc",
            limit: 1000,
          });
          throw new Error(
            JSON.stringify({
              failures,
              facts: facts.map((a) => ({
                kind: a.kind,
                task: a.payload.taskId,
                status: a.payload.status,
                reason: a.payload.reason,
                stage: (a.payload.error as any)?.stage,
              })),
            }),
          );
        }
      };
      try {
        await runtime.start();
        await send("稍后给我分享月球笔记", 1);
        let a = (await db.continuity.read("kaguya", scope))!.activities[0]!;
        expect(a).toMatchObject({
          kind: "commitment",
          fulfillment: "pending",
          deliveryIds: [],
          feedbackIds: [],
        });
        expect(a.acceptedBy).toBeTruthy();
        expect(a.acceptedFrom).toBeTruthy();
        await send("现在可以发给我了", 2);
        await waitForCheckpoint(async () =>
          expect(
            (await db.continuity.read("kaguya", scope))?.activities[0]
              ?.deliveryIds,
          ).toHaveLength(1),
        );
        a = (await db.continuity.read("kaguya", scope))!.activities[0]!;
        expect(a.fulfillment).toBe("pending");
        await send("这份笔记就是约好的内容，已收到并确认", 3);
        await waitForCheckpoint(async () =>
          expect(
            (await db.continuity.read("kaguya", scope))?.activities[0]
              ?.fulfillment,
          ).toBe("fulfilled"),
        );
        expect((await db.continuity.read("kaguya", scope))?.budget.used).toBe(
          0,
        );
        expect(
          (await db.continuity.read("kaguya", "private:other"))?.activities,
        ).toEqual([]);
        expect(
          await db.information.find({ kinds: ["consumer.failed"], limit: 10 }),
        ).toEqual([]);
      } finally {
        await runtime.close();
        await db.close();
        failureSpy.mockRestore();
      }
    });
    it.each([true, false])(
      "requires actual source, saved note and read-back proof (source reported: %s)",
      async (hasSource) => {
        const db = await create();
        const dir = await mkdtemp(join(tmpdir(), "kaguya-continuity-"));
        const scope =
          '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]';
        const light = createDeterministicModel([
          { subjective: null, reason: "无变化" },
          {
            action: "create",
            activityId: null,
            title: "月球阅读",
            goal: "读取资料并保存笔记",
            nextStep: "读资料",
            reason: "对月球好奇",
            checkAfterMs: 3600000,
          },
        ]);
        let runId = "";
        const effects: string[] = [];
        await writeFile(join(dir, "source.txt"), "月球表面有环形山。", "utf8");
        const heavy = createNativeScriptedModel(async (_request, index) => {
          if (index < 3)
            return {
              calls: [
                {
                  id: `step-${index}`,
                  name: nativeToolWireName("test.workspace", "1"),
                  input: JSON.stringify({
                    mode: ["read", "write", "verify"][index],
                  }),
                },
              ],
            };
          const receipts = await db.continuity.receipts("kaguya", scope, runId);
          return {
            text: JSON.stringify({
              status: "complete",
              summary: "已读取资料并保存、回读笔记",
              nextStep: "可继续阅读",
              completedSteps: ["读取原始资料", "保存笔记", "回读指纹一致"],
              checkAfterMs: 3600000,
              resources: receipts
                .filter((r) => hasSource || r.intent.arguments.mode !== "read")
                .map((r) => ({
                  receiptId: r.receiptId,
                  artifactId: r.outcome.artifacts[0]!.id,
                  role:
                    r.intent.arguments.mode === "read"
                      ? "source"
                      : r.intent.arguments.mode === "write"
                        ? "note"
                        : "verification",
                  verifies:
                    r.intent.arguments.mode === "verify"
                      ? "artifact:write"
                      : null,
                })),
            }),
          };
        });
        const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
          (c) => ({
            ...c,
            enabled: ["memory.native", "agent.continuity"].includes(
              c.definitionId,
            ),
            settings:
              c.definitionId === "agent.continuity"
                ? { autonomous: true }
                : c.settings,
          }),
        );
        const runtime = new KaguyaRuntime({
          database: db,
          ...createMessageComposition(
            ({ modelTier }) => ({
              providerId: "test",
              modelId: modelTier,
              model: modelTier === "light" ? light : heavy,
              configuration: {
                adapter: "deterministic",
                protocol: "local",
                endpoint: "local",
                revision: "1",
              },
            }),
            { moduleConfigs, memoryEnabled: true },
          ),
          actionProviders: [
            {
              id: "test",
              version: "1",
              capabilities: {
                cancellation: "none",
                idempotency: "operation",
                reconciliation: false,
                successEvidence: "effect-verified",
                fencing: "none",
              },
              execute: async ({ intent, intentId }) => {
                runId = intent.runInformationId;
                const mode = String(intent.arguments.mode);
                effects.push(mode);
                if (mode === "write")
                  await writeFile(
                    join(dir, "note.md"),
                    "资料笔记：月球表面有环形山。来源：source.txt",
                    "utf8",
                  );
                const content = await readFile(
                  join(dir, mode === "read" ? "source.txt" : "note.md"),
                );
                return {
                  status: "succeeded",
                  evidence: "effect-verified",
                  result: { content: content.toString("utf8") },
                  artifacts: [
                    {
                      id: `artifact:${mode}`,
                      hash: createHash("sha256").update(content).digest("hex"),
                      mime: "text/plain",
                      size: content.length,
                      scope,
                      actionId: intentId,
                      observedAt: new Date().toISOString(),
                      source:
                        mode === "read"
                          ? "https://public.example.invalid/moon"
                          : "workspace:note.md",
                      retention: "test",
                    },
                  ],
                  truncated: false,
                };
              },
            },
          ],
          nativeTools: {
            registrations: [
              {
                id: "test.workspace",
                version: "1",
                description: "隔离文件工作区",
                providerId: "test",
                providerVersion: "1",
                executor: "test",
                readonly: false,
                independent: false,
                policyVersion: "1",
                inputSchema: z
                  .object({ mode: z.enum(["read", "write", "verify"]) })
                  .strict(),
                bind: async () => ({ target: {} }),
                authorize: async () => true,
              },
            ],
            tasks: [
              {
                definitionId: "agent.continuity",
                taskId: "agent.continuity.execute",
                toolIds: ["test.workspace"],
              },
            ],
          },
        });
        try {
          await runtime.start();
          await vi.waitFor(
            async () =>
              expect(
                await db.information.find({
                  kinds: ["agent.continuity.cycle.v1"],
                  limit: 10,
                }),
              ).toHaveLength(1),
            { timeout: 8000 },
          );
          expect(
            (
              await db.information.find({
                kinds: ["agent.continuity.cycle.v1"],
                limit: 10,
              })
            )[0]?.payload,
          ).toMatchObject({ status: hasSource ? "completed" : "waiting" });
          expect(effects).toEqual(["read", "write", "verify"]);
          const view = (await db.continuity.read("kaguya", scope))!;
          expect(view.activities[0]).toMatchObject({
            state: hasSource ? "completed" : "waiting",
            externalResult: hasSource ? "verified" : "unknown",
            inFlight: null,
            fulfillment: "unknown",
          });
          expect(view.budget.used).toBe(6);
          const note = view.resources.find((r) => r.role === "note")!,
            verified = view.resources.find((r) => r.role === "verification")!;
          expect(verified).toMatchObject({
            verifies: note.id,
            contentHash: note.contentHash,
          });
          expect(verified.actionReceiptId).not.toBe(note.actionReceiptId);
          await vi.waitFor(async () =>
            expect(
              (
                await db.memoryGraph.native.forFormation({
                  scope,
                  owners: ["self:kaguya"],
                  asOf: new Date().toISOString(),
                  query: "",
                })
              ).some(
                (n) =>
                  n.metadata.kind === "experience" &&
                  n.metadata.sourceIds.length > 0,
              ),
            ).toBe(true),
          );
          expect(
            await db.information.find({
              kinds: ["consumer.failed"],
              limit: 10,
            }),
          ).toEqual([]);
        } finally {
          await runtime.close();
          await db.close();
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
    it("re-evaluates a corrected preference, rebases the pending plan and preserves its previous version", async () => {
      const db = await create();
      const scope =
        '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]';
      const light = createNativeScriptedModel(async () => {
        const request = (
          await db.information.find({
            kinds: ["core.model.task.requested"],
            registrationOrder: true,
            order: "desc",
            limit: 1,
          })
        )[0]!;
        if (request.payload.taskId === "agent.continuity.appraise")
          return {
            text: JSON.stringify({
              subjective: null,
              reason: "依据更正，状态不变",
              feedback: [],
            }),
          };
        const a = (await db.continuity.read("kaguya", scope))?.activities[0];
        return {
          text: JSON.stringify({
            action: a ? "continue" : "create",
            activityId: a?.id ?? null,
            title: "选择公开资料",
            goal: a ? "按更正的偏好阅读建筑资料" : "按原偏好阅读月球资料",
            nextStep: a ? "选择建筑资料" : "选择月球资料",
            reason: a ? "已核对当前 Memory 的偏好更正" : "按当前兴趣选择",
            checkAfterMs: 86400000,
          }),
        };
      });
      const heavy = createNativeScriptedModel(async () => ({
        text: JSON.stringify({
          status: "waiting",
          summary: "计划已保存，尚未读取资料",
          nextStep: "等环境就绪再读取",
          completedSteps: [],
          resources: [],
          checkAfterMs: 86400000,
        }),
      }));
      const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
        (c) => ({
          ...c,
          enabled: ["memory.native", "agent.continuity"].includes(
            c.definitionId,
          ),
          settings:
            c.definitionId === "agent.continuity"
              ? { autonomous: true }
              : c.settings,
        }),
      );
      const runtime = new KaguyaRuntime({
        database: db,
        ...createMessageComposition(
          ({ modelTier }) => ({
            providerId: "test",
            modelId: modelTier,
            model: modelTier === "light" ? light : heavy,
            configuration: {
              adapter: "deterministic",
              protocol: "local",
              endpoint: "local",
              revision: "1",
            },
          }),
          { moduleConfigs, memoryEnabled: true },
        ),
        nativeTools: {
          registrations: [
            {
              id: "test.unused",
              version: "1",
              description: "本例不调用环境",
              providerId: "test",
              providerVersion: "1",
              executor: "test",
              policyVersion: "1",
              readonly: true,
              independent: true,
              inputSchema: z.object({}).strict(),
              bind: async () => ({ target: {} }),
              authorize: async () => true,
            },
          ],
          tasks: [
            {
              definitionId: "agent.continuity",
              taskId: "agent.continuity.execute",
              toolIds: ["test.unused"],
            },
          ],
        },
      });
      try {
        await runtime.start();
        await vi.waitFor(
          async () =>
            expect(
              (
                await db.information.find({
                  kinds: ["agent.continuity.cycle.v1"],
                  limit: 10,
                })
              ).length,
            ).toBe(1),
          { timeout: 8000 },
        );
        const original = (await db.continuity.read("kaguya", scope))!
          .activities[0]!;
        const seed = (
          await db.memoryGraph.native.readFixed({
            scope: "shared",
            owners: ["self:kaguya"],
            asOf: new Date().toISOString(),
            query: "",
          })
        ).find((n) => n.metadata.tags.includes("persona-seed"))!;
        await db.memoryGraph.native.publish({
          operationId: "explicit-preference-correction",
          actor: "manual",
          nodes: [
            {
              expectedRevision: seed.metadata.revision,
              node: {
                ...seed,
                content: "兴趣偏好已更正：现在希望阅读建筑资料。",
                metadata: {
                  ...seed.metadata,
                  revision: seed.metadata.revision + 1,
                  locked: true,
                },
              },
            },
          ],
          edges: [],
        });
        await vi.waitFor(
          async () =>
            expect(
              (await db.continuity.read("kaguya", scope))?.activities[0],
            ).toMatchObject({
              goal: "按更正的偏好阅读建筑资料",
              reevaluationRequired: false,
              state: "waiting",
            }),
          { timeout: 8000 },
        );
        const revised = (await db.continuity.read("kaguya", scope))!
          .activities[0]!;
        expect(revised.memoryDependencies).toContainEqual({
          id: seed.id,
          revision: seed.metadata.revision + 1,
        });
        expect(
          (
            await db.information.find({
              informationIds: [original.informationId],
              limit: 1,
            })
          )[0]?.payload.activity,
        ).toMatchObject({ goal: "按原偏好阅读月球资料" });
        expect(
          await db.information.find({ kinds: ["consumer.failed"], limit: 10 }),
        ).toEqual([]);
      } finally {
        await runtime.close();
        await db.close();
      }
    });
    it("reconciles the original unknown write after restart without submitting it again", async () => {
      const db = await create();
      const scope =
        '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]';
      let writes = 0,
        reconciliations = 0,
        phase = 0;
      const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
        (c) => ({
          ...c,
          enabled: ["memory.native", "agent.continuity"].includes(
            c.definitionId,
          ),
          settings:
            c.definitionId === "agent.continuity"
              ? { autonomous: true }
              : c.settings,
        }),
      );
      const start = async () => {
        const light = createDeterministicModel([
          { subjective: null, reason: "不变" },
          phase === 0
            ? {
                action: "create",
                activityId: null,
                title: "核对写入",
                goal: "保存笔记，未知时核对原操作",
                nextStep: "写入一次",
                reason: "测试保存点",
                checkAfterMs: 86400000,
              }
            : {
                action: "continue",
                activityId: (await db.continuity.read("kaguya", scope))!
                  .activities[0]!.id,
                title: "",
                goal: "",
                nextStep: "核对原回执",
                reason: "从保存点继续",
                checkAfterMs: 86400000,
              },
        ]);
        const heavy = createNativeScriptedModel(async (_input, index) => {
          if (index === 0 && phase === 0)
            return {
              calls: [
                {
                  id: "write-once",
                  name: nativeToolWireName("test.uncertain", "1"),
                  input: "{}",
                },
              ],
            };
          if (index === 0) {
            const view = (await db.continuity.read("kaguya", scope))!;
            return {
              calls: [
                {
                  id: "check-original",
                  name: nativeToolWireName("activity.reconcile", "1"),
                  input: JSON.stringify({
                    activityId: view.activities[0]!.id,
                    receiptId: view.executionOutcomes.find(
                      (r) => r.toolName === "test.uncertain",
                    )!.receiptId,
                  }),
                },
              ],
            };
          }
          const recovered =
            phase === 1
              ? (
                  await db.information.find({
                    kinds: ["core.action.reconciled.v1"],
                    registrationOrder: true,
                    order: "desc",
                    limit: 1,
                  })
                )[0]
              : undefined;
          return {
            text: JSON.stringify({
              status: "waiting",
              summary: "只核对原写入",
              nextStep: "等待进一步资料",
              completedSteps: ["查询原操作"],
              resources: recovered
                ? [
                    {
                      receiptId: recovered.informationId,
                      artifactId: "recovered-note",
                      role: "note",
                      verifies: null,
                    },
                  ]
                : [],
              checkAfterMs: 86400000,
            }),
          };
        });
        const runtime = new KaguyaRuntime({
          database: db,
          ...createMessageComposition(
            ({ modelTier }) => ({
              providerId: "test",
              modelId: modelTier,
              model: modelTier === "light" ? light : heavy,
              configuration: {
                adapter: "deterministic",
                protocol: "local",
                endpoint: "local",
                revision: "1",
              },
            }),
            { moduleConfigs, memoryEnabled: true },
          ),
          nativeTools: {
            registrations: [
              {
                id: "test.uncertain",
                version: "1",
                description: "保存笔记，结果可能未知",
                providerId: "test.uncertain",
                providerVersion: "1",
                executor: "test",
                policyVersion: "1",
                readonly: false,
                independent: false,
                inputSchema: z.object({}).strict(),
                bind: async () => ({ target: {} }),
                authorize: async () => true,
              },
            ],
            tasks: [
              {
                definitionId: "agent.continuity",
                taskId: "agent.continuity.execute",
                toolIds: ["test.uncertain"],
              },
            ],
          },
          actionProviders: [
            {
              id: "test.uncertain",
              version: "1",
              capabilities: {
                cancellation: "none",
                idempotency: "operation",
                reconciliation: true,
                successEvidence: "effect-verified",
                fencing: "none",
              },
              execute: async () => {
                writes++;
                return {
                  status: "unknown",
                  evidence: "unconfirmed",
                  result: { original: "write-once" },
                  artifacts: [],
                  truncated: false,
                };
              },
              reconcile: async ({ intentId }) => {
                reconciliations++;
                return {
                  status: "succeeded",
                  evidence: "effect-verified",
                  result: { original: "write-once", exists: true },
                  artifacts: [
                    {
                      id: "recovered-note",
                      hash: createHash("sha256").update("note").digest("hex"),
                      mime: "text/plain",
                      size: 4,
                      scope,
                      actionId: intentId,
                      observedAt: new Date().toISOString(),
                      source: "workspace:note.md",
                      retention: "test",
                    },
                  ],
                  truncated: false,
                };
              },
            },
          ],
        });
        await runtime.start();
        return runtime;
      };
      let runtime: KaguyaRuntime | undefined;
      try {
        runtime = await start();
        await vi.waitFor(
          async () =>
            expect(
              await db.continuity.unresolvedEffects(
                "kaguya",
                (await db.continuity.read("kaguya", scope))!.activities[0]!.id,
              ),
            ).toBe(true),
          { timeout: 8000 },
        );
        await vi.waitFor(
          async () =>
            expect(
              (
                await db.information.find({
                  kinds: ["agent.continuity.cycle.v1"],
                  limit: 10,
                })
              ).length,
            ).toBe(1),
          { timeout: 8000 },
        );
        await runtime.close();
        phase = 1;
        runtime = await start();
        try {
          await vi.waitFor(() => expect(reconciliations).toBe(1), {
            timeout: 8000,
          });
        } catch {
          throw new Error(
            JSON.stringify({
              view: await db.continuity.read("kaguya", scope),
              facts: (
                await db.information.find({
                  kinds: [
                    "core.action.result.v1",
                    "core.action.reconciled.v1",
                    "agent.continuity.cycle.v1",
                    "core.model.task.failed",
                    "core.native.tool.result.v1",
                  ],
                  registrationOrder: true,
                  order: "asc",
                  limit: 100,
                })
              ).map((a) => ({ kind: a.kind, payload: a.payload })),
            }),
          );
        }
        const activity = (await db.continuity.read("kaguya", scope))!
          .activities[0]!;
        await vi.waitFor(
          async () =>
            expect(
              await db.continuity.unresolvedEffects("kaguya", activity.id),
            ).toBe(false),
          { timeout: 8000 },
        );
        await vi.waitFor(
          async () =>
            expect(
              (await db.continuity.read("kaguya", scope))?.resources,
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "note",
                  artifactId: "recovered-note",
                }),
              ]),
            ),
          { timeout: 8000 },
        );
        expect(writes).toBe(1);
      } finally {
        await runtime?.close();
        await db.close();
      }
    });
    it.each([false, true])(
      "refuses unverified completion and fenced resource evidence (fenced: %s)",
      async (fenced) => {
        const db = await create();
        const light = createDeterministicModel([
          { subjective: null, reason: "无变化" },
          {
            action: "create",
            activityId: null,
            title: "月球阅读",
            goal: "读取公开资料并保存笔记",
            nextStep: "读取资料",
            reason: "对月球好奇",
            checkAfterMs: 3600000,
          },
        ]);
        let effects = 0;
        const heavy = createNativeDeterministicModel([
          {
            calls: [
              {
                id: "read-1",
                name: nativeToolWireName("test.read", "1"),
                input: "{}",
              },
            ],
          },
          {
            text: JSON.stringify({
              status: "complete",
              summary: "模型声称完成",
              nextStep: "核对笔记",
              completedSteps: [],
              resources: [],
              checkAfterMs: 3600000,
            }),
          },
        ]);
        const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
          (c) => ({
            ...c,
            enabled: ["memory.native", "agent.continuity"].includes(
              c.definitionId,
            ),
            settings:
              c.definitionId === "agent.continuity"
                ? { autonomous: true }
                : c.settings,
          }),
        );
        const runtime = new KaguyaRuntime({
          database: db,
          ...createMessageComposition(
            ({ modelTier }) => ({
              providerId: "test",
              modelId: modelTier,
              model: modelTier === "light" ? light : heavy,
              configuration: {
                adapter: "deterministic",
                protocol: "local",
                endpoint: "local",
                revision: "1",
              },
            }),
            { moduleConfigs, memoryEnabled: true },
          ),
          ...(fenced
            ? {
                actionEnvironment: {
                  resolveLeaseCredential: async () => ({
                    token: "test-only-placeholder",
                  }),
                  validateEnvironment: async (_execution, mode) =>
                    mode !== "result",
                },
              }
            : {}),
          actionProviders: [
            {
              id: "test",
              version: "1",
              capabilities: {
                cancellation: "none",
                idempotency: "operation",
                reconciliation: false,
                successEvidence: "returned",
                fencing: fenced ? "environment" : "none",
              },
              execute: async ({ intent, intentId }) => {
                effects++;
                return {
                  status: "succeeded",
                  evidence: "returned",
                  result: { text: "公开资料内容" },
                  artifacts: fenced
                    ? [
                        {
                          id: "fenced-artifact",
                          hash: "a".repeat(64),
                          mime: "text/plain",
                          size: 4,
                          scope: intent.scope,
                          actionId: intentId,
                          generation: 1,
                          observedAt: new Date().toISOString(),
                          source: "workspace:note.md",
                          retention: "test",
                        },
                      ]
                    : [],
                  truncated: false,
                };
              },
            },
          ],
          nativeTools: {
            registrations: [
              {
                id: "test.read",
                version: "1",
                description: "读取测试资料",
                providerId: "test",
                providerVersion: "1",
                executor: "test",
                readonly: true,
                independent: false,
                policyVersion: "1",
                inputSchema: z.object({}).strict(),
                bind: async () => ({
                  target: {},
                  ...(fenced
                    ? {
                        environment: {
                          environmentId: "test",
                          generation: 1,
                          workspaceId: "workspace",
                          resourceIds: [],
                          workflowId: "reading",
                          leaseId: "lease",
                          fencing: "1",
                          expiresAt: new Date(
                            Date.now() + 300000,
                          ).toISOString(),
                        },
                      }
                    : {}),
                }),
                authorize: async () => true,
              },
            ],
            tasks: [
              {
                definitionId: "agent.continuity",
                taskId: "agent.continuity.execute",
                toolIds: ["test.read"],
              },
            ],
          },
        });
        try {
          await runtime.start();
          await vi.waitFor(
            async () =>
              expect(
                await db.information.find({
                  kinds: ["agent.continuity.cycle.v1"],
                  limit: 10,
                }),
              ).toHaveLength(1),
            { timeout: 8000 },
          );
          const cycle = (
            await db.information.find({
              kinds: ["agent.continuity.cycle.v1"],
              limit: 10,
            })
          )[0]!;
          expect(cycle.payload).toMatchObject({
            status: "waiting",
            reason: fenced ? "execution-failed" : "模型声称完成",
          });
          expect(
            (
              await db.information.find({
                kinds: ["agent.heavy.tool.result.v1"],
                limit: 10,
              })
            ).map((a) => a.payload.value),
          ).toEqual([expect.objectContaining({ status: "succeeded" })]);
          expect(effects).toBe(1);
          const view = await db.continuity.read(
            "kaguya",
            '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]',
          );
          expect(view?.activities[0]).toMatchObject({
            state: "waiting",
            externalResult: "unknown",
            inFlight: null,
          });
          expect(view?.budget.used).toBe(fenced ? 3 : 4);
          if (fenced) {
            const receipt = (
              await db.information.find({
                kinds: ["core.action.result.v1"],
                limit: 1,
              })
            )[0]!;
            expect(
              (receipt.payload.outcome as { environmentValidation: string })
                .environmentValidation,
            ).toBe("fenced");
            const scope = view!.activities[0]!.scope;
            await expect(
              db.continuity.resource({
                agentId: "kaguya",
                operationId: "fenced-resource",
                resource: {
                  id: randomUUID(),
                  scope,
                  url: "workspace:note.md",
                  readAt: new Date().toISOString(),
                  contentHash: "a".repeat(64),
                  actionReceiptId: receipt.informationId,
                  artifactId: "fenced-artifact",
                  role: "note",
                  verifies: null,
                },
              }),
            ).rejects.toThrow("unproven-resource");
            await expect(
              db.continuity.internalSource({
                operationId: "fenced-capability",
                source: {
                  agentId: "kaguya",
                  scope,
                  ownerId: "self:kaguya",
                  type: "capability-evidence",
                  text: "不能据此证明能力",
                  basis: [receipt.informationId],
                  occurredAt: new Date().toISOString(),
                },
              }),
            ).rejects.toThrow("unproven-capability-evidence");
          }
          expect(
            await db.information.find({
              kinds: ["core.action.result.v1"],
              limit: 10,
            }),
          ).toHaveLength(1);
          expect(
            await db.information.find({
              kinds: ["consumer.failed"],
              limit: 10,
            }),
          ).toEqual([]);
        } finally {
          await runtime.close();
          await db.close();
        }
      },
    );
    it("saves appraisal before choosing, charges both actual model calls and resumes without reimporting", async () => {
      const db = await create();
      const light = createDeterministicModel([
        {
          subjective: {
            attention: ["阅读"],
            interests: [{ topic: "月球", reason: "已有兴趣" }],
            appraisal: "想读一会儿",
            social: "solitude",
          },
          reason: "当前想独处",
        },
        {
          action: "wait",
          activityId: null,
          title: "",
          goal: "",
          nextStep: "",
          reason: "先等待资料",
          checkAfterMs: 3600000,
        },
      ]);
      const heavy = createRepeatingDeterministicModel("unused");
      const moduleConfigs = createFirstPartyModuleConfigDefaults("test").map(
        (c) => ({
          ...c,
          enabled: ["memory.native", "agent.continuity"].includes(
            c.definitionId,
          ),
          settings:
            c.definitionId === "agent.continuity"
              ? { autonomous: true }
              : c.settings,
        }),
      );
      const composition = createMessageComposition(
        ({ modelTier }) => ({
          providerId: "test",
          modelId: modelTier,
          model: modelTier === "light" ? light : heavy,
          configuration: {
            adapter: "deterministic",
            protocol: "local",
            endpoint: "local",
            revision: "1",
          },
        }),
        { moduleConfigs, memoryEnabled: true },
      );
      const make = () =>
        new KaguyaRuntime({
          database: db,
          ...composition,
          nativeTools: {
            registrations: [
              {
                id: "test.read",
                version: "1",
                description: "已配置工具",
                providerId: "test",
                providerVersion: "1",
                executor: "test",
                readonly: true,
                independent: false,
                policyVersion: "1",
                inputSchema: z.object({}).strict(),
                bind: async () => ({ target: {} }),
                authorize: async () => true,
              },
            ],
            tasks: [
              {
                definitionId: "agent.continuity",
                taskId: "agent.continuity.execute",
                toolIds: ["test.read"],
              },
            ],
          },
        });
      let runtime = make();
      try {
        await runtime.start();
        await vi.waitFor(
          async () =>
            expect(
              await db.information.find({
                kinds: ["agent.continuity.cycle.v1"],
                limit: 10,
              }),
            ).toHaveLength(1),
          { timeout: 8000 },
        );
        expect(
          (
            await db.information.find({
              kinds: ["agent.continuity.cycle.v1"],
              limit: 10,
            })
          )[0]?.payload,
        ).toMatchObject({ reason: "先等待资料" });
        expect(
          (
            await db.continuity.read(
              "kaguya",
              '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]',
            )
          )?.budget.used,
        ).toBe(2);
        await vi.waitFor(
          async () =>
            expect(
              await db.information.find({
                kinds: ["agent.continuity.cycle.v1"],
                limit: 10,
              }),
            ).toHaveLength(1),
          { timeout: 8000 },
        );
        const requests = await db.information.find({
          kinds: ["core.model.task.requested"],
          registrationOrder: true,
          order: "asc",
          limit: 10,
        });
        expect(requests.map((a) => a.payload.taskId)).toEqual([
          "agent.continuity.appraise",
          "agent.continuity.choose",
        ]);
        const prompt = requests[1]?.payload.prompt as { text: string };
        expect(prompt.text).toContain("solitude");
        expect(prompt.text).toContain("persona-seed");
        expect(
          await db.information.find({ kinds: ["consumer.failed"], limit: 10 }),
        ).toEqual([]);
        await runtime.close();
        runtime = make();
        await runtime.start();
        expect(
          (await db.continuity.read("kaguya", "shared"))?.budget.used,
        ).toBe(2);
        expect(
          await db.information.find({
            kinds: ["agent.continuity.policy.v1"],
            limit: 10,
          }),
        ).toHaveLength(1);
        expect(
          await db.information.find({
            kinds: ["agent.continuity.internal-source.v1"],
            limit: 10,
          }),
        ).toHaveLength(1);
      } finally {
        await runtime.close();
        await db.close();
      }
    });
  },
);
