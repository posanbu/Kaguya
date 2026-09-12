/**
 * 功能概述：用真实 PGlite、Core 和 ModuleHost 验证 `KaguyaRuntime` 的完整信息 DAG。
 * Planner 使用独立 object Model Task，测试分别定位 plan 与 compose，确保故障静默与唯一分派。
 * 主要职责：覆盖 Web 入站到投递成功的直接因果链、生成失败不会继续 assistant/outbound/delivery、
 * 三类 transport 失败、无订阅持久化、同 kind 消费并发与多 message composer activation 共享模型任务后
 * 各自按 intent target 投递纯文本，默认 OneBot action 仅含 text 段、start/close 确定性交错、
 * in-flight 关闭、关闭后 ingress 拒绝、数据库初始化错误固定分类及抛出型反射属性，
 * 以及消费者失败与其他结果并存；默认 message Prompt 必须带原子 provenance 和有序
 * uses-context 引用。
 * 代码库关系：测试直接消费 Runtime 的 `InformationIngress.submit` 和注入数据库选项；默认业务
 * 模块来自 `@kaguya/modules`，自定义 fixture 只用于隔离并发和消费者故障语义。
 * 输入输出与副作用：每个用例创建隔离的内存 PGlite 数据库，Runtime 只写 information
 * ledger；所有创建 PGlite 的用例共享 15 秒跨平台超时，测试结束显式关闭注入数据库，
 * 并检查持久化 payload 不包含 raw/provider secret。
 */
import {
  KaguyaLlmClient,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import {
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  createFirstPartyModuleConfigDefaults,
  type ModuleModelSelection,
} from "@kaguya/modules";
import {
  ModelTaskClient,
  modelTaskCapability,
  type ModelTaskCapability,
} from "./model-task.js";
import {
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
  modelTaskCompletedInformationKind,
  modelTaskRequestedInformationKind,
} from "./information-kinds.js";
import { executionExhaustedInformationKind } from "@kaguya/engine";
import { defineInformationModuleCatalog } from "@kaguya/sdk";
import { KaguyaDatabase } from "@kaguya/database";
import { createLogger, type KaguyaLogger } from "@kaguya/logger";
import { createTestingDatabase } from "@kaguya/database/testing";
import { memoryCapability } from "@kaguya/memory";
import { oneShotScheduleCapability } from "@kaguya/scheduler";
import {
  createDeferredDeterministicModel,
  createRepeatingDeterministicModel,
  createPlanningDeterministicModel,
} from "@kaguya/llm/testing";
import {
  inboundTextInformationKind,
  attentionArousalCompletedInformationKind,
} from "@kaguya/modules";
import { buildOneBotSendAction } from "@kaguya/platform-adapters";
import type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformOutboundTransport,
} from "@kaguya/platform-adapters";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  onInformation,
  type InformationModuleActivation,
} from "@kaguya/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const testIdentity = { name: "Kaguya", aliases: ["辉夜"], persona: "test" };
const testMessageTemplates = {
  main: "{{scene}}{{history}}{{memory}}{{turn}}",
  history: "{{#each messages}}{{> history-inbound}}{{/each}}",
  historyInbound: "{{content}}",
  historyAssistant: "{{content}}",
  memory: "{{#each items}}{{> memory-item}}{{/each}}",
  memoryItem: "{{content}}",
  quoted: "{{message}}",
  turn: "{{#each messages}}{{> history-inbound}}{{/each}}",
};

import {
  KaguyaRuntime,
  OutboundTransportError,
  OutboundTransportNotFoundError,
  RuntimeUnavailableError,
  type RuntimeCapabilityContext,
} from "./runtime.js";

const TEST_TIMEOUT = 15_000;
const resources: Array<{
  runtime?: KaguyaRuntime;
  database: Awaited<ReturnType<typeof createTestingDatabase>>;
}> = [];

class GatedSchemaDatabase extends KaguyaDatabase {
  readonly schemaPreparationStarted: Promise<void>;
  prepareSchemaCalls = 0;
  readonly #markSchemaPreparationStarted: () => void;
  readonly #schemaPreparationGate: Promise<void>;
  readonly #releaseSchemaPreparation: () => void;

  constructor(sql: ConstructorParameters<typeof KaguyaDatabase>[0]) {
    super(sql);
    let markSchemaPreparationStarted!: () => void;
    let releaseSchemaPreparation!: () => void;
    this.schemaPreparationStarted = new Promise<void>((resolve) => {
      markSchemaPreparationStarted = resolve;
    });
    this.#schemaPreparationGate = new Promise<void>((resolve) => {
      releaseSchemaPreparation = resolve;
    });
    this.#markSchemaPreparationStarted = markSchemaPreparationStarted;
    this.#releaseSchemaPreparation = releaseSchemaPreparation;
  }

  override async prepareSchema(): Promise<void> {
    this.prepareSchemaCalls += 1;
    this.#markSchemaPreparationStarted();
    await this.#schemaPreparationGate;
    await super.prepareSchema();
  }

  releaseSchemaPreparation(): void {
    this.#releaseSchemaPreparation();
  }
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.runtime?.close().catch(() => undefined);
    await resource.database.close().catch(() => undefined);
  }
});

function webMessage(text = "hello"): PlatformInboundMessage {
  return {
    platform: "web",
    adapterId: "web.ui.main",
    platformMessageId: "request-1",
    occurredAt: "2026-09-04T00:00:00.000Z",
    text,
    mentions: [],
    target: { kind: "web" },
    sender: { userId: "web" },
    raw: { credential: "raw-must-not-enter-ledger" },
  };
}

function platformMessage(adapterId = "napcat.qq.main"): PlatformInboundMessage {
  return {
    platform: "qq",
    adapterId,
    selfId: "998877",
    platformMessageId: "message-1",
    occurredAt: "2026-09-04T00:00:00.000Z",
    text: "hello from qq",
    mentions: [{ kind: "user", id: "998877" }],
    target: { kind: "group", groupId: "778899" },
    sender: { userId: "112233", nickname: "Ada" },
    raw: { credential: "raw-must-not-enter-ledger" },
  };
}

async function createRuntime(
  overrides: Partial<{
    drainTimeoutMs: number;
    now: NonNullable<ConstructorParameters<typeof KaguyaRuntime>[0]["now"]>;
    informationIdGenerator: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["informationIdGenerator"]
    >;
    resolveModelSelection: NonNullable<RuntimeModelSelectionResolver>;
    modelTask: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["modelTask"]
    >;
    capabilities: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["capabilities"]
    >;
    catalog: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["catalog"]
    >;
    activations: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["activations"]
    >;
    memory: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["memory"]
    >;
    retrievalStrategies: NonNullable<
      ConstructorParameters<typeof KaguyaRuntime>[0]["retrievalStrategies"]
    >;
    logger: KaguyaLogger;
  }> = {},
) {
  const database = await createTestingDatabase();
  let id = 0;
  const runtime = new KaguyaRuntime({
    ...createMessageComposition(),
    database,
    now: () => new Date("2026-09-04T00:00:01.000Z"),
    informationIdGenerator: () => `runtime-atom-${++id}`,
    ...createMessageComposition(
      overrides.resolveModelSelection,
      overrides.activations,
    ),
    ...overrides,
  });
  resources.push({ runtime, database });
  return { runtime, database };
}

async function settleDeliveries(database: KaguyaDatabase): Promise<void> {
  await vi.waitFor(
    async () =>
      expect((await database.information.reliable.health()).pending).toBe(0),
    { timeout: 5000, interval: 25 },
  );
}

async function createGatedRuntime() {
  const base = await createTestingDatabase();
  const database = new GatedSchemaDatabase(base.sql);
  const runtime = new KaguyaRuntime({
    ...createMessageComposition(),
    database,
    catalog: defineInformationModuleCatalog(...[]),
    activations: [],
  });
  resources.push({ runtime, database });
  return { runtime, database };
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function parentId(
  atom: {
    readonly references: readonly { relation: string; informationId: string }[];
  },
  relation = "core:caused-by",
): string | undefined {
  return atom.references.find((reference) => reference.relation === relation)
    ?.informationId;
}

describe("KaguyaRuntime", () => {
  it(
    "logs module startup and expands the persisted Information DAG at debug",
    async () => {
      const lines: string[] = [];
      const logger = createLogger({
        service: "runtime-observability-test",
        level: "info",
        namespaceLevels: {
          "runtime:information": "trace",
          "runtime:modules": "debug",
          "runtime:module:agent.message-composer": "debug",
        },
        stream: {
          write: (line) => {
            lines.push(line);
          },
        },
      });
      const { runtime, database } = await createRuntime({ logger });
      await runtime.start();

      await runtime.submit(webMessage("hello observable moon"));
      await settleDeliveries(database);
      await vi.waitFor(
        () =>
          expect(lines.some((line) => line.includes('"detail":true'))).toBe(
            true,
          ),
        { timeout: 5000, interval: 25 },
      );
      const logs = lines.flatMap((chunk) =>
        chunk
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );

      expect(
        logs
          .filter(
            (entry) =>
              entry.module === "runtime:modules" &&
              entry.event === "module.started",
          )
          .map((entry) => entry.definitionId),
      ).toEqual([
        "core.association.memory",
        "agent.attention.arousal",
        "agent.heartbeat.short",
        "agent.heartflow.online",
        "core.identity.normalize",
        "agent.message-composer",
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          module: "runtime:module:agent.message-composer",
          event: "message.model.dispatching",
          taskId: "agent.message.compose",
          tier: "heavy",
        }),
      );
      const requestSummary = logs.find(
        (entry) =>
          entry.module === "runtime:information" &&
          entry.kind === "core.model.task.requested" &&
          entry.taskId === "agent.message.compose" &&
          entry.detail !== true,
      );
      const requestDetail = logs.find(
        (entry) =>
          entry.module === "runtime:information" &&
          entry.kind === "core.model.task.requested" &&
          entry.taskId === "agent.message.compose" &&
          entry.detail === true,
      );
      expect(requestSummary).toMatchObject({
        event: "model.task.lifecycle",
        taskId: "agent.message.compose",
        tier: "heavy",
        providerId: "test",
        modelId: "deterministic-heavy",
        promptVariableCount: 4,
      });
      expect(requestSummary?.promptPreview).toContain(
        "已决定在当前私聊中发送一条自然消息",
      );
      expect(requestSummary?.references).toEqual(expect.any(Array));
      expect(requestDetail).toMatchObject({
        informationId: requestSummary?.informationId,
        detail: true,
        sensitivity: "content",
      });
      expect(requestDetail?.promptFull).toContain("hello observable moon");
      expect(requestDetail?.promptVariables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            informationIds: expect.any(Array),
            contentDigest: expect.any(String),
          }),
        ]),
      );
    },
    TEST_TIMEOUT,
  );

  it("starts with the prepared generic completion subscription already persisted", async () => {
    const { runtime, database } = await createRuntime();
    await database.prepareSchema();
    await database.information.synchronizeKinds(["core.model.task.completed"]);
    await database.information.reliable.configureSubscriptions([
      {
        subscriptionId:
          "message-composer.default:kaguya.message.model-task-completed",
        kind: "core.model.task.completed",
      },
    ]);
    await expect(runtime.start()).resolves.toBeUndefined();
  });
  it.each(["missing", "invalid-value", "invalid-version"] as const)(
    "rejects %s model capability before module create",
    async (mode) => {
      const base = createMessageComposition().catalog.definitions.find(
        (d) => d.manifest.definitionId === "agent.message-composer",
      )!;
      const create = vi.fn(base.create);
      const definition = defineInformationModule({ ...base, create });
      const database = await createTestingDatabase();
      const runtime = new KaguyaRuntime({
        database,
        catalog: defineInformationModuleCatalog(definition),
        activations: [createMessageComposition().activations[0]!],
        capabilities:
          mode === "missing"
            ? []
            : [
                {
                  capability:
                    mode === "invalid-version"
                      ? { ...modelTaskCapability, apiVersion: 2 }
                      : modelTaskCapability,
                  value: { execute: vi.fn(), cancel: vi.fn() },
                },
              ],
      });
      resources.push({ runtime, database });
      await expect(runtime.start()).rejects.toThrow(/capability/i);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("provides only an approved ModelTaskClient and activation, hiding host internals", async () => {
    let value: ModelTaskCapability | undefined;
    let activation: unknown;
    let exposed: string[] = [];
    const base = createMessageComposition().catalog.definitions.find(
      (d) => d.manifest.definitionId === "agent.message-composer",
    )!;
    const definition = defineInformationModule({
      ...base,
      create: (options, context) => {
        value = context.use(modelTaskCapability);
        activation = options.activation;
        exposed = [
          ...Object.keys(options),
          ...Object.keys(context),
          ...Object.keys(value),
        ];
        return { subscriptions: [], provisions: [] };
      },
    });
    const { runtime } = await createRuntime({
      catalog: defineInformationModuleCatalog(definition),
      activations: [createMessageComposition().activations[0]!],
    });
    await runtime.start();
    expect(value).toBeInstanceOf(ModelTaskClient);
    expect(activation).toEqual({
      instanceId: "message-composer.default",
      definitionId: "agent.message-composer",
    });
    expect(exposed).not.toEqual(expect.arrayContaining(["core"]));
    for (const forbidden of [
      "client",
      "provider",
      "model",
      "resolveModel",
      "secret",
      "options",
    ])
      expect(exposed).not.toContain(forbidden);
    expect(Object.keys(value!)).toEqual([]);
    for (const request of [
      {
        activation: {
          instanceId: "forged",
          definitionId: "agent.message-composer",
        },
        selectionPolicy: { tier: "heavy" as const },
      },
      {
        activation: {
          instanceId: "message-composer.default",
          definitionId: "agent.message-composer",
        },
        selectionPolicy: { tier: "light" as const },
      },
    ]) {
      await expect(
        value!.execute({
          ...request,
          task: {
            taskId: "agent.message.compose",
            version: "1",
            outputMode: "object",
            allowedTiers: ["light", "heavy"],
            outputSchema: z.object({ text: z.string() }).strict(),
          },
          sourceInformationId: "source",
          contextInformationId: "context",
          contextAtoms: [],
          prompt: {
            kind: "message",
            text: "prompt",
            templateId: "test.message.v1",
            templates: [{ name: "main", content: "prompt" }],
            variables: [],
          },
        }),
      ).rejects.toThrow(/not approved/);
    }
  });

  it(
    "traces the default message prompt to frozen turn inputs",
    async () => {
      const customRetrieve = vi.fn(async () => []);
      const { runtime, database } = await createRuntime({
        retrievalStrategies: [
          {
            strategyId: "kaguya.memory.sparse",
            retrieve: customRetrieve,
          },
        ],
      });
      await runtime.start();

      const result = await runtime.submit(webMessage("hello"));
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });
      const reply = graph.find(
        ({ kind }) => kind === "agent.message.intent.requested",
      )!;
      const requested = graph.find(
        ({ kind, payload }) =>
          kind === "core.model.task.requested" &&
          payload.taskId === "agent.message.compose",
      )!;

      const context = graph.find(
        ({ kind }) => kind === "agent.turn.context.completed",
      )!;
      const inbound = graph.find(
        ({ kind }) => kind === "core.message.inbound.text",
      )!;
      expect(
        requested.references
          .filter(({ relation }) => relation === "core:uses-context")
          .map(({ informationId }) => informationId),
      ).toEqual(
        expect.arrayContaining([
          reply.informationId,
          context.informationId,
          inbound.informationId,
        ]),
      );
      const requestedPayload =
        modelTaskRequestedInformationKind.payloadSchema.parse(
          requested.payload,
        );
      expect(requestedPayload).toMatchObject({
        taskId: "agent.message.compose",
        version: "1",
        outputMode: "text",
        sourceInformationId: reply.informationId,
        activation: {
          instanceId: "message-composer.default",
          definitionId: "agent.message-composer",
        },
        selectionPolicy: { tier: "heavy" },
        resolvedModel: { providerId: "test", modelId: "deterministic-heavy" },
      });
      expect(graph.some((a) => a.kind.startsWith("core.llm."))).toBe(false);
      expect(requestedPayload.prompt.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variableName: "turn",
            informationIds: [inbound.informationId],
          }),
        ]),
      );
      expect(customRetrieve).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT,
  );

  it(
    "recalls a Web Memory globally through its original inbound provenance",
    async () => {
      const { runtime, database } = await createRuntime({
        memory: { enabled: true },
      });
      await runtime.start();

      const first = await runtime.submit(webMessage("remember moonlight"));
      await settleDeliveries(database);
      const firstGraph = await database.information.query({
        informationId: first.rootInformationId,
      });
      const firstInbound = firstGraph.find(
        ({ kind }) => kind === inboundTextInformationKind.kind,
      )!;
      await database.memory.put({
        sourceInformationId: firstInbound.informationId,
        sourceKind: firstInbound.kind,
        content: "remember moonlight",
        occurredAt: firstInbound.occurredAt,
        address: {
          platform: "web",
          adapterId: "web.ui.main",
          platformMessageId: "request-1",
          accountId: "web",
          destination: { kind: "web" },
        },
      });

      const second = await runtime.submit({
        ...webMessage("moonlight again"),
        platformMessageId: "request-2",
        occurredAt: "2026-09-04T00:00:02.000Z",
      });
      let secondGraph: Awaited<ReturnType<typeof database.information.query>> =
        [];
      await vi.waitFor(
        async () => {
          secondGraph = await database.information.query({
            informationId: second.rootInformationId,
          });
          expect(
            secondGraph.some(
              ({ kind, payload }) =>
                kind === modelTaskRequestedInformationKind.kind &&
                payload.taskId === "agent.message.compose",
            ),
          ).toBe(true);
        },
        { timeout: 5000, interval: 25 },
      );
      const requested = secondGraph.find(
        ({ kind, payload }) =>
          kind === modelTaskRequestedInformationKind.kind &&
          payload.taskId === "agent.message.compose",
      )!;
      const payload = modelTaskRequestedInformationKind.payloadSchema.parse(
        requested.payload,
      );

      expect(payload.prompt.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variableName: "memory",
            informationIds: [firstInbound.informationId],
          }),
        ]),
      );
      expect(payload.prompt.variables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "memory",
            informationIds: [firstInbound.informationId],
          }),
        ]),
      );
      expect(payload.prompt.text).toContain("remember moonlight");
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps disabled Memory as an unavailable shell without reading stored documents",
    async () => {
      const { runtime, database } = await createRuntime();
      const recall = vi.spyOn(database.memory, "recall");
      await runtime.start();

      const first = await runtime.submit(webMessage("remember moonlight"));
      await settleDeliveries(database);
      const firstGraph = await database.information.query({
        informationId: first.rootInformationId,
      });
      const firstInbound = firstGraph.find(
        ({ kind }) => kind === inboundTextInformationKind.kind,
      )!;
      await database.memory.put({
        sourceInformationId: firstInbound.informationId,
        sourceKind: firstInbound.kind,
        content: "remember moonlight",
        occurredAt: firstInbound.occurredAt,
        address: {
          platform: "web",
          adapterId: "web.ui.main",
          platformMessageId: "request-1",
          accountId: "web",
          destination: { kind: "web" },
        },
      });

      const second = await runtime.submit({
        ...webMessage("moonlight again"),
        platformMessageId: "request-2",
        occurredAt: "2026-09-04T00:00:02.000Z",
      });
      await settleDeliveries(database);
      const secondGraph = await database.information.query({
        informationId: second.rootInformationId,
      });
      const association = secondGraph.find(
        ({ kind }) => kind === "agent.association.completed",
      );
      const requested = secondGraph.find(
        ({ kind, payload }) =>
          kind === modelTaskRequestedInformationKind.kind &&
          payload.taskId === "agent.message.compose",
      )!;
      const payload = modelTaskRequestedInformationKind.payloadSchema.parse(
        requested.payload,
      );

      expect(recall).not.toHaveBeenCalled();
      expect(association?.payload).toMatchObject({
        status: "unavailable",
        candidateCount: 0,
        reasonCodes: ["provider-unavailable"],
      });
      expect(
        secondGraph.some(({ kind }) => kind === "agent.association.candidate"),
      ).toBe(false);
      expect(payload.prompt.provenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variableName: "turn",
            informationIds: [
              secondGraph.find(
                ({ kind }) => kind === inboundTextInformationKind.kind,
              )!.informationId,
            ],
          }),
        ]),
      );
      expect(payload.prompt.provenance).toContainEqual(
        expect.objectContaining({
          variableName: "memory",
          informationIds: [],
        }),
      );
    },
    TEST_TIMEOUT,
  );

  it("does not expose the Memory capability while Memory is disabled", async () => {
    const create = vi.fn(() => ({ provisions: [], subscriptions: [] }));
    const consumer = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        summary: "Test information module.",
        moduleVersion: "1.0.0",
        definitionId: "test.memory.consumer",
        displayName: "Memory consumer",
        description: "Defines the Memory consumer information module.",
        settingsSchema: z.object({}).strict(),
        consumes: [],
        produces: [],
        selectors: [],
        promptRenderers: [],
        requires: [memoryCapability],
        provides: [],
      },
      create,
    });
    const database = await createTestingDatabase();
    const runtime = new KaguyaRuntime({
      database,
      catalog: defineInformationModuleCatalog(consumer),
      activations: [
        {
          instanceId: "memory.consumer",
          definitionId: consumer.manifest.definitionId,
          settings: {},
        },
      ],
      capabilities: [
        {
          capability: memoryCapability,
          value: database.memory,
        },
      ],
    });
    resources.push({ runtime, database });

    await expect(runtime.start()).rejects.toThrow(/capability/i);
    expect(create).not.toHaveBeenCalled();
  });

  it(
    "classifies schema preparation failures without retaining database details",
    async () => {
      const database = await createTestingDatabase();
      const secret = "postgresql://ledger:runtime-secret@db.internal/kaguya";
      vi.spyOn(database, "prepareSchema").mockRejectedValueOnce(
        new Error(`authentication failed: ${secret}`),
      );
      const runtime = new KaguyaRuntime({
        ...createMessageComposition(),
        database,
      });
      resources.push({ runtime, database });

      const error = await runtime.start().catch((thrown: unknown) => thrown);

      expect(error).toMatchObject({
        name: "RuntimeDatabaseInitializationError",
        message: "Runtime database initialization failed",
        failureType: "Error",
      });
      expect(error).not.toHaveProperty("cause");
      expect(`${String(error)}\n${JSON.stringify(error)}`).not.toContain(
        "runtime-secret",
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "does not preserve an unknown alphanumeric schema error class",
    async () => {
      class DatabasePassword123 extends Error {}
      const database = await createTestingDatabase();
      vi.spyOn(database, "prepareSchema").mockRejectedValueOnce(
        new DatabasePassword123("database-secret"),
      );
      const runtime = new KaguyaRuntime({
        ...createMessageComposition(),
        database,
      });
      resources.push({ runtime, database });

      const error = await runtime.start().catch((thrown: unknown) => thrown);

      expect(error).toMatchObject({
        name: "RuntimeDatabaseInitializationError",
        failureType: "Error",
      });
      expect(JSON.stringify(error)).not.toContain("DatabasePassword123");
      expect(JSON.stringify(error)).not.toContain("database-secret");
    },
    TEST_TIMEOUT,
  );

  it(
    "classifies schema errors whose reflective properties throw",
    async () => {
      const database = await createTestingDatabase();
      const malicious = new Error("database-message-secret");
      Object.defineProperties(malicious, {
        constructor: {
          get() {
            throw new Error("constructor-getter-secret");
          },
        },
        name: {
          get() {
            throw new Error("name-getter-secret");
          },
        },
      });
      vi.spyOn(database, "prepareSchema").mockRejectedValueOnce(malicious);
      const runtime = new KaguyaRuntime({
        ...createMessageComposition(),
        database,
      });
      resources.push({ runtime, database });

      const error = await runtime.start().catch((thrown: unknown) => thrown);

      expect(error).toMatchObject({
        name: "RuntimeDatabaseInitializationError",
        message: "Runtime database initialization failed",
        failureType: "Error",
      });
      expect(JSON.stringify(error)).not.toMatch(
        /getter-secret|message-secret/u,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "shares one setup promise across concurrent start calls",
    async () => {
      const { runtime, database } = await createGatedRuntime();

      const firstStart = runtime.start();
      await database.schemaPreparationStarted;
      const secondStart = runtime.start();

      expect(secondStart).toBe(firstStart);
      expect(database.prepareSchemaCalls).toBe(1);
      database.releaseSchemaPreparation();
      await Promise.all([firstStart, secondStart]);
      expect(database.prepareSchemaCalls).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects transport registration as soon as start begins",
    async () => {
      const { runtime, database } = await createGatedRuntime();
      const starting = runtime.start();
      await database.schemaPreparationStarted;

      expect(() =>
        runtime.registerTransport({
          adapterId: "late.web",
          platform: "web",
          transport: {
            sendMessage: async (target) => ({
              ok: true,
              adapterId: "late.web",
              platform: "web",
              target,
            }),
          },
        }),
      ).toThrow(RuntimeUnavailableError);

      database.releaseSchemaPreparation();
      await starting;
    },
    TEST_TIMEOUT,
  );

  it("propagates close abort to an in-progress module create", async () => {
    let markCreating!: () => void,
      release!: () => void,
      aborted = false;
    const creating = new Promise<void>((resolve) => {
      markCreating = resolve;
    });
    const fallback = new Promise<void>((resolve) => {
      release = resolve;
    });
    const module = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        summary: "Test information module.",
        moduleVersion: "1.0.0",
        definitionId: "test.abort",
        displayName: "Abort",
        description: "Defines the Abort information module.",
        settingsSchema: z.object({}),
        consumes: [],
        produces: [],
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
      },
      create: async (_options, context) => {
        markCreating();
        await Promise.race([
          fallback,
          new Promise<void>((resolve) =>
            context.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          ),
        ]);
        return { subscriptions: [], provisions: [] };
      },
    });
    const { runtime } = await createRuntime({
      catalog: defineInformationModuleCatalog(module),
      activations: [
        {
          instanceId: "abort.main",
          definitionId: module.manifest.definitionId,
          settings: {},
        },
      ],
    });
    const starting = runtime.start();
    void starting.catch(() => undefined);
    await creating;
    const closing = runtime.close();
    try {
      await vi.waitFor(() => expect(aborted).toBe(true));
    } finally {
      release();
      await starting.catch(() => undefined);
      await closing;
    }
  });

  it(
    "waits for starting work before closing resources exactly once",
    async () => {
      let markCreating!: () => void;
      let releaseCreation!: () => void;
      const creating = new Promise<void>((resolve) => {
        markCreating = resolve;
      });
      const creationGate = new Promise<void>((resolve) => {
        releaseCreation = resolve;
      });
      let disposeCalls = 0;
      const gatedModule = defineInformationModule({
        manifest: {
          protocolVersion: 1,
          summary: "Test information module.",
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.lifecycle.gated",
          displayName: "Gated lifecycle module",
          description: "Defines the Gated lifecycle module information module.",
          settingsSchema: z.object({}).strict(),
          consumes: [],
          produces: [],
        },
        create: async () => {
          markCreating();
          await creationGate;
          return {
            provisions: [],
            subscriptions: [],
            dispose: () => {
              disposeCalls += 1;
            },
          };
        },
      });
      const { runtime } = await createRuntime({
        catalog: defineInformationModuleCatalog(...[gatedModule]),
        activations: [
          {
            instanceId: "gated.one",
            definitionId: "test.lifecycle.gated",
            settings: {},
          },
        ],
      });

      const starting = runtime.start();
      await creating;
      let closeSettled = false;
      const closing = runtime.close().then(() => {
        closeSettled = true;
      });
      await flushMicrotasks();
      expect(closeSettled).toBe(false);

      releaseCreation();
      await expect(starting).rejects.toBeInstanceOf(RuntimeUnavailableError);
      await closing;
      expect(disposeCalls).toBe(1);
      await expect(runtime.submit(webMessage())).rejects.toBeInstanceOf(
        RuntimeUnavailableError,
      );
      await expect(runtime.start()).rejects.toBeInstanceOf(
        RuntimeUnavailableError,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "persists the complete default intent-target Web delivery DAG",
    async () => {
      const { runtime, database } = await createRuntime();
      const sendMessage = vi.fn<PlatformOutboundTransport["sendMessage"]>(
        async (target) => ({
          ok: true,
          adapterId: "web.ui.main",
          platform: "web",
          target,
          platformMessageId: "sent-1",
          raw: { credential: "receipt-raw-must-not-enter-ledger" },
        }),
      );
      runtime.registerTransport({
        adapterId: "web.ui.main",
        platform: "web",
        transport: { sendMessage },
      });
      await runtime.start();

      const result = await runtime.submit(webMessage("hello"));
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });
      expect(new Set(graph.map(({ kind }) => kind))).toEqual(
        new Set([
          "core.message.inbound.text",
          "agent.message.intent.requested",
          "agent.association.requested",
          "agent.association.query",
          "agent.association.completed",
          "core.model.task.requested",
          "core.model.task.completed",
          "core.message.assistant.text",
          "core.delivery.requested",
          "agent.chat.scope.entity",
          "agent.chat.scope.binding",
          "agent.person.resolution",
          "agent.person.context.completed",
          "agent.attention.arousal.completed",
          "agent.heartbeat.scheduled",
          "agent.turn.candidate",
          "agent.turn.claimed",
          "agent.turn.started",
          "agent.turn.context.completed",
          "agent.turn.plan.completed",
          "agent.turn.completed",
          "core.delivery.delivered",
        ]),
      );
      expect(result.deliveries).toEqual([]);
      expect(result).not.toHaveProperty("delivery");
      expect(sendMessage).toHaveBeenCalledWith(
        { kind: "web" },
        { kind: "text", text: "It is a lovely night for watching the moon." },
        { rootInformationId: result.rootInformationId },
      );

      const byKind = new Map(graph.map((atom) => [atom.kind, atom]));
      const chain = [
        ["agent.attention.arousal.completed", "agent.turn.context.completed"],
        ["agent.message.intent.requested", "agent.attention.arousal.completed"],
        ["core.model.task.requested", "agent.message.intent.requested"],
        ["core.model.task.completed", "core.model.task.requested"],
        ["core.message.assistant.text", "core.model.task.completed"],
        ["core.delivery.requested", "core.message.assistant.text"],
        ["core.delivery.delivered", "core.delivery.requested"],
      ] as const;
      for (const [childKind, parentKind] of chain) {
        expect(parentId(byKind.get(childKind)!)).toBe(
          byKind.get(parentKind)?.informationId,
        );
      }
      for (const atom of graph) {
        expect(
          atom.references.filter(({ relation }) => relation === "core:context"),
        ).toEqual([
          { relation: "core:context", informationId: result.rootInformationId },
        ]);
      }
      expect(JSON.stringify(graph)).not.toMatch(
        /raw-must-not-enter-ledger|receipt-raw-must-not-enter-ledger/,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "defers an ordinary group event and does not treat mentioning another user as attention",
    async () => {
      const { runtime, database } = await createRuntime();
      await runtime.start();

      const result = await runtime.submit({
        ...platformMessage(),
        text: "@445566 你好",
        mentions: [{ kind: "user", id: "445566" }],
      });
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });
      const arousal = graph.find(
        ({ kind }) => kind === "agent.attention.arousal.completed",
      );

      expect(arousal?.payload).toMatchObject({
        outcome: "defer",
        score: 50,
        attempt: 0,
        totalWaitBudget: 3,
      });
      expect(graph.map(({ kind }) => kind)).toContain("agent.wait.requested");
      expect(graph.map(({ kind }) => kind)).not.toContain(
        "agent.message.intent.requested",
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "does not derive assistant or delivery facts when generation fails",
    async () => {
      const sendMessage = vi.fn<PlatformOutboundTransport["sendMessage"]>(
        async (target) => ({
          ok: true,
          adapterId: "web.ui.main",
          platform: "web",
          target,
        }),
      );
      const { runtime, database } = await createRuntime({
        resolveModelSelection: () => ({
          providerId: "test",
          modelId: "invalid-output-model",
          model: createRepeatingDeterministicModel({ text: "" }),
        }),
      });
      runtime.registerTransport({
        adapterId: "web.ui.main",
        platform: "web",
        transport: { sendMessage },
      });
      await runtime.start();

      const result = await runtime.submit(webMessage());
      await settleDeliveries(database);
      const kinds = (
        await database.information.query({
          informationId: result.rootInformationId,
        })
      ).map(({ kind }) => kind);

      expect(kinds).toEqual(
        expect.arrayContaining([
          "core.model.task.requested",
          "core.model.task.failed",
          "agent.turn.silent",
        ]),
      );
      for (const forbiddenKind of [
        "core.message.assistant.text",
        "core.delivery.requested",
        "core.delivery.delivered",
        "core.delivery.failed",
      ]) {
        expect(kinds).not.toContain(forbiddenKind);
      }
      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.deliveries).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "shares one model task while each composer delivers to the intent target",
    async () => {
      const { runtime, database } = await createRuntime({
        activations: [
          ...createMessageComposition().activations.filter(
            (a) => a.definitionId !== "agent.message-composer",
          ),
          ...["message-composer.one", "message-composer.two"].map(
            (instanceId) => ({
              instanceId,
              definitionId: "agent.message-composer",
              settings: { modelTier: "heavy" as const },
            }),
          ),
        ],
      });
      const sendMessage = vi.fn<PlatformOutboundTransport["sendMessage"]>(
        async (target) => ({
          ok: true,
          adapterId: "web.ui.main",
          platform: "web",
          target,
        }),
      );
      runtime.registerTransport({
        adapterId: "web.ui.main",
        platform: "web",
        transport: { sendMessage },
      });
      await runtime.start();

      const result = await runtime.submit(webMessage());
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });
      const count = (kind: string) =>
        graph.filter((atom) => atom.kind === kind).length;

      expect(count("core.model.task.completed")).toBe(2);
      expect(
        graph
          .filter((atom) => atom.kind === "core.model.task.completed")
          .map((atom) => atom.payload.taskId)
          .sort(),
      ).toEqual(["agent.message.compose", "agent.turn.plan"]);
      expect(count("core.message.assistant.text")).toBe(2);
      expect(count("core.delivery.requested")).toBe(2);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls.map(([target]) => target)).toEqual([
        { kind: "web" },
        { kind: "web" },
      ]);
      expect(
        graph
          .filter((atom) => atom.kind === "core.message.assistant.text")
          .map(({ payload }) => payload.originatingModuleInstanceId)
          .sort(),
      ).toEqual(["message-composer.one", "message-composer.two"]);
    },
    TEST_TIMEOUT,
  );

  it(
    "encodes the default QQ composer delivery as a text-only OneBot action",
    async () => {
      const { runtime, database } = await createRuntime();
      const actions: ReturnType<typeof buildOneBotSendAction>[] = [];
      runtime.registerTransport({
        adapterId: "napcat.qq.main",
        platform: "qq",
        transport: {
          sendMessage: async (target, content) => {
            actions.push(buildOneBotSendAction(target, content, "test-echo"));
            return {
              ok: true,
              adapterId: "napcat.qq.main",
              platform: "qq",
              target,
            };
          },
        },
      });
      await runtime.start();
      await runtime.submit(platformMessage());
      await settleDeliveries(database);
      expect(actions).toEqual([
        {
          action: "send_group_msg",
          echo: "test-echo",
          params: {
            group_id: 778899,
            message: [
              {
                type: "text",
                data: { text: "It is a lovely night for watching the moon." },
              },
            ],
          },
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    "records a missing transport as a durable delivery failure",
    async () => {
      const { runtime, database } = await createRuntime();
      await runtime.start();

      const result = await runtime.submit(platformMessage("missing.qq"));
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });

      expect(result.deliveries).toEqual([]);
      expect(graph.map(({ kind }) => kind)).toContain("core.delivery.failed");
      expect(graph.map(({ kind }) => kind)).toContain("agent.turn.failed");
      expect(graph.map(({ kind }) => kind)).not.toContain("consumer.failed");
      const failed = graph.find(({ kind }) => kind === "core.delivery.failed")!;
      const requested = graph.find(
        ({ kind }) => kind === "core.delivery.requested",
      )!;
      expect(failed.payload).toMatchObject({
        ok: false,
        error: "Outbound transport is not registered",
      });
      expect(parentId(failed)).toBe(requested.informationId);
      expect(parentId(failed, "core:status-of")).toBe(requested.informationId);
      expect(new OutboundTransportNotFoundError("a", "qq").message).toContain(
        "not registered",
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "records a rejected transport without persisting provider details",
    async () => {
      const { runtime, database } = await createRuntime();
      runtime.registerTransport({
        adapterId: "napcat.qq.main",
        platform: "qq",
        transport: {
          sendMessage: () =>
            Promise.reject(new Error("provider-token-must-not-enter-ledger")),
        },
      });
      await runtime.start();

      const result = await runtime.submit(platformMessage());
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });

      expect(result.deliveries).toEqual([]);
      expect(graph.map(({ kind }) => kind)).toContain("core.delivery.failed");
      expect(graph.map(({ kind }) => kind)).toContain("agent.turn.failed");
      expect(graph.map(({ kind }) => kind)).not.toContain("consumer.failed");
      expect(JSON.stringify(graph)).not.toContain(
        "provider-token-must-not-enter-ledger",
      );
      expect(
        new OutboundTransportError("adapter", "qq", new Error()).message,
      ).toContain("Outbound transport failed");
    },
    TEST_TIMEOUT,
  );

  it(
    "records a platform failure after returning an acceptance receipt",
    async () => {
      const receipt: PlatformDeliveryReceipt = {
        ok: false,
        adapterId: "napcat.qq.main",
        platform: "qq",
        target: { kind: "group", groupId: "778899" },
        error: "provider-specific failure",
        raw: { credential: "failed-receipt-raw" },
      };
      const { runtime, database } = await createRuntime();
      runtime.registerTransport({
        adapterId: "napcat.qq.main",
        platform: "qq",
        transport: { sendMessage: () => Promise.resolve(receipt) },
      });
      await runtime.start();

      const result = await runtime.submit(platformMessage());
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });

      expect(result.deliveries).toEqual([]);
      expect(graph.map(({ kind }) => kind)).toContain("core.delivery.failed");
      expect(graph.map(({ kind }) => kind)).toContain("agent.turn.failed");
      expect(graph.map(({ kind }) => kind)).not.toContain("consumer.failed");
      expect(JSON.stringify(graph)).not.toMatch(
        /provider-specific failure|failed-receipt-raw/,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps an inbound atom when its kind has no subscribers",
    async () => {
      const { runtime, database } = await createRuntime({
        catalog: defineInformationModuleCatalog(...[]),
        activations: [],
      });
      await runtime.start();

      const result = await runtime.submit(webMessage());
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });

      expect(graph.map(({ kind }) => kind)).toEqual([
        "core.message.inbound.text",
      ]);
      expect(result.deliveries).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    "starts two reply consumers concurrently",
    async () => {
      let starts = 0;
      let markBothStarted!: () => void;
      let release!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        markBothStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observer = defineInformationModule({
        manifest: {
          protocolVersion: 1,
          summary: "Test information module.",
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.reply.observer",
          displayName: "Concurrent reply observer",
          description:
            "Defines the Concurrent reply observer information module.",
          settingsSchema: z.object({}).strict(),
          consumes: [attentionArousalCompletedInformationKind],
          produces: [attentionArousalCompletedInformationKind],
        },
        create: () => ({
          provisions: [],
          subscriptions: [
            onInformation(
              attentionArousalCompletedInformationKind,
              {
                subscriptionId: "handle-replyrequestedinformationkind",
                delivery: "live",
              },
              async () => {
                starts += 1;
                if (starts === 2) markBothStarted();
                await gate;
              },
            ),
          ],
        }),
      });
      const { runtime } = await createRuntime({
        catalog: defineInformationModuleCatalog(
          ...createMessageComposition().catalog.definitions,
          observer,
        ),
        activations: [
          ...createMessageComposition().activations.filter(
            (a) => a.definitionId !== "agent.message-composer",
          ),
          {
            instanceId: "observer.one",
            definitionId: "test.reply.observer",
            settings: {},
          },
          {
            instanceId: "observer.two",
            definitionId: "test.reply.observer",
            settings: {},
          },
        ],
      });
      await runtime.start();

      const submission = runtime.submit(webMessage());
      await bothStarted;
      expect(starts).toBe(2);
      release();
      await submission;
    },
    TEST_TIMEOUT,
  );

  it(
    "waits for in-flight ingress and rejects new ingress while closing",
    async () => {
      const deferred = createDeferredDeterministicModel({ text: "done" });
      const { runtime, database } = await createRuntime({
        resolveModelSelection: ({ modelTier }) => ({
          providerId: "test",
          modelId: `deferred-${modelTier}`,
          model: deferred.model,
        }),
      });
      await runtime.start();
      const submission = runtime.submit(platformMessage());
      await deferred.started;

      let closed = false;
      const close = runtime.close().then(() => {
        closed = true;
      });
      await expect(runtime.submit(platformMessage())).rejects.toBeInstanceOf(
        RuntimeUnavailableError,
      );
      await Promise.resolve();
      expect(closed).toBe(false);
      deferred.release();
      const result = await submission;
      await close;

      expect(
        (
          await database.information.query({
            informationId: result.rootInformationId,
          })
        ).map(({ kind }) => kind),
      ).not.toContain("core.model.task.completed");
      expect(
        (await database.information.reliable.health()).pending,
      ).toBeGreaterThan(0);
      await expect(runtime.submit(webMessage())).rejects.toBeInstanceOf(
        RuntimeUnavailableError,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps another consumer result when one consumer fails",
    async () => {
      const outcomeKind = defineInformationKind({
        kind: "test.inbound.observed",
        displayName: "Test Inbound Observed",
        description: "Information carried by the test.inbound.observed kind.",
        payloadSchema: z.object({ observed: z.literal(true) }).strict(),
        references: {
          "core:caused-by": {
            required: true,
            multiple: false,
            targetKinds: [inboundTextInformationKind.kind],
          },
          "core:context": {
            required: true,
            multiple: false,
            targetKinds: ["core.runtime.context"],
          },
        },
        log: { enabled: false },
      });
      const failing = defineInformationModule({
        manifest: {
          protocolVersion: 1,
          summary: "Test information module.",
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.inbound.failing",
          displayName: "Failing inbound consumer",
          description:
            "Defines the Failing inbound consumer information module.",
          settingsSchema: z.object({}).strict(),
          consumes: [inboundTextInformationKind],
          produces: [inboundTextInformationKind],
        },
        create: () => ({
          provisions: [],
          subscriptions: [
            onInformation(
              inboundTextInformationKind,
              {
                subscriptionId: "handle-inboundtextinformationkind",
                delivery: "live",
              },
              () => {
                throw new TypeError("credential-must-not-enter-ledger");
              },
            ),
          ],
        }),
      });
      const successful = defineInformationModule({
        manifest: {
          protocolVersion: 1,
          summary: "Test information module.",
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.inbound.successful",
          displayName: "Successful inbound consumer",
          description:
            "Defines the Successful inbound consumer information module.",
          settingsSchema: z.object({}).strict(),
          consumes: [inboundTextInformationKind, outcomeKind],
          produces: [inboundTextInformationKind, outcomeKind],
        },
        create: () => ({
          provisions: [],
          subscriptions: [
            onInformation(
              inboundTextInformationKind,
              {
                subscriptionId: "handle-inboundtextinformationkind",
                delivery: "live",
              },
              async (_atom, context) => {
                await context.register(outcomeKind, {
                  payload: { observed: true },
                });
              },
            ),
          ],
        }),
      });
      const { runtime, database } = await createRuntime({
        catalog: defineInformationModuleCatalog(...[failing, successful]),
        activations: [
          {
            instanceId: "failure.one",
            definitionId: "test.inbound.failing",
            settings: {},
          },
          {
            instanceId: "success.one",
            definitionId: "test.inbound.successful",
            settings: {},
          },
        ],
      });
      await runtime.start();

      const result = await runtime.submit(webMessage());
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });

      expect(graph.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining([
          "core.message.inbound.text",
          "test.inbound.observed",
          "consumer.failed",
        ]),
      );
      expect(
        graph.find(({ kind }) => kind === "consumer.failed")?.payload,
      ).toMatchObject({
        consumer: {
          consumerId: "module:failure.one:handle-inboundtextinformationkind",
          definitionId: "test.inbound.failing",
          instanceId: "failure.one",
        },
        error: { errorType: "Error", message: "Consumer handler failed" },
      });
      expect(JSON.stringify(graph)).not.toContain(
        "credential-must-not-enter-ledger",
      );
    },
    TEST_TIMEOUT,
  );
});

type RuntimeModelSelectionResolver = (selection: ModuleModelSelection) => {
  readonly providerId: string;
  readonly modelId: string;
  readonly model: ReturnType<KaguyaLlmModelResolver>;
};
function createDeterministicModelSelectionResolver(): RuntimeModelSelectionResolver {
  const model = createPlanningDeterministicModel(
    "It is a lovely night for watching the moon.",
  );
  return ({ modelTier }) => ({
    providerId: "test",
    modelId: `deterministic-${modelTier}`,
    model,
  });
}
function createMessageComposition(
  resolveModelSelection: RuntimeModelSelectionResolver = createDeterministicModelSelectionResolver(),
  providedActivations?: readonly InformationModuleActivation[],
) {
  const catalog = createFirstPartyModuleCatalog({
    modelTaskCapability,
    modelTaskCompletedInformationKind,
    modelTaskFailedInformationKind,
    modelTaskCancelledInformationKind,
    deliveryDeliveredInformationKind,
    deliveryFailedInformationKind,
    executionExhaustedInformationKind,
    promptTemplates: testMessageTemplates,
    agentIdentity: testIdentity,
  });
  const activations =
    providedActivations ??
    createFirstPartyModuleActivations(
      catalog,
      createFirstPartyModuleConfigDefaults("test"),
    );
  const models = new Map<string, ReturnType<KaguyaLlmModelResolver>>();
  return {
    catalog,
    activations,
    capabilities: ({ oneShotSchedule }: RuntimeCapabilityContext) => [
      { capability: oneShotScheduleCapability, value: oneShotSchedule },
    ],
    modelTask: {
      approvals: activations
        .filter((a) =>
          ["agent.message-composer", "agent.heartflow.online"].includes(
            a.definitionId,
          ),
        )
        .map((a) => ({
          activation: {
            instanceId: a.instanceId,
            definitionId: a.definitionId,
          },
          selectionPolicy: {
            tier:
              a.definitionId === "agent.heartflow.online"
                ? "light"
                : z
                    .object({ modelTier: z.enum(["light", "heavy"]) })
                    .parse(a.settings).modelTier,
          },
        })),
      client: new KaguyaLlmClient({
        resolveModel: ({ modelId }) => {
          const model = models.get(modelId);
          if (!model) throw new Error("Unapproved model");
          return model;
        },
      }),
      resolveModel: ({ tier }: { tier: "light" | "heavy" }) => {
        const resolved = resolveModelSelection({ modelTier: tier });
        models.set(resolved.modelId, resolved.model);
        return {
          providerId: resolved.providerId,
          modelId: resolved.modelId,
        };
      },
    },
  };
}

it(
  "bounds shutdown while a live ingress observer ignores cancellation",
  async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const observer = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        summary: "Test information module.",
        moduleVersion: "1.0.0",
        definitionId: "test.hanging-ingress",
        displayName: "Hanging ingress",
        description: "Defines the Hanging ingress information module.",
        settingsSchema: z.object({}),
        consumes: [inboundTextInformationKind],
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
            inboundTextInformationKind,
            { subscriptionId: "observe", delivery: "live" },
            async () => {
              entered();
              await gate;
            },
          ),
        ],
      }),
    });
    const { runtime } = await createRuntime({
      catalog: defineInformationModuleCatalog(observer),
      activations: [
        {
          instanceId: "observer",
          definitionId: "test.hanging-ingress",
          settings: {},
        },
      ],
      drainTimeoutMs: 20,
    });
    await runtime.start();
    const submitting = runtime.submit(webMessage());
    await started;
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), {
        timeout: 400,
        interval: 10,
      });
      await expect(runtime.submit(webMessage())).rejects.toThrow(
        RuntimeUnavailableError,
      );
    } finally {
      release();
      await Promise.allSettled([submitting, closing]);
    }
  },
  TEST_TIMEOUT,
);

it.each([
  [
    "private",
    {
      ...platformMessage(),
      target: { kind: "private" as const, userId: "112233" },
      mentions: [],
    },
  ],
  ["mention", platformMessage()],
  [
    "reply",
    {
      ...platformMessage(),
      mentions: [],
      replyTo: { platformMessageId: "bot-message", senderId: "998877" },
    },
  ],
])(
  "allows Planner silence for QQ %s without Composer or delivery",
  async (_name, input) => {
    const model = createPlanningDeterministicModel("must not be composed", {
      action: "silent",
      reason: "no-response-needed",
    });
    const { runtime, database } = await createRuntime({
      resolveModelSelection: () => ({
        providerId: "test",
        modelId: "silent-planner",
        model,
      }),
    });
    await runtime.start();
    const result = await runtime.submit(input);
    await settleDeliveries(database);
    const graph = await database.information.query({
      informationId: result.rootInformationId,
    });
    expect(
      graph.find((atom) => atom.kind === "agent.attention.arousal.completed")
        ?.payload.outcome,
    ).toBe("attend");
    expect(
      graph.find((atom) => atom.kind === "agent.turn.silent")?.payload
        .reasonCodes,
    ).toEqual(["no-response-needed"]);
    expect(
      graph
        .filter((atom) => atom.kind === "core.model.task.requested")
        .map((atom) => atom.payload.taskId),
    ).toEqual(["agent.turn.plan"]);
    expect(
      graph.some((atom) =>
        [
          "core.message.assistant.text",
          "core.delivery.requested",
          "agent.turn.failed",
        ].includes(atom.kind),
      ),
    ).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(1);
  },
  TEST_TIMEOUT,
);

it("recovers Planner waits after restart, merges new input and exhausts the shared budget", async () => {
  const model = createPlanningDeterministicModel("must not be composed", {
    action: "wait",
    reason: "await-more-context",
    waitSeconds: 5,
  });
  const resolver: RuntimeModelSelectionResolver = () => ({
    providerId: "test",
    modelId: "wait-planner",
    model,
  });
  let currentTime = new Date("2026-09-04T00:00:01.000Z");
  const { runtime: firstRuntime, database } = await createRuntime({
    resolveModelSelection: resolver,
    now: () => currentTime,
  });
  let runtime = firstRuntime;
  await runtime.start();
  await runtime.submit(webMessage("FIRST_WAIT_INPUT"));
  await settleDeliveries(database);
  const all = () =>
    database.information.find({
      occurredAfter: "2026-09-03T00:00:00.000Z",
      order: "asc",
      limit: 1000,
    });
  expect(
    (await all()).find((atom) => atom.kind === "agent.wait.requested")?.payload,
  ).toMatchObject({ attempt: 1, wakeOnMessage: true });
  await runtime.close();
  currentTime = new Date("2026-09-04T00:00:02.000Z");
  let sequence = 0;
  runtime = new KaguyaRuntime({
    ...createMessageComposition(resolver),
    database,
    now: () => currentTime,
    informationIdGenerator: () => `restarted-planner-${++sequence}`,
  });
  resources.find((resource) => resource.runtime === firstRuntime)!.runtime =
    runtime;
  await runtime.start();
  await runtime.submit({
    ...webMessage("MERGED_WAIT_INPUT"),
    platformMessageId: "merged",
    occurredAt: currentTime.toISOString(),
  });
  await settleDeliveries(database);
  expect(
    (await all())
      .filter((atom) => atom.kind === "agent.wait.requested")
      .map((atom) => atom.payload.attempt),
  ).toEqual([1, 2]);
  const latestTurn = (await all())
    .filter((atom) => atom.kind === "agent.turn.context.completed")
    .at(-1)!;
  expect(
    (latestTurn.payload.inputs as any[]).map((input) => input.text),
  ).toEqual(["FIRST_WAIT_INPUT", "MERGED_WAIT_INPUT"]);
  // 跨越持久化 dueAt 后重建 Runtime，验证恢复器推进而非测试手工发布 candidate。
  for (const timestamp of [
    "2026-09-04T00:00:08.000Z",
    "2026-09-04T00:00:14.000Z",
  ]) {
    await runtime.close();
    currentTime = new Date(timestamp);
    const previous = runtime;
    runtime = new KaguyaRuntime({
      ...createMessageComposition(resolver),
      database,
      now: () => currentTime,
      informationIdGenerator: () => `restarted-planner-${++sequence}`,
    });
    resources.find((resource) => resource.runtime === previous)!.runtime =
      runtime;
    await runtime.start();
    await settleDeliveries(database);
  }
  const graph = await all();
  expect(
    graph
      .filter((atom) => atom.kind === "agent.wait.requested")
      .map((atom) => atom.payload.attempt),
  ).toEqual([1, 2, 3]);
  expect(
    graph.find((atom) => atom.kind === "agent.turn.silent")?.payload
      .reasonCodes,
  ).toEqual(["wait-budget-exhausted"]);
  expect(
    graph.some((atom) =>
      [
        "core.message.assistant.text",
        "core.delivery.requested",
        "agent.turn.failed",
      ].includes(atom.kind),
    ),
  ).toBe(false);
  expect(model.doGenerateCalls).toHaveLength(4);
}, 30000);
