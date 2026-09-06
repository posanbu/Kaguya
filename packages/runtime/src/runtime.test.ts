/**
 * 功能概述：用真实 PGlite、Core 和 ModuleHost 验证 `KaguyaRuntime` 的完整信息 DAG。
 * 主要职责：覆盖 Web 入站到投递成功的直接因果链、生成失败不会继续 assistant/outbound/delivery、
 * 三类 transport 失败、无订阅持久化、同 kind 消费并发与多 reply activation 共享模型任务后
 * 各自产生正确 outbound、start/close 确定性交错、
 * in-flight 关闭、关闭后 ingress 拒绝、数据库初始化错误固定分类及抛出型反射属性，
 * 以及消费者失败与其他结果并存；默认 reply Prompt 必须带原子 provenance 和有序
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
  firstPartyModuleActivations,
  type ModuleModelSelection,
} from "@kaguya/modules";
import {
  ModelTaskClient,
  modelTaskCapability,
  type ModelTaskCapability,
} from "./model-task.js";
import {
  modelTaskCompletedInformationKind,
  modelTaskRequestedInformationKind,
} from "./information-kinds.js";
import { defineInformationModuleCatalog } from "@kaguya/sdk";
import { KaguyaDatabase } from "@kaguya/database";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  createDeferredDeterministicModel,
  createRepeatingDeterministicModel,
} from "@kaguya/llm/testing";
import {
  alwaysReplyFilterModule,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  speechDecisionInformationKind,
} from "@kaguya/modules";
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
} from "@kaguya/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KaguyaRuntime,
  OutboundTransportError,
  OutboundTransportNotFoundError,
  RuntimeUnavailableError,
} from "./runtime.js";

const TEST_TIMEOUT = 15_000;
const resources: Array<{
  runtime?: KaguyaRuntime;
  database: Awaited<ReturnType<typeof createTestingDatabase>>;
}> = [];

class GatedMigrationDatabase extends KaguyaDatabase {
  readonly migrationStarted: Promise<void>;
  migrateCalls = 0;
  readonly #markMigrationStarted: () => void;
  readonly #migrationGate: Promise<void>;
  readonly #releaseMigration: () => void;

  constructor(sql: ConstructorParameters<typeof KaguyaDatabase>[0]) {
    super(sql);
    let markMigrationStarted!: () => void;
    let releaseMigration!: () => void;
    this.migrationStarted = new Promise<void>((resolve) => {
      markMigrationStarted = resolve;
    });
    this.#migrationGate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    this.#markMigrationStarted = markMigrationStarted;
    this.#releaseMigration = releaseMigration;
  }

  override async migrate(): Promise<void> {
    this.migrateCalls += 1;
    this.#markMigrationStarted();
    await this.#migrationGate;
    await super.migrate();
  }

  releaseMigration(): void {
    this.#releaseMigration();
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
    mentions: [],
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
  }> = {},
) {
  const database = await createTestingDatabase();
  let id = 0;
  const runtime = new KaguyaRuntime({
    ...createReplyComposition(),
    database,
    now: () => new Date("2026-09-04T00:00:01.000Z"),
    informationIdGenerator: () => `runtime-atom-${++id}`,
    ...createReplyComposition(
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
  const database = new GatedMigrationDatabase(base.sql);
  const runtime = new KaguyaRuntime({
    ...createReplyComposition(),
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
  it("starts with the migrated generic completion subscription already persisted", async () => {
    const { runtime, database } = await createRuntime();
    await database.migrate();
    await database.information.synchronizeKinds(["core.model.task.completed"]);
    await database.information.reliable.configureSubscriptions([
      {
        subscriptionId: "reply.default:kaguya.reply.model-task-completed",
        kind: "core.model.task.completed",
      },
    ]);
    await expect(runtime.start()).resolves.toBeUndefined();
  });
  it.each(["missing", "invalid-value", "invalid-version"] as const)(
    "rejects %s model capability before module create",
    async (mode) => {
      const base = createReplyComposition().catalog.definitions.find(
        (d) => d.manifest.definitionId === "demo.reply.llm",
      )!;
      const create = vi.fn(base.create);
      const definition = defineInformationModule({ ...base, create });
      const database = await createTestingDatabase();
      const runtime = new KaguyaRuntime({
        database,
        catalog: defineInformationModuleCatalog(definition),
        activations: [firstPartyModuleActivations[0]!],
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
    const base = createReplyComposition().catalog.definitions.find(
      (d) => d.manifest.definitionId === "demo.reply.llm",
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
      activations: [firstPartyModuleActivations[0]!],
    });
    await runtime.start();
    expect(value).toBeInstanceOf(ModelTaskClient);
    expect(activation).toEqual({
      instanceId: "reply.default",
      definitionId: "demo.reply.llm",
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
        activation: { instanceId: "forged", definitionId: "demo.reply.llm" },
        selectionPolicy: { tier: "heavy" as const },
      },
      {
        activation: {
          instanceId: "reply.default",
          definitionId: "demo.reply.llm",
        },
        selectionPolicy: { tier: "light" as const },
      },
    ]) {
      await expect(
        value!.execute({
          ...request,
          task: {
            taskId: "core.reply.generate",
            version: "1",
            allowedTiers: ["light", "heavy"],
            outputSchema: z.object({ text: z.string() }).strict(),
          },
          sourceInformationId: "source",
          contextInformationId: "context",
          contextAtoms: [],
          prompt: { kind: "reply", text: "", fragments: [], provenance: [] },
        }),
      ).rejects.toThrow(/not approved/);
    }
  });

  it(
    "traces default reply Prompt to the selected current input",
    async () => {
      const { runtime, database } = await createRuntime();
      await runtime.start();

      const result = await runtime.submit(webMessage("hello"));
      await settleDeliveries(database);
      const graph = await database.information.query({
        informationId: result.rootInformationId,
      });
      const reply = graph.find(({ kind }) => kind === "core.reply.requested")!;
      const requested = graph.find(
        ({ kind }) => kind === "core.model.task.requested",
      )!;

      expect(
        requested.references.filter(
          ({ relation }) => relation === "core:uses-context",
        ),
      ).toEqual([
        {
          relation: "core:uses-context",
          informationId: reply.informationId,
        },
      ]);
      const requestedPayload =
        modelTaskRequestedInformationKind.payloadSchema.parse(
          requested.payload,
        );
      expect(requestedPayload).toMatchObject({
        taskId: "core.reply.generate",
        version: "1",
        sourceInformationId: reply.informationId,
        activation: {
          instanceId: "reply.default",
          definitionId: "demo.reply.llm",
        },
        selectionPolicy: { tier: "heavy" },
        resolvedModel: { providerId: "test", modelId: "deterministic-heavy" },
      });
      expect(graph.some((a) => a.kind.startsWith("core.llm."))).toBe(false);
      expect(requestedPayload.prompt.provenance).toMatchObject([
        { informationId: reply.informationId, source: "history" },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    "classifies migration failures without retaining database details",
    async () => {
      const database = await createTestingDatabase();
      const secret = "postgresql://ledger:runtime-secret@db.internal/kaguya";
      vi.spyOn(database, "migrate").mockRejectedValueOnce(
        new Error(`authentication failed: ${secret}`),
      );
      const runtime = new KaguyaRuntime({
        ...createReplyComposition(),
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
    "does not preserve an unknown alphanumeric migration error class",
    async () => {
      class DatabasePassword123 extends Error {}
      const database = await createTestingDatabase();
      vi.spyOn(database, "migrate").mockRejectedValueOnce(
        new DatabasePassword123("database-secret"),
      );
      const runtime = new KaguyaRuntime({
        ...createReplyComposition(),
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
    "classifies migration errors whose reflective properties throw",
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
      vi.spyOn(database, "migrate").mockRejectedValueOnce(malicious);
      const runtime = new KaguyaRuntime({
        ...createReplyComposition(),
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
      await database.migrationStarted;
      const secondStart = runtime.start();

      expect(secondStart).toBe(firstStart);
      expect(database.migrateCalls).toBe(1);
      database.releaseMigration();
      await Promise.all([firstStart, secondStart]);
      expect(database.migrateCalls).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects transport registration as soon as start begins",
    async () => {
      const { runtime, database } = await createGatedRuntime();
      const starting = runtime.start();
      await database.migrationStarted;

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

      database.releaseMigration();
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
        moduleVersion: "1.0.0",
        definitionId: "test.abort",
        displayName: "Abort",
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
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.lifecycle.gated",
          displayName: "Gated lifecycle module",
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
    "persists the complete default source-mode Web delivery DAG",
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
          "core.reply.requested",
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
          "agent.speech.decision",
          "agent.turn.context.completed",
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
        ["agent.speech.decision", "agent.turn.context.completed"],
        ["core.reply.requested", "agent.speech.decision"],
        ["core.model.task.requested", "core.reply.requested"],
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
    "shares one model task while each reply activation delivers through its own outbound",
    async () => {
      const { runtime, database } = await createRuntime({
        activations: [
          ...firstPartyModuleActivations.filter((a) => a.definitionId !== "demo.reply.llm"),
          ...[
            ["reply.one", "room-one"],
            ["reply.two", "room-two"],
          ].map(([instanceId, groupId]) => ({
            instanceId: instanceId!,
            definitionId: "demo.reply.llm",
            settings: {
              modelTier: "heavy" as const,
              outbound: {
                mode: "fixed" as const,
                adapterId: "web.ui.main",
                platform: "web",
                destination: { kind: "group" as const, groupId: groupId! },
              },
            },
          })),
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

      expect(count("core.model.task.completed")).toBe(1);
      expect(count("core.message.assistant.text")).toBe(2);
      expect(count("core.delivery.requested")).toBe(2);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage.mock.calls.map(([target]) => target)).toEqual(
        expect.arrayContaining([
          { kind: "group", groupId: "room-one" },
          { kind: "group", groupId: "room-two" },
        ]),
      );
      expect(
        graph
          .filter((atom) => atom.kind === "core.message.assistant.text")
          .map(({ payload }) => payload.originatingModuleInstanceId)
          .sort(),
      ).toEqual(["reply.one", "reply.two"]);
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
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.reply.observer",
          displayName: "Concurrent reply observer",
          settingsSchema: z.object({}).strict(),
          consumes: [speechDecisionInformationKind],
          produces: [speechDecisionInformationKind],
        },
        create: () => ({
          provisions: [],
          subscriptions: [
            onInformation(
              speechDecisionInformationKind,
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
          ...createReplyComposition().catalog.definitions,
          observer,
        ),
        activations: [
          ...firstPartyModuleActivations.filter((a) => a.definitionId !== "demo.reply.llm"),
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
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.inbound.failing",
          displayName: "Failing inbound consumer",
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
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "test.inbound.successful",
          displayName: "Successful inbound consumer",
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
  const model = createRepeatingDeterministicModel({
    text: "It is a lovely night for watching the moon.",
  });
  return ({ modelTier }) => ({
    providerId: "test",
    modelId: `deterministic-${modelTier}`,
    model,
  });
}
function createReplyComposition(
  resolveModelSelection: RuntimeModelSelectionResolver = createDeterministicModelSelectionResolver(),
  activations = firstPartyModuleActivations,
) {
  const catalog = createFirstPartyModuleCatalog({
    modelTaskCapability,
    modelTaskCompletedInformationKind,
  });
  const models = new Map<string, ReturnType<KaguyaLlmModelResolver>>();
  return {
    catalog,
    activations,
    modelTask: {
      approvals: activations
        .filter((a) => a.definitionId === "demo.reply.llm")
        .map((a) => ({
          activation: {
            instanceId: a.instanceId,
            definitionId: a.definitionId,
          },
          selectionPolicy: {
            tier: z
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
        moduleVersion: "1.0.0",
        definitionId: "test.hanging-ingress",
        displayName: "Hanging ingress",
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
