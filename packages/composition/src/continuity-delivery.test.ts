/** 使用真实账本、工具循环、临时文件及合成 transport，验证约定的完整履约边界。 */
import { describe, expect, it, vi } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import { KaguyaRuntime, nativeToolWireName } from "@kaguya/runtime";
import { createNativeScriptedModel } from "@kaguya/llm/testing";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { z } from "@kaguya/schema";
import { InformationCore } from "@kaguya/engine";
import { createMessageComposition } from "./index.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  "autonomous commitment delivery $name",
  ({ create }) => {
    it("reads and verifies the note, sends once to the requester, and leaves fulfillment pending until feedback", async () => {
      const db = await create(),
        dir = await mkdtemp(join(tmpdir(), "kaguya-commitment-")),
        conversationId = randomUUID();
      const scope = JSON.stringify(["web", "web.test", "web", conversationId]);
      const errors: string[] = [],
        originalFailure = InformationCore.prototype.recordReliableFailure;
      const spy = vi
        .spyOn(InformationCore.prototype, "recordReliableFailure")
        .mockImplementation(function (this: InformationCore, claim, error) {
          errors.push(String(error));
          return originalFailure.call(this, claim, error);
        });
      let runId = "",
        step = 0;
      const sent: string[] = [];
      await writeFile(join(dir, "source.txt"), "月球表面有环形山。", "utf8");
      const model = createNativeScriptedModel(async () => {
        const request = (
          await db.information.find({
            kinds: ["core.model.task.requested"],
            registrationOrder: true,
            order: "desc",
            limit: 1,
          })
        )[0]!;
        const a = (await db.continuity.read("kaguya", scope))?.activities[0];
        const task = request.payload.taskId;
        if (task === "agent.continuity.appraise")
          return {
            text: JSON.stringify({
              subjective: null,
              reason: "无变化",
              feedback: [],
            }),
          };
        if (task === "agent.continuity.choose")
          return {
            text: JSON.stringify({
              action: a && a.fulfillment !== "fulfilled" ? "continue" : "wait",
              activityId: a?.id ?? null,
              title: "",
              goal: "",
              nextStep: a?.nextStep ?? "",
              reason: a ? "处理已接受的资料约定" : "等待具体资料",
              checkAfterMs: 3600000,
            }),
          };
        if (task === "agent.light.decide")
          return {
            text: JSON.stringify({ action: "message", reason: "respond" }),
          };
        if (task === "agent.heavy.respond") {
          const inbound = (
            await db.information.find({
              kinds: ["core.message.inbound.text"],
              registrationOrder: true,
              order: "desc",
              limit: 1,
            })
          )[0]!;
          return {
            text: JSON.stringify({
              action: "message",
              text: a
                ? "收到，这份笔记的交付已确认。"
                : "好，我读完后把笔记分享给你。",
              continuity: {
                kind: a ? "feedback" : "accept",
                activityId: a?.id ?? null,
                requestId: inbound.informationId,
                title: "分享阅读笔记",
                goal: "读取月球资料并分享已核对的笔记",
                nextStep: "读取资料",
                dueAt: null,
                outcome: a ? "fulfilled" : null,
              },
            }),
          };
        }
        if (task !== "agent.continuity.execute")
          throw new Error("Unexpected model task");
        if (step < 3)
          return {
            calls: [
              {
                id: `workspace-${step}`,
                name: nativeToolWireName("test.workspace", "1"),
                input: JSON.stringify({
                  mode: ["read", "write", "verify"][step++],
                }),
              },
            ],
          };
        if (step++ === 3) {
          const receipts = await db.continuity.receipts("kaguya", scope, runId);
          return {
            text: JSON.stringify({
              status: "complete",
              summary: "笔记已经保存并回读核对，接下来分享",
              nextStep: "发送约定的笔记",
              completedSteps: ["读取资料", "保存笔记", "核对内容指纹"],
              checkAfterMs: 3600000,
              resources: receipts.map((r) => ({
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
        }
        if (step === 5)
          return {
            calls: [
              {
                id: "deliver-note",
                name: nativeToolWireName("activity.deliver", "1"),
                input: JSON.stringify({
                  activityId: a!.id,
                  text: `约好的阅读笔记：${await readFile(join(dir, "note.md"), "utf8")}`,
                  resourceIds: a!.artifacts,
                }),
              },
            ],
          };
        return {
          text: JSON.stringify({
            status: "complete",
            summary: "资料已投递，等待对方反馈",
            nextStep: "等待反馈，不重复发送",
            completedSteps: ["读取资料", "保存并核对笔记", "投递给原请求者"],
            resources: [],
            checkAfterMs: 3600000,
          }),
        };
      });
      const configs = createFirstPartyModuleConfigDefaults("test").map((c) => ({
        ...c,
        enabled:
          c.definitionId === "memory.native" ||
          c.definitionId === "agent.continuity" ||
          c.enabled,
        settings:
          c.definitionId === "agent.continuity"
            ? { autonomous: true, scope }
            : c.settings,
      }));
      const runtime = new KaguyaRuntime({
        database: db,
        ...createMessageComposition(
          ({ modelTier }) => ({
            providerId: "test",
            modelId: modelTier,
            model,
            configuration: {
              adapter: "deterministic",
              protocol: "local",
              endpoint: "local",
              revision: "1",
            },
          }),
          { moduleConfigs: configs, memoryEnabled: true },
        ),
        actionProviders: [
          {
            id: "workspace",
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
              if (mode === "write")
                await writeFile(
                  join(dir, "note.md"),
                  "月球表面有环形山。来源：隔离测试资料。",
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
              providerId: "workspace",
              providerVersion: "1",
              executor: "workspace",
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
      runtime.registerTransport({
        platform: "web",
        adapterId: "web.test",
        transport: {
          sendMessage: async (target, message) => {
            sent.push("text" in message ? message.text : "");
            return {
              ok: true,
              platform: "web",
              adapterId: "web.test",
              target,
              platformMessageId: randomUUID(),
            };
          },
        },
      });
      const send = (text: string) =>
        runtime.submit({
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
        await send("请读一下月球资料，稍后把笔记分享给我");
        // 活动在接受回复投递后启动。等周期提交后再读取版本，避免与检查时间更新竞争。
        let acceptanceDeliveryId = "";
        await vi.waitFor(
          async () => {
            const delivery = (
              await db.information.find({
                kinds: ["core.delivery.delivered"],
                payloadContains: {
                  adapterId: "web.test",
                  target: { kind: "web", conversationId },
                },
                limit: 1,
              })
            )[0];
            expect(delivery, errors.join("\n")).toBeDefined();
            acceptanceDeliveryId = delivery!.informationId;
          },
          { timeout: 10000 },
        );
        await vi.waitFor(
          async () => {
            const cycle = (
              await db.information.find({
                kinds: ["agent.continuity.cycle.v1"],
                payloadContains: { sourceId: acceptanceDeliveryId },
                limit: 1,
              })
            )[0];
            expect(cycle, errors.join("\n")).toBeDefined();
            expect(cycle!.payload).toMatchObject({ status: "completed" });
          },
          { timeout: 10000 },
        );
        let a = (await db.continuity.read("kaguya", scope))!.activities[0]!;
        expect(a).toMatchObject({
          state: "waiting",
          externalResult: "verified",
        });
        expect(a.nextCheckAt).not.toBeNull();
        expect(sent).toHaveLength(1);
        expect(a.deliveryIds).toEqual([]);
        expect(a.fulfillment).toBe("pending");
        await db.continuity.change({
          agentId: "kaguya",
          operationId: `control:${randomUUID()}`,
          activityId: a.id,
          expectedRevision: a.revision,
          change: { state: "active", reason: "从保存的分享步骤继续" },
          basis: [a.acceptedBy!],
        });
        await vi.waitFor(
          () => expect(sent, errors.join("\n")).toHaveLength(2),
          { timeout: 10000 },
        );
        await vi.waitFor(async () =>
          expect(
            (await db.continuity.read("kaguya", scope))?.activities[0]
              ?.deliveryIds,
          ).toHaveLength(1),
        );
        a = (await db.continuity.read("kaguya", scope))!.activities[0]!;
        expect(a.fulfillment).toBe("pending");
        expect(sent[1]).toContain("约好的阅读笔记");
        await send("这份笔记就是约好的内容，已收到并确认");
        await vi.waitFor(
          async () =>
            expect(
              (await db.continuity.read("kaguya", scope))?.activities[0]
                ?.fulfillment,
              errors.join("\n"),
            ).toBe("fulfilled"),
          { timeout: 10000 },
        );
        expect(
          (await db.continuity.read("kaguya", "private:other"))?.activities,
        ).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await runtime.close();
        await db.close();
        await rm(dir, { recursive: true, force: true });
        spy.mockRestore();
      }
    }, 40000);
  },
);
