/**
 * 功能概述：在真实 Runtime、ModelTask、媒体来源表及 W3 投递上验证有序图片的来源授权和恢复。
 * fixture 只使用合成 PNG 与确定性模型；正文、来源快照、请求和完成事实均由正式入口生成。
 * 覆盖纯图/图文顺序、同场景未选素材、伪造或丢失证明、字节损坏、读取期间取消及 unknown 恢复。
 * 所有持久等待使用 8 秒有界条件；正文预算含多阶段重启，资源取得即登记，失败也释放全部实例。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageComposition } from "@kaguya/composition";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import { createStructuredOutputPromptRenderer } from "@kaguya/llm";
import type { KaguyaLlmClient } from "@kaguya/llm/client";
import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
} from "@kaguya/modules";
import {
  sceneIdentity,
  z,
  outboundContentSegmentsSchema,
  type OutboundContentSegment,
} from "@kaguya/schema";
import type { MediaResource, MediaResourceStore } from "@kaguya/sdk";
import type { PlatformOutboundTransport } from "@kaguya/platform-adapters";
import {
  KaguyaRuntime,
  type RuntimeCapabilityContext,
  ModelTaskClient,
  prepareHeavyMedia,
  modelTaskRequestedInformationKind,
  modelTaskCompletedInformationKind,
} from "@kaguya/runtime";

const wait = { timeout: 8_000, interval: 20 } as const;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse())
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length)
    throw new AggregateError(errors, "media output cleanup failed");
});
const url = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL media output URL required");
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];
for (const backend of backends)
  describe(backend.name, () => {
    async function fixture(
      options: {
        pure?: boolean;
        unselected?: boolean;
        forged?: boolean;
        decorate?: boolean;
        emoji?: boolean;
        repeatedLarge?: boolean;
        paced?: boolean;
      } = {},
    ) {
      const db = await backend.create();
      cleanups.push(() => db.close());
      const saved = new Map<string, MediaResource>();
      const get = vi.fn<MediaResourceStore["get"]>(async (id) => saved.get(id));
      const resources: MediaResourceStore = {
        get,
        put: async (value) => {
          saved.set(value.resourceId, {
            ...value,
            bytes: Uint8Array.from(value.bytes),
          });
        },
        delete: async (id) => {
          saved.delete(id);
        },
        cleanupExpired: async () => 0,
      };
      let core!: RuntimeCapabilityContext["core"];
      let scheduler!: RuntimeCapabilityContext["oneShotSchedule"];
      const composition = createMessageComposition(undefined, {
        moduleConfigs: options.decorate
          ? [
              {
                version: 1,
                instanceId: "qq-expression.synthetic",
                definitionId: "plugin.qq-expression",
                enabled: true,
                settings: {},
              },
            ]
          : [],
      });
      const capabilities = (context: RuntimeCapabilityContext) => {
        core = context.core;
        scheduler = context.oneShotSchedule;
        return composition.capabilities(context);
      };
      const runtimeOptions = {
        ...composition,
        database: db,
        activations: composition.activations.filter(
          (a) => a.definitionId === "plugin.qq-expression",
        ),
        capabilities,
        mediaResources: resources,
        mediaInput: {
          mode: "off" as const,
          acquire: async () =>
            options.repeatedLarge
              ? Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)])
              : png,
        },
      };
      let runtime = new KaguyaRuntime(runtimeOptions);
      cleanups.push(() => runtime.close());
      const send = vi.fn<PlatformOutboundTransport["sendMessage"]>(
        async (target) => ({
          ok: true,
          adapterId: "web.media",
          platform: "web",
          target,
        }),
      );
      const attach = () =>
        runtime.registerTransport({
          adapterId: "web.media",
          platform: "web",
          transport: { sendMessage: send },
        });
      attach();
      await runtime.start();
      const receipt = await runtime.submit({
        adapterId: "web.media",
        platform: "web",
        platformMessageId: "synthetic-media",
        occurredAt: new Date().toISOString(),
        text: "synthetic",
        target: { kind: "web" },
        sender: { userId: "synthetic" },
        mentions: [],
        raw: {},
        contentSegments: [
          { kind: "media", position: 0, mediaType: "image", source: {} },
        ],
      });
      const source = (
        await db.information.find({
          kinds: ["core.message.inbound.text"],
          limit: 1,
        })
      )[0]!;
      const inbound = inboundTextInformationKind.payloadSchema.parse(
        source.payload,
      );
      const refs = (inbound.contentSegments ?? []).flatMap((s) =>
        s.kind === "media" ? [s.media] : [],
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]!.status).toBe("available");
      const scope = sceneIdentity({
        platform: "web",
        adapterId: "web.media",
        destination: { kind: "web" },
      });
      const mediaId = options.unselected
        ? `media:${"e".repeat(64)}`
        : refs[0]!.mediaId;
      if (options.unselected)
        await db.mediaSources.put(scope, "not-selected", {
          ...refs[0]!,
          mediaId,
        });
      const segments: OutboundContentSegment[] = options.pure
        ? [{ kind: "mediaRef", mediaId }]
        : [
            { kind: "text", text: options.emoji ? "before🙂" : "before" },
            { kind: "mediaRef", mediaId },
            { kind: "text", text: "after" },
          ];
      if (options.repeatedLarge)
        segments.splice(
          2,
          0,
          { kind: "mediaRef", mediaId },
          { kind: "mediaRef", mediaId },
        );
      const output = {
        action: "message" as const,
        text: options.pure
          ? ""
          : options.emoji
            ? "before🙂after"
            : "beforeafter",
        contentSegments: segments,
      };
      const generate = vi.fn(async () => ({ output, durationMs: 0 }));
      const client = new ModelTaskClient({
        core,
        client: { generate } as Pick<KaguyaLlmClient, "generate">,
        resolveModel: () => ({ providerId: "synthetic", modelId: "synthetic" }),
        renderStructuredOutputPrompt: createStructuredOutputPromptRenderer(
          "JSON schema: {{json_schema}}",
        ),
        prepareMedia: async (key) =>
          options.forged
            ? [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        mediaInput: {
                          mediaId,
                          resourceId: refs[0]!.resourceId,
                          mode: "off",
                          status: "vision-off",
                        },
                      }),
                    },
                  ],
                },
              ]
            : prepareHeavyMedia({
                key,
                scope,
                refs,
                model: { providerId: "synthetic", modelId: "synthetic" },
                sources: db.mediaSources,
                resources,
                options: { mode: "off" },
              }),
      });
      const result = await client.execute({
        task: {
          taskId: "agent.heavy.respond",
          outputMode: "object",
          allowedTiers: ["heavy"],
          outputSchema: z.strictObject({
            action: z.literal("message"),
            text: z.string(),
            contentSegments: outboundContentSegmentsSchema,
          }),
        },
        sourceInformationId: source.informationId,
        contextInformationId: receipt.rootInformationId,
        contextAtoms: [source],
        activation: {
          instanceId: "heavy.synthetic",
          definitionId: "agent.heavy",
        },
        selectionPolicy: { tier: "heavy" },
        prompt: {
          kind: "message",
          templateId: "synthetic.media",
          templates: [{ name: "main", content: "{{input}}" }],
          text: "synthetic",
          variables: [
            {
              name: "input",
              content: "synthetic",
              informationIds: [source.informationId],
            },
          ],
        },
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed")
        throw new Error("synthetic model did not complete");
      let outputCause = result.terminalInformationId;
      const assistantPayload = {
        text: output.text,
        contentSegments: segments,
        mediaRequestInformationId: result.requestedInformationId,
        source: {
          platform: inbound.source.platform,
          adapterId: inbound.source.adapterId,
          destination: inbound.source.destination,
        },
        originatingModuleInstanceId: "heavy.synthetic",
        turn: null,
      };
      if (options.decorate) {
        const draftKind = composition.catalog.definitions
          .flatMap(({ manifest }) => [
            ...manifest.consumes,
            ...manifest.produces,
          ])
          .find((kind) => kind.kind === "agent.heavy.message.draft");
        if (!draftKind)
          throw new Error("draft kind missing from production catalog");
        await core.register(draftKind, {
          source: "module:heavy.synthetic",
          occurredAt: new Date().toISOString(),
          payload: assistantPayload,
          references: [
            {
              relation: "core:caused-by",
              informationId: result.terminalInformationId,
            },
            {
              relation: "core:context",
              informationId: receipt.rootInformationId,
            },
          ],
        });
        await vi.waitFor(
          async () =>
            expect(
              await db.information.find({
                kinds: ["agent.heavy.message.prepared"],
                limit: 10,
              }),
            ).toHaveLength(1),
          wait,
        );
        const prepared = (
          await db.information.find({
            kinds: ["agent.heavy.message.prepared"],
            limit: 10,
          })
        )[0]!;
        expect(prepared.payload).toMatchObject(assistantPayload);
        outputCause = prepared.informationId;
      }
      let readyId: string | undefined;
      if (options.paced) {
        const readyKind = composition.catalog.definitions
          .flatMap(({ manifest }) => [
            ...manifest.consumes,
            ...manifest.produces,
          ])
          .find((kind) => kind.kind === "agent.heavy.message.ready");
        if (!readyKind)
          throw new Error("ready kind missing from production catalog");
        const ready = await core.register(readyKind, {
          source: "module:heavy.synthetic",
          occurredAt: new Date().toISOString(),
          payload: assistantPayload,
          references: [
            { relation: "core:caused-by", informationId: outputCause },
            {
              relation: "core:context",
              informationId: receipt.rootInformationId,
            },
          ],
        });
        readyId = ready.informationId;
        const schedule = await scheduler.schedule({
          operationKey: "synthetic-media-pacing",
          sourceInformationId: ready.informationId,
          dueAt: new Date().toISOString(),
          input: {
            purpose: "heavy-speech",
            readyInformationId: ready.informationId,
          },
          activation: {
            instanceId: "heavy.synthetic",
            definitionId: "agent.heavy",
          },
        });
        await vi.waitFor(
          async () =>
            expect(
              await db.information.find({
                kinds: ["core.schedule.one-shot.due"],
                payloadContains: {
                  scheduleInformationId: schedule.scheduleInformationId,
                },
                limit: 1,
              }),
            ).toHaveLength(1),
          wait,
        );
        outputCause = (
          await db.information.find({
            kinds: ["core.schedule.one-shot.due"],
            payloadContains: {
              scheduleInformationId: schedule.scheduleInformationId,
            },
            limit: 1,
          })
        )[0]!.informationId;
        await scheduler.finish({
          scheduleInformationId: schedule.scheduleInformationId,
          status: "fired",
        });
      }
      const assistant = await core.register(assistantTextInformationKind, {
        source: "module:heavy.synthetic",
        occurredAt: new Date().toISOString(),
        payload: assistantPayload,
        references: [
          { relation: "core:caused-by", informationId: outputCause },
          {
            relation: "core:context",
            informationId: receipt.rootInformationId,
          },
          ...(readyId
            ? [{ relation: "core:uses-context", informationId: readyId }]
            : []),
        ],
      });
      const terminal = async (id: string) =>
        (
          await db.information.find({
            kinds: ["core.delivery.delivered", "core.delivery.failed"],
            limit: 20,
          })
        ).filter((a) =>
          a.references.some(
            (r) => r.relation === "core:status-of" && r.informationId === id,
          ),
        );
      return {
        db,
        get,
        send,
        saved,
        result,
        segments,
        assistant,
        assistantId: assistant.informationId,
        contextId: receipt.rootInformationId,
        get core() {
          return core;
        },
        get runtime() {
          return runtime;
        },
        submit: (
          requestInformationId = result.requestedInformationId,
          assistantInformationId = assistant.informationId,
        ) =>
          core.register(deliveryRequestedInformationKind, {
            source: "module:synthetic-output",
            occurredAt: new Date().toISOString(),
            payload: {
              adapterId: "web.media",
              platform: "web",
              destination: { kind: "web" },
              turn: null,
              message: {
                kind: "content",
                text: output.text,
                segments,
                requestInformationId,
              },
            },
            references: [
              {
                relation: "core:caused-by",
                informationId: assistantInformationId,
              },
              {
                relation: "core:context",
                informationId: receipt.rootInformationId,
              },
            ],
          }),
        terminal,
        async settle(id: string) {
          await vi.waitFor(
            async () => expect(await terminal(id)).toHaveLength(1),
            wait,
          );
          await vi.waitFor(async () => {
            const health = await db.information.reliable.health();
            expect(health.pending).toBe(0);
            expect(health.exhausted).toBe(0);
          }, wait);
        },
        async restart() {
          await runtime.close();
          runtime = new KaguyaRuntime(runtimeOptions);
          attach();
          await runtime.start();
        },
      };
    }
    it.each([false, true])(
      "sends ordered content (pure=%s) once across restart",
      async (pure) => {
        const f = await fixture({ pure });
        const request = await f.submit();
        await f.settle(request.informationId);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.send.mock.calls[0]![1]).toMatchObject({
          kind: "content",
          segments: f.segments,
        });
        expect(f.send.mock.calls[0]![2]?.images?.[0]?.bytes).toEqual(
          Uint8Array.from(png),
        );
        await f.restart();
        await f.settle(request.informationId);
        expect(f.send).toHaveBeenCalledTimes(1);
      },
      50_000,
    );
    it.each([true, false])(
      "preserves pure=%s ordered content through the enabled QQ expression module",
      async (pure) => {
        const f = await fixture({ pure, decorate: true, emoji: !pure });
        const request = await f.submit();
        await f.settle(request.informationId);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.send.mock.calls[0]![1]).toMatchObject({
          kind: "content",
          segments: f.segments,
          text: pure ? "" : "before🙂after",
        });
      },
      40_000,
    );
    it("resolves a real paced schedule through its bound ready fact exactly once", async () => {
      const f = await fixture({ paced: true });
      const request = await f.submit();
      await f.settle(request.informationId);
      expect(f.send).toHaveBeenCalledTimes(1);
      await f.restart();
      await f.settle(request.informationId);
      expect(f.send).toHaveBeenCalledTimes(1);
    }, 60_000);
    it.each([
      "unselected",
      "forged",
      "snapshot-missing",
      "cross-scene",
      "corrupt",
      "hash-mismatch",
      "metadata-mismatch",
      "repeated-byte-budget",
      "unrelated-request",
    ] as const)(
      "rejects %s before transport",
      async (failure) => {
        const f = await fixture({
          unselected: failure === "unselected",
          forged: failure === "forged",
          repeatedLarge: failure === "repeated-byte-budget",
        });
        if (failure === "snapshot-missing")
          await f.db.sql.query("DELETE FROM media_input_snapshots");
        if (failure === "cross-scene")
          await f.db.sql.query(
            "UPDATE media_sources SET scope='another-scene'",
          );
        if (failure === "corrupt")
          f.get.mockImplementation(async (id) => ({
            ...f.saved.get(id)!,
            bytes: Buffer.from("corrupt"),
          }));
        if (failure === "hash-mismatch")
          f.get.mockImplementation(async (id) => ({
            ...f.saved.get(id)!,
            sha256: "0".repeat(64),
          }));
        if (failure === "metadata-mismatch")
          f.get.mockImplementation(async (id) => ({
            ...f.saved.get(id)!,
            mimeType: "image/jpeg",
          }));
        const request = await f.submit(
          failure === "unrelated-request"
            ? "unrelated-model-request"
            : undefined,
        );
        await f.settle(request.informationId);
        expect(f.send).not.toHaveBeenCalled();
        expect(
          await f.db.actions.deliveryResult(request.informationId),
        ).toMatchObject({ status: "rejected", evidence: "not-executed" });
      },
      30_000,
    );
    it("rejects a real completion attached only as context when the assistant cause belongs to another request", async () => {
      const f = await fixture();
      const requested = (await f.core.get(f.result.requestedInformationId))!;
      const completed = (await f.core.get(f.result.terminalInformationId))!;
      // 两个正式请求各有自己的终态；故意构造跨请求的助手引用来验证宿主拒绝，不预填投递结果。
      const otherRequest = await f.core.register(
        modelTaskRequestedInformationKind,
        {
          source: "runtime:model-task",
          occurredAt: new Date().toISOString(),
          payload: modelTaskRequestedInformationKind.payloadSchema.parse(
            requested.payload,
          ),
          references: requested.references,
        },
      );
      const otherCompleted = await f.core.register(
        modelTaskCompletedInformationKind,
        {
          source: "runtime:model-task",
          occurredAt: new Date().toISOString(),
          payload: modelTaskCompletedInformationKind.payloadSchema.parse(
            completed.payload,
          ),
          references: [
            {
              relation: "core:caused-by",
              informationId: otherRequest.informationId,
            },
            {
              relation: "core:status-of",
              informationId: otherRequest.informationId,
            },
            { relation: "core:context", informationId: f.contextId },
          ],
        },
      );
      const forgedAssistant = await f.core.register(
        assistantTextInformationKind,
        {
          source: "module:heavy.synthetic",
          occurredAt: new Date().toISOString(),
          payload: assistantTextInformationKind.payloadSchema.parse(
            f.assistant.payload,
          ),
          references: [
            {
              relation: "core:caused-by",
              informationId: otherCompleted.informationId,
            },
            {
              relation: "core:uses-context",
              informationId: completed.informationId,
            },
            { relation: "core:context", informationId: f.contextId },
          ],
        },
      );
      const request = await f.submit(undefined, forgedAssistant.informationId);
      await f.settle(request.informationId);
      expect(f.send).not.toHaveBeenCalled();
      expect(
        await f.db.actions.deliveryResult(request.informationId),
      ).toMatchObject({ status: "rejected", evidence: "not-executed" });
    }, 30_000);
    it("cancels while resource reading and never invokes transport", async () => {
      const f = await fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.get.mockImplementation(async (id) => {
        await gate;
        return f.saved.get(id);
      });
      try {
        const request = await f.submit();
        await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(1), wait);
        const head = (
          await f.db.sql.query<{
            intent_id: string;
            input: { scope: string; authorizationId: string };
          }>(
            "SELECT intent_id,input FROM information_action_heads WHERE operation_id=$1",
            [`delivery:${request.informationId}`],
          )
        ).rows[0]!;
        await f.runtime.actions.cancel({
          intentId: head.intent_id,
          scope: head.input.scope,
          causeInformationId: f.contextId,
          controlAuthorizationId: head.input.authorizationId,
        });
        release();
        await f.settle(request.informationId);
        expect(f.send).not.toHaveBeenCalled();
        expect(
          await f.db.actions.deliveryResult(request.informationId),
        ).toMatchObject({ status: "cancelled", evidence: "not-executed" });
      } finally {
        release();
      }
    }, 40_000);
    it("restores an unknown receipt after projection loss without re-reading or resending images", async () => {
      const f = await fixture();
      f.send.mockImplementation(async (target) => ({
        ok: false,
        outcome: "unknown",
        adapterId: "web.media",
        platform: "web",
        target,
        error: "synthetic unknown",
      }));
      const original = f.core.commitTerminal.bind(f.core);
      const projection = vi
        .spyOn(f.core, "commitTerminal")
        .mockImplementation((...args) =>
          args[0] === "kaguya.delivery.result.v1"
            ? Promise.reject(new Error("synthetic projection crash"))
            : original(...args),
        );
      try {
        const request = await f.submit();
        await vi.waitFor(
          async () =>
            expect(
              await f.db.actions.deliveryResult(request.informationId),
            ).toMatchObject({ status: "unknown", evidence: "unconfirmed" }),
          wait,
        );
        await f.runtime.close();
        projection.mockRestore();
        await f.db.sql.query(
          "UPDATE information_deliveries SET available_at=clock_timestamp() WHERE subscription_id='kaguya.runtime.delivery' AND information_id=$1",
          [request.informationId],
        );
        await f.restart();
        await f.settle(request.informationId);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.get).toHaveBeenCalledTimes(1);
        expect(
          (await f.terminal(request.informationId))[0]!.payload,
        ).toMatchObject({ ok: false, outcome: "unknown" });
      } finally {
        projection.mockRestore();
      }
    }, 50_000);
  });
