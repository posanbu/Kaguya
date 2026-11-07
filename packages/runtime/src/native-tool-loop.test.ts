/**
 * 用 receipt 提交后、下一步 freeze 前的故障边界核验原点/模型冻结；重启换配置后不新建 run 或重复效果。
 * 功能概述：用真实 Core、ModelTaskClient、W3 及两种数据库验证原生工具循环持久窗口。
 * fixture 固定 observation 与 Memory，上游模型为合成单步生成器；外部效果由受控 provider 计数。
 * Memory 历史跨两页保留修订及上界；重启重放核对同一发布、工具输出和外部效果，不重复写入。
 * 同一用例检查实际 requested、dispatch、call→intent→receipt、下一步 messages 与停止状态；
 * 原生消息与调用清单不一致时验证行动未登记；历史恢复整批审计指针、参数和回执，先拒绝异常再执行副作用。
 * 裁剪验证工具名及消息角色，数据库故障注入模拟旧记录异常且保留准确效果次数。
 * barrier 控制取消/重启窗口；恢复复用持久证据，清理释放所有后台任务后关闭 Core 和数据库。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
} from "@kaguya/database/testing";
import { actionDigest, KaguyaDatabase } from "@kaguya/database";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { createNativeMemoryAccess } from "@kaguya/memory";
import { createStructuredOutputPromptRenderer } from "@kaguya/llm";
import {
  z,
  freezeInformationAtom,
  informationAtomSchema,
  type NativeToolCall,
} from "@kaguya/schema";
import {
  defineInformationKind,
  nativeToolInformationKinds,
  actionDecisionInformationKind,
  type ActionProvider,
  type ActionOutcome,
} from "@kaguya/sdk";
import {
  modelTaskInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import { ModelTaskClient, type ModelTaskRequest } from "./model-task.js";
import {
  NativeToolLoop,
  nativeToolWireName,
  fitToolTranscript,
  fitToolTranscriptWithMetadata,
  type NativeToolRegistration,
} from "./native-tool-loop.js";
import { createNativeMemoryTools } from "./native-memory-tools.js";
import { ActionExecutor } from "./action.js";
import { GuiTaskService } from "./gui-tasks.js";
import { guiTaskRequestedKind, guiTaskTerminalKind } from "./gui-task-kinds.js";
const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const backends = [false, ...(url ? [true] : [])];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (e) {
      errors.push(e);
    }
  vi.restoreAllMocks();
  if (errors.length)
    throw new AggregateError(errors, "Native loop cleanup failed");
});
const sourceKind = defineInformationKind({
  kind: "test.native.source",
  displayName: "原生测试来源",
  description: "宿主持久来源",
  payloadSchema: z
    .object({
      turn: z
        .object({
          claimInformationId: z.string(),
          candidateInformationId: z.string().exactOptional(),
        })
        .strict(),
    })
    .strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});
const outcome: ActionOutcome = {
  status: "succeeded",
  evidence: "effect-verified",
  result: { value: 7 },
  artifacts: [],
  truncated: false,
};
const call = (id: string, tool = "test.tool", input: unknown = {}) =>
  ({
    toolCallId: id,
    toolName: nativeToolWireName(tool, "1"),
    rawInput: JSON.stringify(input),
    input,
    validation: "valid",
  }) as NativeToolCall;
async function fixture(
  postgres: boolean,
  options: {
    budget?: any;
    memory?: boolean;
    noMemory?: boolean;
    guiRoute?: "matching" | "other";
    guiImage?: boolean;
    largeGuiImage?: boolean;
    frozenInboundMedia?: boolean;
    nativeMismatch?: "missing" | "name" | "order" | "input" | "result";
    parallelTools?: boolean;
  } = {},
) {
  const pg = postgres
    ? await createPostgresTestingDatabaseScope(url!)
    : undefined;
  if (pg) cleanups.push(() => pg.close());
  let db = pg ? await pg.connect() : await createTestingDatabase();
  if (!pg) cleanups.push(() => db.close());
  await db.prepareSchema();
  const append = async (
    kind: string,
    payload: any = {},
    refs: string[] = [],
    relation = "core:uses-context",
  ) => {
    await db.information.synchronizeKinds([kind]);
    const id = randomUUID();
    await db.information.append(
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: id,
          kind,
          payload,
          source: "test:native",
          occurredAt: new Date().toISOString(),
          references: refs.map((informationId) => ({
            relation,
            informationId,
          })),
        }),
      ),
      [{ relation, required: false, multiple: true }],
    );
    return id;
  };
  const address = {
      platform: "qq",
      adapterId: "native",
      destination: { kind: "group" as const, groupId: "g" },
    },
    scope = JSON.stringify(["qq", "native", "group", "g"]);
  const original = await append("core.message.inbound.text", {
      text: "本轮证据",
      source: { ...address, senderId: "u" },
    }),
    actionRun = await append("agent.router.turn.claimed");
  const memory = await createNativeMemoryAccess({
    enabled: true,
    store: db.memoryGraph.native,
  }).freeze({
    scope,
    owners: [`conversation:${scope}`, "self:kaguya"],
    asOf: new Date().toISOString(),
    query: "本轮",
  });
  const content = {
    background: { evidence: [{ id: original }] },
    ...(options.noMemory ? {} : { memory }),
  };
  const turn = await append("agent.router.turn.context.completed", {
    source: { ...address, senderId: "u" },
    claimInformationId: actionRun,
    observedThroughInformationId: original,
    inputs: [
      {
        informationId: original,
        text: "本轮证据",
        source: { ...address, senderId: "u" },
      },
    ],
  });
  const frozen = await append(
    "agent.situation.frozen",
    { turnInformationId: turn, frame: content },
    [turn],
  );
  const observation = (await db.observations.freezeNext({
    consumerId: "agent.situation",
    policyVersion: "observation.v1",
    address,
    kinds: ["core.message.inbound.text"],
    senderId: "u",
    resultKind: "agent.observation.completed.v1",
    operationKey: "native",
    manifest: {
      version: 1,
      runInformationId: actionRun,
      frozenInformationId: frozen,
      sourceInformationIds: [original],
      knowledgeCutoff: {
        informationId: frozen,
        ...(options.noMemory
          ? {}
          : { memoryPublicationPosition: memory.cutoff!.publicationPosition }),
        memoryRevisions: [],
      },
      content,
    },
  }))!;
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContextInformationKind);
  for (const kind of modelTaskInformationKinds) registry.registerBuiltin(kind);
  for (const kind of [
    ...nativeToolInformationKinds,
    actionDecisionInformationKind,
  ])
    registry.register(kind);
  registry.register(sourceKind);
  registry.register(guiTaskRequestedKind);
  registry.register(guiTaskTerminalKind);
  let core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: randomUUID,
  });
  cleanups.push(() => core.close());
  await core.start();
  const context = await core.register(runtimeContextInformationKind, {
    payload: {},
    source: "test:native",
    occurredAt: new Date().toISOString(),
    references: [],
  });
  const source = await core.register(sourceKind, {
    payload: {
      turn: {
        claimInformationId: actionRun,
        candidateInformationId: actionRun,
      },
    },
    source: "test:native",
    occurredAt: new Date().toISOString(),
    references: [
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const request: ModelTaskRequest<string> = {
    task: {
      taskId: "agent.heavy.respond",
      outputMode: "text",
      outputSchema: z.string(),
      allowedTiers: ["heavy"],
    },
    activation: { instanceId: "heavy", definitionId: "agent.heavy" },
    selectionPolicy:
      options.guiRoute === "matching"
        ? { tier: "heavy", routeId: "gui.approved" }
        : { tier: "heavy" },
    sourceInformationId: source.informationId,
    contextInformationId: context.informationId,
    contextAtoms: [source],
    prompt: {
      kind: "message",
      text: "执行授权工具",
      templateId: "test.native",
      templates: [{ name: "main", content: "执行授权工具" }],
      variables: [],
    },
  };
  const archive = options.guiImage
    ? await mkdtemp(join(tmpdir(), "kaguya-native-image-"))
    : undefined;
  if (archive)
    cleanups.push(() => rm(archive, { recursive: true, force: true }));
  let png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1EAAAAASUVORK5CYII=",
    "base64",
  );
  if (options.largeGuiImage) {
    const data = Buffer.from("padding\0" + "a".repeat(80_000));
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write("tEXt", 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    png = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  }
  let archiveReads = 0;
  let mediaReads = 0;
  let mediaAvailable = true;
  const inboundImage = Buffer.alloc(140000, 23).toString("base64");
  const readArchive = async (reference: {
    id: string;
    scope: string;
    environmentId: string;
  }) => {
    if (!archive) throw new Error("no synthetic archive");
    expect(reference).toEqual({
      id: "original-png",
      scope,
      environmentId: "synthetic-desktop",
    });
    archiveReads++;
    return {
      artifact: JSON.parse(
        await readFile(join(archive, "metadata.json"), "utf8"),
      ),
      dataBase64: (await readFile(join(archive, "original.png"))).toString(
        "base64",
      ),
    };
  };
  let rawModel: ModelTaskClient;
  let effects = 0,
    providerCalls = 0,
    requests: any[] = [];
  let behavior: (
    input: Parameters<ActionProvider["execute"]>[0],
  ) => Promise<ActionOutcome> = async () => {
    effects++;
    return outcome;
  };
  let generate = async (_request: any): Promise<NativeToolCall[] | string> =>
    requests.length === 1
      ? [call("call-1", options.guiImage ? "gui.observe" : "test.tool")]
      : "完成";
  const provider: ActionProvider = {
    id: "test",
    version: "1",
    capabilities: {
      cancellation: "request-confirm",
      idempotency: "operation",
      reconciliation: false,
      successEvidence: "effect-verified",
      fencing: options.guiImage ? "environment" : "none",
    },
    execute: async (input) => {
      providerCalls++;
      const result = await behavior(input);
      if (!archive) return result;
      const hash = createHash("sha256").update(png).digest("hex");
      const artifact = {
        id: "original-png",
        hash,
        mime: "image/png",
        size: png.length,
        scope,
        actionId: input.intentId,
        generation: 1,
        observedAt: "2026-10-25T00:00:00.000Z",
        source: "environment-helper",
        retention: "explicit-delete-only",
      };
      await writeFile(join(archive, "original.png"), png);
      await writeFile(join(archive, "metadata.json"), JSON.stringify(artifact));
      return {
        ...result,
        artifacts: [artifact],
        result: {
          observation: {
            id: "a".repeat(64),
            environmentId: "synthetic-desktop",
            workflowId: "synthetic",
            generation: 1,
          },
          image: {
            captureId: "original-capture",
            coordinateFrame: "window",
            width: 1,
            height: 1,
            originalWidth: 1,
            originalHeight: 1,
            scale: 1,
            origin: { x: 27, y: 41 },
            target: { kind: "window", pid: 1, windowId: 2 },
            sha256: hash,
            mime: "image/png",
            capturedAt: "2026-10-25T00:00:00.000Z",
            serviceInstanceId: "service",
            driverInstanceId: "driver",
          },
        },
      };
    },
    cancel: async () => undefined,
  };
  let environmentValidation: (() => boolean) | undefined;
  const tool: NativeToolRegistration = {
    id: options.guiImage ? "gui.observe" : "test.tool",
    version: "1",
    description: "受控测试工具",
    inputSchema: z.object({}).strict(),
    providerId: "test",
    providerVersion: "1",
    executor: "test:host",
    policyVersion: "1",
    readonly: options.parallelTools ?? false,
    independent: options.parallelTools ?? false,
    bind: async () => ({
      target: { resource: "test" },
      ...(options.guiImage
        ? {
            environment: {
              environmentId: "synthetic-desktop",
              generation: 1,
              workspaceId: "workspace",
              resourceIds: [],
              workflowId: "synthetic",
              leaseId: "lease",
              fencing: "1",
              expiresAt: new Date(Date.now() + 120000).toISOString(),
            },
          }
        : {}),
    }),
    authorize: async () => true,
  };
  let executor: ActionExecutor;
  let modelIdentity = {
    providerId: "test",
    modelId: "native",
    configurationDigest: "a".repeat(64),
  };
  let nativeEnabled = true;
  let routeAvailable = true;
  let guiState = "ready",
    guiGeneration = 1;
  const guiHost = {
    bindings: [
      {
        environmentId: "synthetic-desktop",
        scope,
        workflowId: "synthetic",
        routeId: "gui.approved",
        revision: "one",
      },
    ],
    inspect: async () => ({ state: guiState, generation: guiGeneration }),
    validate: async (input: { generation: number }) =>
      guiState === "ready" && input.generation === guiGeneration,
  };
  const createLoop = () => {
    const memoryTools = options.memory
      ? createNativeMemoryTools(db)
      : undefined;
    executor = new ActionExecutor({
      store: db.actions,
      resolveLeaseCredential: async () => ({
        token: "private-lease-token-for-test",
      }),
      validateEnvironment: async (_i, mode) =>
        mode !== "result" || !environmentValidation || environmentValidation(),
      providers: [provider, ...(memoryTools ? [memoryTools.provider] : [])],
    });
    cleanups.push(() => executor.close());
    const model = (rawModel = new ModelTaskClient({
      readNativeArtifact: readArchive,
      ...(options.frozenInboundMedia
        ? {
            prepareMedia: async (
              _key: string,
              request: ModelTaskRequest<unknown>,
            ) => {
              return db.mediaSources.freeze(
                request.nativeStep!.runInformationId,
                scope,
                async () => {
                  mediaReads++;
                  if (!mediaAvailable)
                    throw new Error(
                      "changed media mode and missing original resource",
                    );
                  return [
                    {
                      role: "user" as const,
                      content: [
                        {
                          type: "text",
                          text: JSON.stringify({
                            mediaInput: {
                              mediaId: `media:${"a".repeat(64)}`,
                              mode: "native",
                            },
                          }),
                        },
                        {
                          type: "file",
                          mediaType: "image/png",
                          data: { type: "data", data: inboundImage },
                        },
                      ],
                    },
                  ];
                },
              );
            },
          }
        : {}),
      core,
      renderStructuredOutputPrompt:
        createStructuredOutputPromptRenderer("{{json_schema}}"),
      resolveModel: () => {
        if (!routeAvailable) throw new Error("route deleted");
        return modelIdentity;
      },
      admitNativeDispatch: (id, step) =>
        db.nativeTools.admitModel(
          step.runInformationId,
          step.stepIndex,
          id,
          core.executionClaim,
        ),
      client: {
        generate: async (r: any) => {
          requests.push(r);
          const output = await generate(r);
          return typeof output === "string"
            ? {
                kind: "final",
                output,
                native: {
                  version: 1,
                  messages: [{ role: "assistant", content: output }],
                  reasoning: [],
                },
                durationMs: 1,
              }
            : {
                kind: "tool-calls",
                output: null,
                calls: output,
                native: {
                  version: 1,
                  messages: [
                    {
                      role: "assistant",
                      content: [
                        ...(options.nativeMismatch === "missing"
                          ? []
                          : options.nativeMismatch === "order"
                            ? [...output].reverse()
                            : output
                        ).map((c) => ({
                          type: "tool-call",
                          toolCallId: c.toolCallId,
                          toolName:
                            options.nativeMismatch === "name"
                              ? "wrong"
                              : c.toolName,
                          input:
                            options.nativeMismatch === "input"
                              ? { changed: true }
                              : c.input,
                        })),
                        ...(options.nativeMismatch === "result"
                          ? [
                              {
                                type: "tool-result",
                                toolCallId: "second",
                                toolName: "forged",
                                output: { type: "json", value: {} },
                              },
                            ]
                          : []),
                      ],
                    },
                  ],
                  reasoning: [],
                },
                durationMs: 1,
              };
        },
      } as any,
    }));
    return new NativeToolLoop({
      db,
      core,
      actions: executor,
      model,
      resolveModel: () => {
        if (!routeAvailable) throw new Error("route deleted");
        return modelIdentity;
      },
      options: {
        readArtifact: readArchive,
        guiTasks: guiHost,
        registrations: [tool, ...(memoryTools?.registrations ?? [])],
        tasks: nativeEnabled
          ? [
              {
                taskId: request.task.taskId,
                definitionId: "agent.heavy",
                ...(request.selectionPolicy.routeId
                  ? { routeId: request.selectionPolicy.routeId }
                  : {}),
                toolIds: [
                  tool.id,
                  ...(memoryTools?.registrations.map((t) => t.id) ?? []),
                ],
              },
              {
                definitionId: "agent.heavy",
                taskId: "agent.gui.execute",
                routeId: "gui.approved",
                toolIds: [tool.id],
              },
            ]
          : [],
        budget: options.budget,
      },
    });
  };
  let loop = createLoop();
  return {
    guiService: async () => {
      const service = new GuiTaskService({
        db,
        core,
        loop,
        host: guiHost,
        activations: [request.activation],
      });
      // 生产 Runtime 在 HTTP 可用前同步订阅；此处只建立相同的持久收件箱，测试控制 runner 启动时刻。
      await db.information.reliable!.setSubscription!(
        { subscriptionId: "kaguya.gui.task", kind: guiTaskRequestedKind.kind },
        true,
      );
      await db.information.reliable!.setSubscription!(
        {
          subscriptionId: "kaguya.gui.task.cancel",
          kind: "agent.heavy.tool.origin.cancelled.v1",
        },
        true,
      );
      return service;
    },
    guiState: (state: string, generation = 1) => {
      guiState = state;
      guiGeneration = generation;
    },
    get rawModel() {
      return rawModel;
    },
    archiveReads: () => archiveReads,
    mediaReads: () => mediaReads,
    changeMedia: () => {
      mediaAvailable = false;
    },
    inboundImage,
    originalPng: png,
    get db() {
      return db;
    },
    get core() {
      return core;
    },
    get loop() {
      return loop;
    },
    request,
    modelIdentity: (value: Partial<typeof modelIdentity>) => {
      modelIdentity = { ...modelIdentity, ...value };
    },
    disableNative: () => {
      nativeEnabled = false;
    },
    deleteRoute: () => {
      routeAvailable = false;
    },
    scope,
    original,
    actionRun,
    observation,
    tool,
    requests,
    effects: () => effects,
    provider,
    providerCalls: () => providerCalls,
    environmentFenced: () => {
      provider.capabilities.fencing = "environment";
      tool.bind = async () => ({
        target: { resource: "test" },
        environment: {
          environmentId: "env",
          generation: 1,
          workspaceId: "workspace",
          resourceIds: [],
          workflowId: "workflow",
          leaseId: "lease",
          fencing: "1",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      });
      environmentValidation = () => false;
    },
    behavior: (b: typeof behavior) => (behavior = b),
    generate: (g: typeof generate) => (generate = g),
    append,
    alternate: async () => {
      const src = await append("core.message.inbound.text", {
          text: "另一观察",
          source: { ...address, senderId: "v" },
        }),
        run = await append("agent.router.turn.claimed");
      const mem = await createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      }).freeze({
        scope,
        owners: [`conversation:${scope}`, "self:kaguya"],
        asOf: new Date().toISOString(),
        query: "另一观察",
      });
      const frame = { background: { evidence: [{ id: src }] }, memory: mem };
      const turn = await append("agent.router.turn.context.completed", {
        source: { ...address, senderId: "v" },
        claimInformationId: run,
        observedThroughInformationId: src,
        inputs: [
          {
            informationId: src,
            text: "另一观察",
            source: { ...address, senderId: "v" },
          },
        ],
      });
      const frozen = await append(
        "agent.situation.frozen",
        { turnInformationId: turn, frame },
        [turn],
      );
      const observation = (await db.observations.freezeNext({
        consumerId: "agent.situation",
        policyVersion: "observation.v1",
        address,
        kinds: ["core.message.inbound.text"],
        senderId: "v",
        resultKind: "agent.observation.completed.v1",
        operationKey: "alternate",
        manifest: {
          version: 1,
          runInformationId: run,
          frozenInformationId: frozen,
          sourceInformationIds: [src],
          knowledgeCutoff: {
            informationId: frozen,
            memoryPublicationPosition: mem.cutoff!.publicationPosition,
            memoryRevisions: [],
          },
          content: frame,
        },
      }))!;
      const next = await core.register(sourceKind, {
        payload: { turn: { claimInformationId: run } },
        source: "test:native",
        occurredAt: new Date().toISOString(),
        references: [
          { relation: "core:context", informationId: context.informationId },
        ],
      });
      return {
        observation,
        request: {
          ...request,
          sourceInformationId: next.informationId,
          contextAtoms: [next],
        },
      };
    },
    restart: async () => {
      await executor.close();
      await core.close();
      if (pg) {
        await db.close();
        db = await pg.reconnect();
      } else db = new KaguyaDatabase(db.sql);
      core = new InformationCore({
        registry,
        store: db.information,
        nextInformationId: randomUUID,
      });
      await core.start();
      loop = createLoop();
    },
    withdraw: () =>
      db.memoryGraph.native.publish({
        operationId: "withdraw",
        actor: "manual",
        nodes: [],
        invalidations: [
          { kind: "source-withdrawal", targetId: original, reason: "测试撤回" },
        ],
      }),
  };
}
async function guiAcknowledged(
  f: Awaited<ReturnType<typeof fixture>>,
  requestedInformationId: string,
) {
  return vi.waitFor(
    async () => {
      const row = (
        await f.db.sql.query<{ state: string; attempts: number }>(
          "SELECT state,attempts FROM information_deliveries WHERE subscription_id='kaguya.gui.task' AND information_id=$1",
          [requestedInformationId],
        )
      ).rows[0];
      expect(row?.state).toBe("acked");
      expect(row!.attempts).toBeGreaterThanOrEqual(1);
      return row!;
    },
    { timeout: 8000, interval: 20 },
  );
}
async function imageHistory(
  f: Awaited<ReturnType<typeof fixture>>,
  closed = false,
) {
  const historyIds = (
    await f.db.sql.query<{ information_id: string }>(
      "SELECT information_id FROM information_atoms WHERE kind='agent.heavy.tool.result.v1' OR (kind='core.model.task.completed' AND payload->>'generationKind'='tool-calls')",
    )
  ).rows.map((r) => r.information_id);
  if (closed)
    historyIds.push(
      await f.append("agent.router.turn.completed", {
        candidateInformationId: f.actionRun,
      }),
    );
  const source = await f.core.register(sourceKind, {
    payload: {
      turn: {
        claimInformationId: f.actionRun,
        candidateInformationId: f.actionRun,
      },
    },
    source: "test:native",
    occurredAt: new Date().toISOString(),
    references: [
      {
        relation: "core:context",
        informationId: f.request.contextInformationId,
      },
    ],
  });
  return {
    ...f.request,
    sourceInformationId: source.informationId,
    contextAtoms: await f.core.getMany([
      source.informationId,
      f.request.sourceInformationId,
      ...historyIds,
    ]),
    nativeContinuation: true,
  };
}
for (const postgres of backends)
  describe(postgres ? "native PostgreSQL" : "native PGlite", () => {
    it("persists one explicit GUI task across duplicate management submissions and core restart", async () => {
      const f = await fixture(postgres, { guiImage: true });
      let service = await f.guiService();
      const input = { taskRequestId: randomUUID(), prompt: "inspect desktop" };
      const queued = await service.submit("synthetic-desktop", input);
      expect(queued.status).toBe("queued");
      expect(
        (await service.submit("synthetic-desktop", input))
          .requestedInformationId,
      ).toBe(queued.requestedInformationId);
      await expect(
        service.submit("synthetic-desktop", { ...input, prompt: "different" }),
      ).rejects.toThrow("gui-task-id-conflict");
      await expect(
        service.submit("synthetic-desktop", { ...input, nativeStep: {} }),
      ).rejects.toThrow();
      await f.restart();
      service = await f.guiService();
      await f.core.startReliableDelivery();
      await vi.waitFor(
        async () =>
          expect(
            (await service.read("synthetic-desktop", input.taskRequestId))
              .status,
          ).toBe("completed"),
        { timeout: 8000, interval: 20 },
      );
      const delivery = await guiAcknowledged(f, queued.requestedInformationId);
      await f.core.stopReliableDelivery({ drain: true });
      expect(f.providerCalls()).toBe(1);
      expect(f.requests).toHaveLength(2);
      const facts = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='core.model.task.requested'",
        )
      ).rows;
      expect(
        facts.every(
          (r) =>
            r.payload.taskId === "agent.gui.execute" &&
            r.payload.selectionPolicy.routeId === "gui.approved",
        ),
      ).toBe(true);
      expect((await service.submit("synthetic-desktop", input)).status).toBe(
        "completed",
      );
      await f.restart();
      service = await f.guiService();
      // 重提没有创建新 delivery；原任务已 acked，重启只核对同一持久状态。
      expect(await guiAcknowledged(f, queued.requestedInformationId)).toEqual(
        delivery,
      );
      expect(
        (await service.read("synthetic-desktop", input.taskRequestId)).status,
      ).toBe("completed");
      expect(f.providerCalls()).toBe(1);
      expect(f.requests).toHaveLength(2);
    }, 40000); // 完成状态和两次 ack 核对各最多 8 秒，另留初始化与两次重启预算。
    it("cancels an accepted GUI origin before any run and keeps it stopped after restart", async () => {
      const f = await fixture(postgres, { guiImage: true });
      let service = await f.guiService();
      const input = {
        taskRequestId: randomUUID(),
        prompt: "cancel before start",
      };
      const queued = await service.submit("synthetic-desktop", input);
      expect(
        (await service.cancel("synthetic-desktop", input.taskRequestId)).status,
      ).toBe("stopped");
      await f.restart();
      service = await f.guiService();
      await f.core.startReliableDelivery();
      await guiAcknowledged(f, queued.requestedInformationId);
      await f.core.stopReliableDelivery({ drain: true });
      expect(
        (await service.read("synthetic-desktop", input.taskRequestId)).status,
      ).toBe("stopped");
      expect(f.requests).toHaveLength(0);
      expect(f.providerCalls()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_runs"))
          .rows,
      ).toHaveLength(0);
    }, 25000); // 等待消费 ack 最多 8 秒，另留真实数据库初始化与重启预算。
    it("cancels while the durable handler is about to create its run", async () => {
      const f = await fixture(postgres, { guiImage: true });
      const service = await f.guiService();
      const input = { taskRequestId: randomUUID(), prompt: "cancel open race" };
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const open = f.db.nativeTools.open.bind(f.db.nativeTools);
      const spy = vi
        .spyOn(f.db.nativeTools, "open")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return open(...args);
        });
      try {
        const queued = await service.submit("synthetic-desktop", input);
        await f.core.startReliableDelivery();
        let reached = false;
        void entered.promise.then(() => {
          reached = true;
        });
        await vi.waitFor(() => expect(reached).toBe(true), {
          timeout: 8000,
          interval: 20,
        });
        expect(
          (await service.cancel("synthetic-desktop", input.taskRequestId))
            .status,
        ).toBe("stopped");
        release.resolve();
        await guiAcknowledged(f, queued.requestedInformationId);
      } finally {
        release.resolve();
        await f.core.stopReliableDelivery({ drain: true });
        spy.mockRestore();
      }
      expect(f.requests).toHaveLength(0);
      expect(f.providerCalls()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_runs"))
          .rows,
      ).toHaveLength(0);
    }, 30000); // 进入 open 与消费 ack 各最多 8 秒，另留初始化、取消和清理预算。
    it("stops an inflight GUI model and never executes its late tool calls", async () => {
      const f = await fixture(postgres, { guiImage: true });
      const service = await f.guiService();
      const input = {
        taskRequestId: randomUUID(),
        prompt: "cancel running model",
      };
      const release = Promise.withResolvers<void>();
      let entered = false;
      let requestedInformationId = "";
      let delivery: { state: string; attempts: number } | undefined;
      f.generate(async () => {
        entered = true;
        await release.promise;
        return [call("late", "gui.observe")];
      });
      try {
        requestedInformationId = (
          await service.submit("synthetic-desktop", input)
        ).requestedInformationId;
        await f.core.startReliableDelivery();
        await vi.waitFor(() => expect(entered).toBe(true), {
          timeout: 8000,
          interval: 20,
        });
        expect(
          (await service.cancel("synthetic-desktop", input.taskRequestId))
            .status,
        ).toBe("stopped");
        release.resolve();
        delivery = await guiAcknowledged(f, requestedInformationId);
      } finally {
        release.resolve();
        await f.core.stopReliableDelivery({ drain: true });
      }
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(0);
      await f.restart();
      const restored = await f.guiService();
      // 取消处理已经 acked；重启不创建新任务来制造恢复活动。
      expect(await guiAcknowledged(f, requestedInformationId)).toEqual(
        delivery,
      );
      expect(
        (await restored.read("synthetic-desktop", input.taskRequestId)).status,
      ).toBe("stopped");
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(0);
    }, 40000); // 进入模型与两次 ack 核对各最多 8 秒，另留初始化、重启和取消预算。
    it.each(["before-forward", "provider-failure"] as const)(
      "retries durable cancellation after restart even with a GUI terminal: %s",
      async (mode) => {
        const f = await fixture(postgres, { guiImage: true });
        let service = await f.guiService();
        const input = {
          taskRequestId: randomUUID(),
          prompt: "cancel durable forwarding",
        };
        const release = Promise.withResolvers<void>();
        f.behavior(async () => {
          await release.promise;
          return outcome;
        });
        const cancelledAttempts: string[] = [];
        let fail = mode === "provider-failure";
        f.provider.cancel = async (input) => {
          cancelledAttempts.push(input.attemptId);
          if (fail) throw new Error("synthetic cancellation transport failure");
          // broker 已成功但响应丢失：恢复转发可收敛，W3 不据此把 unknown 升级。
          return mode === "provider-failure" ? outcome : undefined;
        };
        const queued = await service.submit("synthetic-desktop", input);
        try {
          await f.core.startReliableDelivery();
          await vi.waitFor(() => expect(f.providerCalls()).toBe(1), {
            timeout: 8000,
            interval: 20,
          });
          await f.core.stopReliableDelivery();
          const spy =
            mode === "before-forward"
              ? vi
                  .spyOn(f.loop, "cancel")
                  .mockRejectedValueOnce(
                    new Error("synthetic crash after durable stop"),
                  )
              : undefined;
          await expect(
            service.cancel("synthetic-desktop", input.taskRequestId),
          ).rejects.toThrow("synthetic");
          spy?.mockRestore();
          expect(
            (await service.read("synthetic-desktop", input.taskRequestId))
              .cancellation?.state,
          ).toBe("pending");
          // 兼容旧版本已提交 GUI terminal 但未转发完成的持久窗口。
          const source = await f.core.get(queued.requestedInformationId);
          const current = await service.read(
            "synthetic-desktop",
            input.taskRequestId,
          );
          await f.core.commitTerminal(
            "kaguya.gui.task",
            queued.requestedInformationId,
            guiTaskTerminalKind,
            {
              payload: {
                status: "stopped",
                reason: "cancelled",
                runInformationId: current.runInformationId,
                output: null,
              },
              source: "test:native",
              occurredAt: new Date().toISOString(),
              references: [
                source!.references.find((r) => r.relation === "core:context")!,
                {
                  relation: "core:caused-by",
                  informationId: queued.requestedInformationId,
                },
                {
                  relation: "core:status-of",
                  informationId: queued.requestedInformationId,
                },
              ],
            },
          );
        } finally {
          release.resolve();
        }
        await f.restart();
        service = await f.guiService();
        fail = false;
        const priorAttempts = cancelledAttempts.length;
        if (mode === "provider-failure") {
          expect(priorAttempts).toBe(1);
          expect(
            (await service.cancel("synthetic-desktop", input.taskRequestId))
              .cancellation?.state,
          ).toBe("forwarded");
          expect(cancelledAttempts).toHaveLength(2);
        }
        await f.core.startReliableDelivery();
        await vi.waitFor(
          async () => {
            const state = await service.read(
              "synthetic-desktop",
              input.taskRequestId,
            );
            expect(state.cancellation?.state).toBe("forwarded");
            const delivery = (
              await f.db.sql.query<{ state: string; attempts: number }>(
                "SELECT state,attempts FROM information_deliveries WHERE subscription_id='kaguya.gui.task.cancel' AND information_id=$1",
                [state.cancellation!.requestedInformationId],
              )
            ).rows[0];
            expect(delivery?.state).toBe("acked");
            expect(delivery!.attempts).toBeGreaterThanOrEqual(1);
          },
          { timeout: 8000, interval: 20 },
        );
        await guiAcknowledged(f, queued.requestedInformationId);
        await f.core.stopReliableDelivery({ drain: true });
        expect(cancelledAttempts.length).toBeGreaterThan(priorAttempts);
        expect(new Set(cancelledAttempts).size).toBe(1);
        expect(f.providerCalls()).toBe(1);
        expect(f.requests).toHaveLength(1);
        const action = (
          await f.db.sql.query<{ intent_id: string }>(
            "SELECT intent_id FROM information_action_heads",
          )
        ).rows[0]!;
        expect(
          (await f.db.actions.read(action.intent_id, f.scope)).state,
        ).not.toBe("cancelled");
      },
      40000, // provider 进入、取消 ack、任务 ack 各最多 8 秒，另留初始化与重启预算。
    );
    it.each(["human", "draining", "unknown"])(
      "rejects GUI tasks in %s without taking control",
      async (state) => {
        const f = await fixture(postgres, { guiImage: true });
        f.guiState(state);
        const service = await f.guiService();
        await expect(
          service.submit("synthetic-desktop", {
            taskRequestId: randomUUID(),
            prompt: "no resume",
          }),
        ).rejects.toThrow("gui-environment-unavailable");
        expect(f.requests).toHaveLength(0);
        expect(f.providerCalls()).toBe(0);
        expect(
          (
            await f.db.sql.query(
              "SELECT * FROM information_atoms WHERE kind='agent.gui.task.requested.v1'",
            )
          ).rows,
        ).toHaveLength(0);
      },
    );
    it.each(["instanceId", "definitionId", "taskId", "sourceInformationId"])(
      "rejects another requested origin at admission without spending the original budget: %s",
      async (field) => {
        const f = await fixture(postgres);
        const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
        const boundary = vi
          .spyOn(f.db.nativeTools, "freeze")
          .mockImplementationOnce(async (...args) => {
            await freeze(...args);
            throw new Error("frozen before request");
          });
        await expect(f.loop.execute(f.request)).rejects.toThrow(
          "frozen before request",
        );
        boundary.mockRestore();
        const row = (
          await f.db.sql.query<any>(
            "SELECT * FROM information_native_tool_runs",
          )
        ).rows[0];
        let request = {
          ...f.request,
          nativeModelBinding: row.spec.modelBinding,
          tools: row.spec.declarations,
          nativeStep: {
            runInformationId: row.run_id,
            stepIndex: 0,
            deadline: row.spec.deadline,
            maxContextBytes: row.spec.budget.maxContextBytes,
            maxOutputBytes: row.spec.budget.maxOutputBytes,
          },
        };
        if (field === "instanceId" || field === "definitionId")
          request = {
            ...request,
            activation: { ...request.activation, [field]: "other-origin" },
          };
        if (field === "taskId")
          request = {
            ...request,
            task: { ...request.task, taskId: "other-task" },
          };
        if (field === "sourceInformationId") {
          const source = await f.core.register(sourceKind, {
            payload: { turn: { claimInformationId: f.actionRun } },
            source: "test:native",
            occurredAt: new Date().toISOString(),
            references: [
              {
                relation: "core:context",
                informationId: f.request.contextInformationId,
              },
            ],
          });
          request = {
            ...request,
            sourceInformationId: source.informationId,
            contextAtoms: [source],
          };
        }
        expect((await f.rawModel.execute(request)).status).toBe("failed");
        expect(f.requests).toHaveLength(0);
        expect(f.effects()).toBe(0);
        expect((await f.db.nativeTools.read(row.run_id)).steps_count).toBe(0);
        expect(
          (
            await f.db.sql.query(
              "SELECT request_id,dispatched_id FROM information_native_tool_steps",
            )
          ).rows,
        ).toEqual([{ request_id: null, dispatched_id: null }]);
        expect(
          (
            await f.db.sql.query(
              "SELECT information_id FROM information_atoms WHERE kind='core.model.task.dispatched.v1'",
            )
          ).rows,
        ).toHaveLength(0);
        expect((await f.loop.execute(f.request)).status).toBe("completed");
        expect(f.requests).toHaveLength(2);
        expect(f.effects()).toBe(1);
      },
    );
    it("loads the persisted original GUI PNG after reconnect and through historical ModelTask assembly without another provider execution", async () => {
      const f = await fixture(postgres, { guiImage: true });
      const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
      const boundary = vi
        .spyOn(f.db.nativeTools, "freeze")
        .mockImplementation(async (...args) => {
          if (args[0].stepIndex === 1)
            throw new Error("restart after image receipt");
          return freeze(...args);
        });
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "restart after image receipt",
      );
      expect(
        f.archiveReads(),
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
            )
          ).rows,
        ),
      ).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
      boundary.mockRestore();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.archiveReads()).toBe(2);
      const assertImagePair = (messages: any[]) => {
        const imageIndex = messages.findIndex((m) => m.nativeToolResultGroup);
        expect(imageIndex).toBeGreaterThan(0);
        expect(messages[imageIndex].nativeToolResultGroup).toEqual(["call-1"]);
        expect(messages[imageIndex - 1]).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call-1" }],
        });
        const image = messages[imageIndex].content.find(
          (p: any) => p.type === "image",
        );
        expect(Buffer.from(image.image.split(",")[1], "base64")).toEqual(
          f.originalPng,
        );
        const metadata = JSON.parse(messages[imageIndex].content[0].text);
        expect(metadata.image).toMatchObject({
          captureId: "original-capture",
          width: 1,
          height: 1,
          origin: { x: 27, y: 41 },
        });
      };
      assertImagePair(f.requests[1].messages);
      f.generate(async () => "history complete");
      expect((await f.loop.execute(await imageHistory(f))).status).toBe(
        "completed",
      );
      assertImagePair(f.requests[2].messages);
      expect(f.archiveReads()).toBe(3);
      expect(f.providerCalls()).toBe(1);
      expect(f.effects()).toBe(1);
    });
    it.each([false, true])(
      "selects historical image groups before blob reads under a smaller budget: closed=%s",
      async (closed) => {
        const budget = { maxContextBytes: 128000 };
        const f = await fixture(postgres, {
          guiImage: true,
          largeGuiImage: true,
          budget,
        });
        expect((await f.loop.execute(f.request)).status).toBe("completed");
        expect(f.originalPng.length).toBeGreaterThan(80000);
        expect(f.archiveReads()).toBe(1);
        budget.maxContextBytes = 64000;
        f.generate(async () => "smaller history complete");
        const result = await f.loop.execute(await imageHistory(f, closed));
        expect(result.status).toBe(closed ? "completed" : "failed");
        expect(f.archiveReads()).toBe(1);
        expect(f.providerCalls()).toBe(1);
        expect(f.requests).toHaveLength(closed ? 3 : 2);
        if (closed)
          expect(JSON.stringify(f.requests[2].messages)).not.toContain(
            "data:image/png",
          );
        else
          expect(result).toMatchObject({
            status: "failed",
            error: { stage: "context-budget" },
          });
      },
    );
    it.each(["matching", "other"] as const)(
      "freezes the host explicit policy before the first model request: %s",
      async (guiRoute) => {
        const f = await fixture(postgres, { guiRoute });
        await f.loop.execute(f.request);
        const rows = (
          await f.db.sql.query<any>(
            "SELECT payload FROM information_atoms WHERE kind='core.model.task.requested' ORDER BY payload->'nativeStep'->>'stepIndex'",
          )
        ).rows;
        expect(rows).toHaveLength(2);
        for (const { payload } of rows) {
          expect(payload.selectionPolicy).toEqual(
            guiRoute === "matching"
              ? { tier: "heavy", routeId: "gui.approved" }
              : { tier: "heavy" },
          );
          expect(payload.nativeModelBinding.selectionPolicy).toEqual(
            payload.selectionPolicy,
          );
        }
      },
    );
    it("refuses a legacy source candidate without requested-origin proof before creating any replacement", async () => {
      const f = await fixture(postgres);
      const boundary = vi
        .spyOn(f.db.nativeTools, "freeze")
        .mockRejectedValueOnce(new Error("before first request"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "before first request",
      );
      boundary.mockRestore();
      await f.db.sql.query(
        "UPDATE information_native_tool_runs SET origin_key=NULL,spec=spec-'origin'-'modelBinding'",
      );
      await f.restart();
      await expect(
        f.loop.execute({
          ...f.request,
          selectionPolicy: { tier: "heavy", routeId: "another" },
        }),
      ).rejects.toThrow("native-origin-proof-missing");
      expect(f.requests).toHaveLength(0);
      expect(f.effects()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_runs"))
          .rows,
      ).toHaveLength(1);
    });
    it.each([false, true])(
      "derives legacy origin only from actual requested proof and preserves stopped facts: completed=%s",
      async (completed) => {
        const f = await fixture(postgres);
        let boundary: { mockRestore(): void } | undefined;
        if (!completed) {
          const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
          boundary = vi
            .spyOn(f.db.nativeTools, "freeze")
            .mockImplementation(async (...args) => {
              if (args[0].stepIndex === 1) throw new Error("legacy boundary");
              return freeze(...args);
            });
          await expect(f.loop.execute(f.request)).rejects.toThrow(
            "legacy boundary",
          );
        } else await f.loop.execute(f.request);
        boundary?.mockRestore();
        const before = (
          await f.db.sql.query<any>(
            "SELECT * FROM information_native_tool_runs",
          )
        ).rows[0];
        // 模拟迁移前行；不可变 information_atoms 保持原样，不从当下配置补写 binding。
        await f.db.sql.query(
          "UPDATE information_native_tool_runs SET origin_key=NULL,spec=spec-'origin'-'modelBinding'",
        );
        await f.restart();
        const result = await f.loop.execute({
          ...f.request,
          selectionPolicy: { tier: "heavy", routeId: "changed" },
        });
        expect(result.status).toBe(completed ? "completed" : "failed");
        const after = (
          await f.db.sql.query<any>(
            "SELECT * FROM information_native_tool_runs",
          )
        ).rows;
        expect(after).toHaveLength(1);
        expect(after[0].run_key).toBe(before.run_key);
        expect(after[0].origin_key).toBeTruthy();
        expect(after[0].spec.modelBinding).toBeUndefined();
        if (completed) expect(after[0].stopped_id).toBe(before.stopped_id);
        else
          expect((await f.core.get(after[0].stopped_id))!.payload.reason).toBe(
            "native-model-binding-missing",
          );
        expect(f.requests).toHaveLength(completed ? 2 : 1);
        expect(f.effects()).toBe(1);
      },
    );
    it.each([
      "model",
      "configuration",
      "route",
      "native-off",
      "policy",
      "unchanged",
    ])(
      "freezes origin and model across restart after the committed receipt: %s",
      async (change) => {
        const f = await fixture(postgres);
        const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
        const boundary = vi
          .spyOn(f.db.nativeTools, "freeze")
          .mockImplementation(async (...args) => {
            if (args[0].stepIndex === 1)
              throw new Error("synthetic restart after receipt");
            return freeze(...args);
          });
        await expect(f.loop.execute(f.request)).rejects.toThrow(
          "synthetic restart after receipt",
        );
        expect(f.effects()).toBe(1);
        expect(f.requests).toHaveLength(1);
        expect(
          (
            await f.db.sql.query(
              "SELECT result_id FROM information_native_tool_calls",
            )
          ).rows[0]!.result_id,
        ).toBeTruthy();
        boundary.mockRestore();
        if (change === "model") f.modelIdentity({ modelId: "different" });
        if (change === "configuration")
          f.modelIdentity({ configurationDigest: "b".repeat(64) });
        if (change === "route") f.deleteRoute();
        if (change === "native-off") f.disableNative();
        await f.restart();
        const request =
          change === "policy"
            ? { ...f.request, selectionPolicy: { tier: "light" as const } }
            : f.request;
        const result = await f.loop.execute(request);
        expect(result.status).toBe(
          change === "unchanged" ? "completed" : "failed",
        );
        await f.restart();
        expect(await f.loop.execute(request)).toEqual(result);
        expect(f.requests).toHaveLength(change === "unchanged" ? 2 : 1);
        expect(f.effects()).toBe(1);
        expect(
          (await f.db.sql.query("SELECT * FROM information_native_tool_runs"))
            .rows,
        ).toHaveLength(1);
        expect(
          (await f.db.sql.query("SELECT * FROM information_native_tool_steps"))
            .rows,
        ).toHaveLength(change === "unchanged" ? 2 : 1);
      },
    );
    it("reuses frozen inbound media above the text budget exactly once per step after a receipt restart", async () => {
      const f = await fixture(postgres, {
        frozenInboundMedia: true,
        budget: { maxContextBytes: 128000 },
      });
      const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
      const boundary = vi
        .spyOn(f.db.nativeTools, "freeze")
        .mockImplementation(async (...args) => {
          if (args[0].stepIndex === 1)
            throw new Error("restart before media successor");
          return freeze(...args);
        });
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "restart before media successor",
      );
      boundary.mockRestore();
      expect(f.mediaReads()).toBe(1);
      expect(f.providerCalls()).toBe(1);
      f.changeMedia();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.requests).toHaveLength(2);
      expect(f.providerCalls()).toBe(1);
      expect(f.mediaReads()).toBe(1);
      for (const request of f.requests) {
        const images = request.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .filter((p: any) => p.type === "file" && p.mediaType === "image/png");
        expect(images).toHaveLength(1);
        expect(images[0].data).toEqual({ type: "data", data: f.inboundImage });
      }
      const facts = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='core.model.task.requested' ORDER BY (payload->'nativeStep'->>'stepIndex')::int",
        )
      ).rows;
      expect(facts).toHaveLength(2);
      expect(facts.every((r) => r.payload.mediaInputByteLength > 128000)).toBe(
        true,
      );
      expect(facts[1].payload.contextTrimming.retainedBytes).toBeLessThan(
        128000,
      );
      const parts = f.requests[1].messages.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content : [],
      );
      expect(
        parts
          .filter((p: any) => p.type === "tool-call")
          .map((p: any) => p.toolCallId),
      ).toEqual(["call-1"]);
      expect(
        parts
          .filter((p: any) => p.type === "tool-result")
          .map((p: any) => p.toolCallId),
      ).toEqual(["call-1"]);
    });
    it("runs a real model-task → W3 receipt → paired next step and replays without effects", async () => {
      const f = await fixture(postgres);
      const result = await f.loop.execute(f.request);
      expect(result).toMatchObject({ status: "completed", output: "完成" });
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
      const calls = (
        await f.db.sql.query<any>("SELECT * FROM information_native_tool_calls")
      ).rows;
      expect(calls).toHaveLength(1);
      expect(calls[0].intent_id).toBeTruthy();
      expect(calls[0].result_id).toBeTruthy();
      const pair = (await f.core.get(calls[0].result_id))!.payload;
      const receipt = await f.core.get(String(pair.receiptId));
      const head = (
        await f.db.sql.query<any>(
          "SELECT * FROM information_action_heads WHERE intent_id=$1",
          [calls[0].intent_id],
        )
      ).rows[0];
      expect(receipt!.payload.intentId).toBe(head.intent_id);
      expect(receipt!.payload.attemptId).toBe(head.attempt_id);
      expect(pair.intentId).toBe(head.intent_id);
      expect((receipt!.payload.intent as any).toolCallId).toBe(
        calls[0].call_id,
      );
      const messages = f.requests[1].messages;
      expect(
        messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find((p: any) => p.type === "tool-result").output.value,
      ).toEqual(pair.value);
      expect(
        messages.flatMap((m: any) =>
          Array.isArray(m.content) ? m.content : [],
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "call-1",
          }),
        ]),
      );
      await f.restart();
      expect(await f.loop.execute(f.request)).toEqual(result);
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
    });
    it.each(["unknown", "partial"] as const)(
      "stops after %s without another provider/model call",
      async (status) => {
        const f = await fixture(postgres);
        f.behavior(async () => ({
          ...outcome,
          status,
          evidence: status === "unknown" ? "unconfirmed" : "observed",
        }));
        expect((await f.loop.execute(f.request)).status).toBe("failed");
        expect(f.requests).toHaveLength(1);
        expect(f.providerCalls()).toBe(1);
        await f.restart();
        await f.loop.execute(f.request);
        expect(f.requests).toHaveLength(1);
        expect(f.providerCalls()).toBe(1);
      },
    );
    it.each(["missing", "name", "order"] as const)(
      "rejects %s native-message mismatch before registering actions and after restart",
      async (nativeMismatch) => {
        const f = await fixture(postgres, { nativeMismatch });
        f.generate(async () => [call("first"), call("second")]);
        expect((await f.loop.execute(f.request)).status).toBe("failed");
        expect(f.providerCalls()).toBe(0);
        expect(f.effects()).toBe(0);
        expect(
          (await f.db.sql.query("SELECT * FROM information_native_tool_calls"))
            .rows,
        ).toHaveLength(0);
        await f.restart();
        expect((await f.loop.execute(f.request)).status).toBe("failed");
        expect(f.requests).toHaveLength(1);
        expect(f.providerCalls()).toBe(0);
      },
    );
    it.each([
      "completed",
      "index",
      "call-id",
      "native-input",
      "native-message",
      "native-result",
      "raw-input",
      "valid",
    ] as const)(
      "audits the whole registered batch before recovery effects: %s",
      async (mutation) => {
        const f = await fixture(postgres, {
          ...(mutation === "native-input"
            ? { nativeMismatch: "input" as const }
            : {}),
          ...(mutation === "native-message"
            ? { nativeMismatch: "missing" as const }
            : {}),
          ...(mutation === "native-result"
            ? { nativeMismatch: "result" as const }
            : {}),
        });
        f.generate(async () =>
          f.requests.length === 1
            ? [
                call("first"),
                {
                  ...call("second"),
                  ...(mutation === "raw-input"
                    ? { rawInput: '{"changed":true}' }
                    : {}),
                },
              ]
            : "完成",
        );
        // 模拟升级前的已登记记录；只追加模型事实和调用索引，保持 append-only 保护。
        const crash = vi
          .spyOn(f.db.nativeTools, "registerCalls")
          .mockImplementationOnce(async (run, step, completed, calls) => {
            await f.db.sql.transaction(async (tx) => {
              for (const [index, item] of calls.entries())
                await tx.query(
                  "INSERT INTO information_native_tool_calls(run_id,step_index,call_index,call_id,completed_id,call) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
                  [
                    run,
                    step,
                    index,
                    item.toolCallId,
                    completed,
                    JSON.stringify(item),
                  ],
                );
              await tx.query(
                "UPDATE information_native_tool_runs SET calls_count=calls_count+$2 WHERE run_id=$1",
                [run, calls.length],
              );
            });
            throw new Error("crash after call registration");
          });
        await expect(f.loop.execute(f.request)).rejects.toThrow(
          "crash after call registration",
        );
        crash.mockRestore();
        if (mutation === "completed")
          await f.db.sql.query(
            "UPDATE information_native_tool_calls SET completed_id=$1 WHERE call_index=1",
            [f.request.sourceInformationId],
          );
        if (mutation === "index")
          await f.db.sql.query(
            "UPDATE information_native_tool_calls SET call_index=5 WHERE call_index=1",
          );
        if (mutation === "call-id")
          await f.db.sql.query(
            "UPDATE information_native_tool_calls SET call_id='wrong' WHERE call_index=1",
          );
        await f.restart();
        const result = await f.loop.execute(f.request);
        expect(result.status).toBe(
          mutation === "valid" ? "completed" : "failed",
        );
        expect(f.effects()).toBe(mutation === "valid" ? 2 : 0);
        expect(f.providerCalls()).toBe(mutation === "valid" ? 2 : 0);
        expect(f.requests).toHaveLength(mutation === "valid" ? 2 : 1);
        await f.restart();
        expect(await f.loop.execute(f.request)).toEqual(result);
        expect(f.providerCalls()).toBe(mutation === "valid" ? 2 : 0);
      },
    );
    it.each([
      "result-pointer",
      "result-envelope",
      "projection",
      "receipt-ref",
      "intent-original",
      "valid",
    ] as const)(
      "audits saved result proof before executing the next registered call: %s",
      async (mutation) => {
        const f = await fixture(postgres);
        f.generate(async () =>
          f.requests.length === 1 ? [call("first"), call("second")] : "完成",
        );
        const save = f.db.nativeTools.result.bind(f.db.nativeTools);
        const crash = vi
          .spyOn(f.db.nativeTools, "result")
          .mockImplementationOnce(async (...args) => {
            await save(...args);
            throw new Error("crash after paired result");
          });
        await expect(f.loop.execute(f.request)).rejects.toThrow(
          "crash after paired result",
        );
        crash.mockRestore();
        const first = (
          await f.db.sql.query<any>(
            "SELECT * FROM information_native_tool_calls WHERE call_index=0",
          )
        ).rows[0];
        const payload = (
          await f.db.sql.query<any>(
            "SELECT payload FROM information_atoms WHERE information_id=$1",
            [first.result_id],
          )
        ).rows[0].payload;
        if (mutation === "result-pointer")
          await f.db.sql.query(
            "UPDATE information_native_tool_calls SET result_id=$1 WHERE call_index=1",
            [first.result_id],
          );
        if (mutation === "result-envelope") payload.stepIndex = 9;
        if (mutation === "projection") {
          payload.value.result.value = 999;
          payload.outputBytes = Buffer.byteLength(
            JSON.stringify(payload.value),
          );
        }
        if (mutation === "receipt-ref") {
          const original = (
            await f.db.sql.query<any>(
              "SELECT kind,payload FROM information_atoms WHERE information_id=$1",
              [payload.receiptId],
            )
          ).rows[0];
          const unproved = await f.append(original.kind, original.payload);
          await f.db.sql.query(
            "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES($1,$2,$3)",
            [unproved, first.intent_id, `legacy:${unproved}`],
          );
          payload.receiptId = unproved;
          payload.value.receiptId = unproved;
          payload.outputBytes = Buffer.byteLength(
            JSON.stringify(payload.value),
          );
        }
        if (
          ["result-envelope", "projection", "receipt-ref"].includes(mutation)
        ) {
          const replacement = await f.append(
            "agent.heavy.tool.result.v1",
            payload,
            [
              first.run_id,
              first.completed_id,
              ...(payload.receiptId ? [payload.receiptId] : []),
            ],
          );
          await f.db.sql.query(
            "UPDATE information_native_tool_calls SET result_id=$2 WHERE run_id=$1 AND call_index=0",
            [first.run_id, replacement],
          );
        }
        if (mutation === "intent-original") {
          const input = (
            await f.db.sql.query<any>(
              "SELECT input FROM information_action_heads WHERE intent_id=$1",
              [first.intent_id],
            )
          ).rows[0].input;
          input.target = { changed: true };
          await f.db.sql.query(
            "UPDATE information_action_heads SET input=$2::jsonb,digest=$3 WHERE intent_id=$1",
            [first.intent_id, JSON.stringify(input), actionDigest(input)],
          );
        }
        await f.restart();
        const result = await f.loop.execute(f.request);
        expect(result.status).toBe(
          mutation === "valid" ? "completed" : "failed",
        );
        expect(f.providerCalls()).toBe(mutation === "valid" ? 2 : 1);
        expect(f.effects()).toBe(mutation === "valid" ? 2 : 1);
        expect(f.requests).toHaveLength(mutation === "valid" ? 2 : 1);
        await f.restart();
        expect(await f.loop.execute(f.request)).toEqual(result);
        expect(f.providerCalls()).toBe(mutation === "valid" ? 2 : 1);
      },
    );
    it("rejects a queued historical head that no longer matches its original fact before any provider effect", async () => {
      const f = await fixture(postgres);
      const bind = f.db.nativeTools.bind.bind(f.db.nativeTools);
      const crash = vi
        .spyOn(f.db.nativeTools, "bind")
        .mockImplementationOnce(async (...args) => {
          await bind(...args);
          throw new Error("crash after intent binding");
        });
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "crash after intent binding",
      );
      crash.mockRestore();
      const head = (
        await f.db.sql.query<any>(
          "SELECT intent_id,input FROM information_action_heads",
        )
      ).rows[0];
      head.input.target = { changed: true };
      await f.db.sql.query(
        "UPDATE information_action_heads SET input=$2::jsonb,digest=$3 WHERE intent_id=$1",
        [head.intent_id, JSON.stringify(head.input), actionDigest(head.input)],
      );
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.providerCalls()).toBe(0);
      expect(f.effects()).toBe(0);
    });
    it("excludes another native run's intent from recovery and cancellation", async () => {
      const f = await fixture(postgres);
      const bind = f.db.nativeTools.bind.bind(f.db.nativeTools);
      const crash = vi
        .spyOn(f.db.nativeTools, "bind")
        .mockImplementationOnce(async (...args) => {
          await bind(...args);
          throw new Error("crash after intent binding");
        });
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "crash after intent binding",
      );
      crash.mockRestore();
      const first = (
        await f.db.sql.query<any>("SELECT * FROM information_native_tool_calls")
      ).rows[0];
      const alternate = await f.alternate();
      f.generate(async () =>
        f.requests.length === 2 ? [call("call-1")] : "完成",
      );
      expect((await f.loop.execute(alternate.request)).status).toBe(
        "completed",
      );
      const foreign = (
        await f.db.sql.query<any>(
          "SELECT * FROM information_native_tool_calls WHERE run_id<>$1",
          [first.run_id],
        )
      ).rows[0];
      await f.db.sql.query(
        "UPDATE information_native_tool_calls SET intent_id=$2 WHERE run_id=$1",
        [first.run_id, foreign.intent_id],
      );
      expect(await f.db.nativeTools.intents(first.run_id)).toEqual([]);
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.providerCalls()).toBe(1);
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(3);
    });
    it("runs independent calls in parallel and projects results in call order", async () => {
      const f = await fixture(postgres, { parallelTools: true });
      let entered = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.behavior(async (input) => {
        entered++;
        if (input.intent.toolCallId === "first") await gate;
        return { ...outcome, result: { call: input.intent.toolCallId ?? "" } };
      });
      f.generate(async () =>
        f.requests.length === 1 ? [call("first"), call("second")] : "完成",
      );
      const work = f.loop.execute(f.request);
      const settled = Promise.allSettled([work]);
      cleanups.push(async () => {
        release();
        await settled;
      });
      await vi.waitFor(() => expect(entered).toBe(2), {
        timeout: 8000,
        interval: 20,
      });
      await vi.waitFor(
        async () => {
          const rows = (
            await f.db.sql.query<{ result_id: string | null }>(
              "SELECT result_id FROM information_native_tool_calls WHERE call_id='second'",
            )
          ).rows;
          expect(rows[0]?.result_id).toBeTruthy();
        },
        { timeout: 8000, interval: 20 },
      );
      release();
      expect((await work).status).toBe("completed");
      const results = f.requests[1].messages.flatMap((m: any) =>
        m.role === "tool" ? m.content : [],
      );
      expect(results.map((r: any) => r.toolCallId)).toEqual([
        "first",
        "second",
      ]);
      expect(f.providerCalls()).toBe(2);
    });
    it("pairs invalid and unknown calls without inventing action receipts", async () => {
      const f = await fixture(postgres);
      f.generate(async () =>
        f.requests.length === 1
          ? [
              {
                ...call("bad"),
                rawInput: "{",
                input: null,
                validation: "invalid-input",
              },
              { ...call("missing"), toolName: "unknown" },
            ]
          : "结束",
      );
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.effects()).toBe(0);
      const results = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
        )
      ).rows;
      expect(results).toHaveLength(2);
      expect(
        results.every(
          (r) =>
            r.payload.receiptId === null &&
            r.payload.value.evidence === "not-executed",
        ),
      ).toBe(true);
    });
    it("enforces cumulative call budget before dispatch", async () => {
      const f = await fixture(postgres, { budget: { maxCalls: 1 } });
      f.generate(async () => [call("a"), call("b")]);
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.effects()).toBe(0);
      expect(f.requests).toHaveLength(1);
    });
    it("checks original source withdrawal immediately before W3 admission", async () => {
      const f = await fixture(postgres);
      f.generate(async () => {
        if (f.requests.length === 1) {
          await f.withdraw();
          return [call("withdrawn")];
        }
        return "结束";
      });
      await f.loop.execute(f.request);
      expect(f.effects()).toBe(0);
      const receipts = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='core.action.result.v1'",
        )
      ).rows;
      expect(receipts[0]?.payload.outcome.status).toBe("rejected");
    });
    it.each([false, true])(
      "preserves ordinary receipt dependencies with Memory absent; withdrawal=%s",
      async (withdrawn) => {
        const f = await fixture(postgres, { noMemory: true });
        f.generate(async () => {
          if (f.requests.length === 1) return [call("first")];
          if (f.requests.length === 2) {
            const receipt = (
              await f.db.sql.query<any>(
                "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
              )
            ).rows[0].payload.receiptId;
            if (withdrawn)
              await f.db.memoryGraph.native.publish({
                operationId: "withdraw-receipt",
                actor: "manual",
                nodes: [],
                invalidations: [
                  {
                    kind: "source-withdrawal",
                    targetId: receipt,
                    reason: "测试撤回回执",
                  },
                ],
              });
            return [call("second")];
          }
          return "结束";
        });
        await f.loop.execute(f.request);
        expect(f.effects()).toBe(withdrawn ? 1 : 2);
      },
    );
    it("recovers an already paired fenced receipt without resuming the model", async () => {
      const f = await fixture(postgres);
      f.environmentFenced();
      await f.restart();
      const stop = vi
        .spyOn(f.db.nativeTools, "stop")
        .mockRejectedValueOnce(new Error("simulated crash before stop"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "simulated crash",
      );
      stop.mockRestore();
      await f.restart();
      await f.loop.execute(f.request);
      expect(f.requests).toHaveLength(1);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_steps"))
          .rows,
      ).toHaveLength(1);
    });
    it("recovers an actual receipt after projection failure without reexecuting", async () => {
      const f = await fixture(postgres);
      const project = vi
        .spyOn(f.db.nativeTools, "result")
        .mockRejectedValueOnce(new Error("projection failed"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "projection failed",
      );
      expect(f.effects()).toBe(1);
      project.mockRestore();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
    });
    it("rejects a changed frozen execution policy before using the old run", async () => {
      const f = await fixture(postgres);
      const project = vi
        .spyOn(f.db.nativeTools, "result")
        .mockRejectedValueOnce(new Error("projection failed"));
      await expect(f.loop.execute(f.request)).rejects.toThrow();
      project.mockRestore();
      f.tool.policyVersion = "2";
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(1);
      expect(f.effects()).toBe(1);
    });
    it.each(["dispatch", "bind"] as const)(
      "rolls back %s if the real claim expires before the outer transaction returns",
      async (phase) => {
        const f = await fixture(postgres);
        await f.db.information.reliable.configureSubscriptions([
          { subscriptionId: "test.native.claim", kind: sourceKind.kind },
        ]);
        // 配置在 source 之后，因此显式保存一个新的待处理投递，仍由真实 claim 取得 token。
        await f.db.sql.query(
          "INSERT INTO information_deliveries(subscription_id,information_id,state,attempts) VALUES($1,$2,'pending',0) ON CONFLICT DO NOTHING",
          ["test.native.claim", f.request.sourceInformationId],
        );
        const claim = (await f.db.information.reliable.claim(
          "test.native.claim",
          1200,
        ))!;
        expect(claim).toBeTruthy();
        const transact = f.db.sql.transaction.bind(f.db.sql);
        let crossed = false;
        const spy = vi
          .spyOn(f.db.sql, "transaction")
          .mockImplementation(async (run) =>
            transact(async (tx) =>
              run({
                exec: tx.exec.bind(tx),
                query: async <Row extends Record<string, unknown>>(
                  sql: string,
                  params?: readonly unknown[],
                ) => {
                  const result = await tx.query<Row>(sql, params);
                  if (
                    !crossed &&
                    sql.includes(
                      phase === "dispatch"
                        ? "SET steps_count=steps_count+1"
                        : "UPDATE information_native_tool_calls SET intent_id",
                    )
                  ) {
                    crossed = true;
                    await vi.waitFor(
                      async () => {
                        const row = (
                          await tx.query<{ expired: boolean }>(
                            "SELECT lease_until<=clock_timestamp() expired FROM information_deliveries WHERE subscription_id=$1 AND information_id=$2",
                            [claim.subscriptionId, claim.informationId],
                          )
                        ).rows[0];
                        expect(row?.expired).toBe(true);
                      },
                      { timeout: 8000, interval: 20 },
                    );
                  }
                  return result;
                },
              }),
            ),
          );
        const work = f.core.withClaim(claim, new AbortController().signal, () =>
          f.loop.execute(f.request),
        );
        await expect(work).rejects.toThrow();
        spy.mockRestore();
        expect(crossed).toBe(true);
        expect(f.providerCalls()).toBe(0);
        const runs = (
          await f.db.sql.query<any>(
            "SELECT * FROM information_native_tool_runs",
          )
        ).rows;
        expect(runs[0].steps_count).toBe(phase === "dispatch" ? 0 : 1);
        expect(
          (
            await f.db.sql.query(
              "SELECT * FROM information_native_tool_calls WHERE intent_id IS NOT NULL",
            )
          ).rows,
        ).toHaveLength(0);
        if (phase === "dispatch")
          expect(
            (
              await f.db.sql.query(
                "SELECT * FROM information_native_tool_steps WHERE dispatched_id IS NOT NULL",
              )
            ).rows,
          ).toHaveLength(0);
      },
    );
    it("rejects the wire input budget including the registered JSON schema", async () => {
      const f = await fixture(postgres, { budget: { maxContextBytes: 8000 } });
      f.tool.inputSchema = z
        .object({ value: z.string().describe("long-schema".repeat(2000)) })
        .strict();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(0);
      expect(f.providerCalls()).toBe(0);
      expect(
        (
          await f.db.sql.query(
            "SELECT * FROM information_native_tool_steps WHERE dispatched_id IS NOT NULL",
          )
        ).rows,
      ).toHaveLength(0);
    });
    it("bounds each request while accepting a ten minute run budget", async () => {
      const f = await fixture(postgres, { budget: { maxDurationMs: 600000 } });
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.requests.every((r) => r.timeoutMs <= 300000)).toBe(true);
    });
    it("stops admission and invokes W3 cancellation for a running tool", async () => {
      const f = await fixture(postgres);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered = false;
      f.behavior(async () => {
        entered = true;
        await gate;
        return outcome;
      });
      const cancel = vi.spyOn(f.provider, "cancel");
      const work = f.loop.execute(f.request);
      const settled = Promise.allSettled([work]);
      cleanups.push(async () => {
        release();
        await settled;
      });
      await vi.waitFor(() => expect(entered).toBe(true), {
        timeout: 8000,
        interval: 20,
      });
      const row = (
        await f.db.sql.query<any>(
          "SELECT run_id FROM information_native_tool_runs",
        )
      ).rows[0];
      await f.loop.cancel(row.run_id, f.request.sourceInformationId);
      release();
      await work;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(f.providerCalls()).toBe(1);
      expect(f.requests).toHaveLength(1);
      await f.restart();
      await f.loop.execute(f.request);
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
    });
    it("never repeats an unconfirmed model dispatch after terminal persistence fails", async () => {
      const f = await fixture(postgres);
      const spy = vi
        .spyOn(f.core, "commitTerminal")
        .mockImplementationOnce(async () => {
          throw new Error("model terminal storage failed");
        });
      await expect(f.loop.execute(f.request)).rejects.toThrow();
      spy.mockRestore();
      expect(f.requests).toHaveLength(1);
      await f.restart();
      const restored = await f.loop.execute(f.request);
      expect(restored).toMatchObject({
        status: "failed",
        error: {
          reasonCode: "dispatched-without-terminal",
          stage: "native-protocol",
          kind: "non-retryable",
        },
      });
      const failed = await f.core.get(restored.terminalInformationId);
      expect(failed?.kind).toBe("core.model.task.failed");
      expect(failed?.payload.error).toMatchObject({
        reasonCode: "dispatched-without-terminal",
      });
      const terminal = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.terminal.v1'",
        )
      ).rows[0].payload;
      expect(terminal).toMatchObject({
        reason: "model-outcome-unknown",
        modelResult: { error: { reasonCode: "dispatched-without-terminal" } },
      });
      await f.restart();
      expect(await f.loop.execute(f.request)).toEqual(restored);
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(0);
    });
    it("persists exact transcript trimming metadata with the actual request and preserves original results", async () => {
      const f = await fixture(postgres, {
        budget: { maxContextBytes: 12000 },
        noMemory: true,
      });
      f.behavior(async () => ({
        ...outcome,
        result: { value: "x".repeat(5000) },
      }));
      f.generate(async () =>
        f.requests.length <= 2 ? [call(`trim-${f.requests.length}`)] : "完成",
      );
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      const requests = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='core.model.task.requested' ORDER BY (payload->'nativeStep'->>'stepIndex')::integer",
        )
      ).rows.map((r) => r.payload);
      expect(requests).toHaveLength(3);
      const trimming = requests[2].contextTrimming;
      expect(trimming).toMatchObject({
        measurement: "native-message-array-json-utf8",
        truncated: true,
        omittedSegments: expect.any(Number),
      });
      const completed = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='core.model.task.completed' AND payload->'nativeStep'->>'stepIndex'='1'",
        )
      ).rows[0].payload;
      const paired = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1' ORDER BY (payload->>'stepIndex')::integer",
        )
      ).rows.map((r) => r.payload);
      const source = [
        ...requests[1].messages,
        ...completed.native.messages,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: paired[1].toolCallId,
              toolName: completed.toolCalls[0].toolName,
              output: { type: "json", value: paired[1].value },
            },
          ],
        },
      ];
      const expected = fitToolTranscriptWithMetadata(
        source,
        trimming.budgetBytes,
      );
      expect(trimming).toEqual(expected.metadata);
      expect(trimming.omittedSegments).toBeGreaterThan(0);
      expect(requests[2].messages.slice(0, -1)).toEqual(expected.messages);
      expect(requests[2].nativeStep.maxContextBytes).toBe(12000);
      expect(paired.map((p) => p.value.result.value.length)).toEqual([
        5000, 5000,
      ]);
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.requests).toHaveLength(3);
      expect(f.providerCalls()).toBe(2);
    });
    it("preserves the raw JSON Schema and delegates validation to the host", async () => {
      const f = await fixture(postgres);
      const raw = {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        required: ["value"],
        additionalProperties: false,
        $defs: { value: { type: "string", pattern: "^approved$" } },
      };
      delete (f.tool as any).inputSchema;
      (f.tool as any).jsonSchema = raw;
      const validate = vi.fn((value: any) => value.value === "approved");
      (f.tool as any).validateInput = validate;
      f.generate(async () =>
        f.requests.length === 1
          ? [call("validated", "test.tool", { value: "approved" })]
          : "完成",
      );
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(validate).toHaveBeenCalledOnce();
      expect(f.requests[0].tools[0].inputSchema).toEqual(raw);
      expect(f.providerCalls()).toBe(1);
    });
    it("rejects completed_B as evidence for observation_A while allowing B's own successor", async () => {
      const f = await fixture(postgres);
      await f.loop.execute(f.request);
      const b = await f.alternate();
      f.generate(async () =>
        f.requests.length === 3 ? [call("b-call")] : "B 完成",
      );
      const completed = await f.loop.execute(b.request);
      expect(completed.status).toBe("completed");
      await expect(
        f.db.actions.dependenciesFor(
          f.observation.observationId,
          completed.terminalInformationId,
        ),
      ).rejects.toThrow("action-native-observation-mismatch");
      const dependencies = await f.db.actions.dependenciesFor(
        b.observation.observationId,
        completed.terminalInformationId,
      );
      expect(
        await f.db.memoryGraph.native.checkDependencies(dependencies),
      ).toMatchObject({ valid: true });
    });
    it("rejects replacement of the step-zero Memory snapshot before dispatch", async () => {
      const f = await fixture(postgres);
      const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
      const spy = vi
        .spyOn(f.db.nativeTools, "freeze")
        .mockImplementationOnce((p, guard) =>
          freeze(
            { ...p, memory: { ...p.memory!, owners: ["forged-owner"] } },
            guard,
          ),
        );
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(0);
      expect(f.providerCalls()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_steps"))
          .rows,
      ).toHaveLength(0);
      spy.mockRestore();
    });
    it("keeps exact read/history revisions and permits a corrected successor without rewriting old knowledge", async () => {
      const f = await fixture(postgres, { memory: true });
      let nodeId = "";
      f.generate(async () => {
        switch (f.requests.length) {
          case 1:
            return [call("effect")];
          case 2: {
            const receipt = (
              await f.db.sql.query<any>(
                "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
              )
            ).rows[0].payload.receiptId;
            return [
              call("record", "memory.record", {
                content: "第一次工具观察",
                receiptIds: [receipt],
              }),
            ];
          }
          case 3:
            nodeId = (
              await f.db.sql.query<any>(
                "SELECT id FROM memory_nodes WHERE metadata->>'kind'='experience'",
              )
            ).rows[0].id;
            return [call("read", "memory.read", { id: nodeId, revision: 1 })];
          case 4:
            return [
              call("correct", "memory.correct", {
                id: nodeId,
                revision: 1,
                content: "修订后的工具观察",
                receiptIds: [],
              }),
            ];
          case 5:
            return [
              call("history", "memory.history", {
                id: nodeId,
                limit: 1,
                cursor: null,
              }),
            ];
          case 6: {
            const first = (
              await f.db.sql.query<any>(
                "SELECT a.payload FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id WHERE c.call_id='history'",
              )
            ).rows[0].payload.value.result;
            expect(first.nextCursor).toEqual(expect.any(String));
            return [
              call("history-next", "memory.history", {
                id: nodeId,
                limit: 1,
                cursor: first.nextCursor,
              }),
            ];
          }
          case 7:
            return [call("final-effect")];
          default:
            return "完成";
        }
      });
      const final = await f.loop.execute(f.request);
      expect(final.status).toBe("completed");
      expect(
        f.effects(),
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT payload FROM information_atoms WHERE kind='core.action.result.v1'",
            )
          ).rows.map((r: any) => ({
            tool: r.payload.intent.toolName,
            outcome: r.payload.outcome,
          })),
        ),
      ).toBe(2);
      const history = (
        await f.db.sql.query<any>(
          "SELECT a.payload FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id WHERE c.call_id='history'",
        )
      ).rows[0].payload.value.result;
      const historyNext = (
        await f.db.sql.query<any>(
          "SELECT a.payload FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id WHERE c.call_id='history-next'",
        )
      ).rows[0].payload.value.result;
      expect(history.items.map((i: any) => i.node.metadata.revision)).toEqual([
        2,
      ]);
      expect(
        historyNext.items.map((i: any) => i.node.metadata.revision),
      ).toEqual([1]);
      expect(historyNext.nextCursor).toBeNull();
      for (const page of [history, historyNext]) {
        expect(page.memorySnapshots).toHaveLength(1);
        expect(page.memorySnapshots[0].recalled[0].node).toEqual(
          page.items[0].node,
        );
        expect(page.memorySnapshots[0].cutoff.publicationPosition).toBe(
          page.items[0].position,
        );
      }
      const read = (
        await f.db.sql.query<any>(
          "SELECT a.payload FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id WHERE c.call_id='read'",
        )
      ).rows[0].payload.value.result;
      expect(read.items[0].node.content).toBe("第一次工具观察");
      expect(
        (
          await f.db.sql.query<any>(
            "SELECT metadata FROM memory_nodes WHERE id=$1",
            [nodeId],
          )
        ).rows[0].metadata.revision,
      ).toBe(2);
      const publications = await f.db.sql.query(
        "SELECT operation_id,nodes FROM memory_native_publications WHERE operation_id LIKE 'memory-tool:%' ORDER BY operation_id",
      );
      const outputs = await f.db.sql.query(
        "SELECT operation_id,input_hash,result FROM memory_native_tool_outputs ORDER BY operation_id",
      );
      expect(publications.rows).toHaveLength(2);
      expect(outputs.rows).toHaveLength(5);
      expect(f.requests).toHaveLength(8);
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.requests).toHaveLength(8);
      expect(f.effects()).toBe(2);
      expect(
        (
          await f.db.sql.query(
            "SELECT operation_id,nodes FROM memory_native_publications WHERE operation_id LIKE 'memory-tool:%' ORDER BY operation_id",
          )
        ).rows,
      ).toEqual(publications.rows);
      expect(
        (
          await f.db.sql.query(
            "SELECT operation_id,input_hash,result FROM memory_native_tool_outputs ORDER BY operation_id",
          )
        ).rows,
      ).toEqual(outputs.rows);
    }, 40000); // 八轮确定性 SQL/模型步骤和一次重连；不改变产品循环或单次持久等待预算。
    it("preserves the full receipt but stops when its projected output exceeds the budget", async () => {
      const f = await fixture(postgres, {
        budget: { maxToolOutputBytes: 256 },
      });
      f.behavior(async () => ({
        ...outcome,
        result: { text: "x".repeat(2000) },
      }));
      const stop = vi
        .spyOn(f.db.nativeTools, "stop")
        .mockRejectedValueOnce(new Error("crash after truncated projection"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "crash after truncated projection",
      );
      stop.mockRestore();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
      const result = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
        )
      ).rows[0].payload;
      expect(result.value.status).toBe("output-budget");
      const receipt = await f.core.get(result.receiptId);
      expect((receipt!.payload.outcome as any).result.text).toHaveLength(2000);
    });
    it("stops on cumulative rejection output budget and recovers the no-receipt projection", async () => {
      const f = await fixture(postgres, {
        budget: { maxTotalToolOutputBytes: 256 },
      });
      f.generate(async () =>
        f.requests.length === 1
          ? Array.from({ length: 4 }, (_, i) => ({
              ...call(`unknown-${i}`),
              toolName: "missing",
            }))
          : "不应生成",
      );
      const stop = vi
        .spyOn(f.db.nativeTools, "stop")
        .mockRejectedValueOnce(new Error("crash after rejection projection"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "crash after rejection projection",
      );
      stop.mockRestore();
      expect(f.requests).toHaveLength(1);
      const pairs = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
        )
      ).rows;
      expect(pairs).toHaveLength(4);
      expect(
        pairs.some((r) => r.payload.value.status === "output-budget"),
      ).toBe(true);
      expect(
        pairs.every(
          (r) => r.payload.receiptId === null && r.payload.intentId === null,
        ),
      ).toBe(true);
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      const terminal = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.terminal.v1'",
        )
      ).rows[0].payload;
      expect(terminal.reason).toBe("unknown");
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(0);
    });
    it("rejects duplicate native call IDs before any action is registered", async () => {
      const f = await fixture(postgres);
      f.generate(async () => [call("same"), call("same")]);
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.providerCalls()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_action_heads")).rows,
      ).toHaveLength(0);
    });
    it("queries Memory through model call and freezes the actual receipt snapshot", async () => {
      const f = await fixture(postgres, { memory: true });
      f.generate(async () =>
        f.requests.length === 1
          ? [call("memory-query", "memory.query", { query: "本轮" })]
          : "完成",
      );
      const result = await f.loop.execute(f.request);
      expect(
        result,
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT kind,payload FROM information_atoms WHERE kind LIKE 'core.action.%' OR kind='agent.heavy.tool.terminal.v1'",
            )
          ).rows,
        ),
      ).toMatchObject({ status: "completed" });
      const steps = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.step.frozen.v1' ORDER BY payload->>'stepIndex'",
        )
      ).rows;
      expect(steps).toHaveLength(2);
      expect(steps[1].payload.supplements).toHaveLength(1);
      expect(steps[1].payload.receiptIds).toHaveLength(1);
      expect(JSON.stringify(f.requests[1].messages)).toContain(
        "工具步骤冻结依据",
      );
    });
    it("publishes a selected action receipt and makes its new cutoff available only in the successor", async () => {
      const f = await fixture(postgres, { memory: true });
      let frozenOriginal = "";
      f.generate(async () => {
        if (f.requests.length === 1) {
          frozenOriginal = JSON.stringify(
            (
              await f.db.sql.query<any>(
                "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.step.frozen.v1'",
              )
            ).rows[0].payload,
          );
          return [call("effect")];
        }
        if (f.requests.length === 2) {
          const receipt = (
            await f.db.sql.query<any>(
              "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
            )
          ).rows[0].payload.receiptId;
          return [
            call("record", "memory.record", {
              content: "工具返回了数值 7",
              receiptIds: [receipt],
            }),
          ];
        }
        return "完成";
      });
      const result = await f.loop.execute(f.request);
      expect(
        result,
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT kind,payload FROM information_atoms WHERE kind LIKE 'core.action.%' OR kind='agent.heavy.tool.terminal.v1'",
            )
          ).rows,
        ),
      ).toMatchObject({ status: "completed" });
      expect(f.effects()).toBe(1);
      const proof = await f.db.actions.dependenciesFor(
        f.observation.observationId,
        result.terminalInformationId,
      );
      expect(
        await f.db.memoryGraph.native.checkDependencies(proof),
      ).toMatchObject({ valid: true });
      const nodes = (
        await f.db.sql.query<any>(
          "SELECT metadata,content FROM memory_nodes WHERE metadata->>'kind'='experience'",
        )
      ).rows;
      expect(nodes).toHaveLength(1);
      expect(nodes[0].metadata.ownerId).toBe("self:kaguya");
      expect(
        nodes[0].metadata.proofOwners.some(
          (p: any) => p.ownerId === `conversation:${f.scope}`,
        ),
      ).toBe(true);
      const steps = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.step.frozen.v1' ORDER BY (payload->>'stepIndex')::int",
        )
      ).rows;
      expect(steps).toHaveLength(3);
      expect(JSON.stringify(steps[0].payload)).toBe(frozenOriginal);
      expect(steps[1].payload.memory.cutoff).toEqual(
        steps[0].payload.memory.cutoff,
      );
      expect(
        BigInt(steps[2].payload.memory.cutoff.publicationPosition),
      ).toBeGreaterThan(
        BigInt(steps[0].payload.memory.cutoff.publicationPosition),
      );
      await f.withdraw();
      const snapshot = await createNativeMemoryAccess({
        enabled: true,
        store: f.db.memoryGraph.native,
      }).freeze({
        scope: f.scope,
        owners: ["self:kaguya"],
        asOf: new Date().toISOString(),
        query: "数值",
        explicitIds: [
          nodes[0].metadata.id ??
            (
              await f.db.sql.query<any>(
                "SELECT id FROM memory_nodes WHERE metadata->>'kind'='experience'",
              )
            ).rows[0].id,
        ],
      });
      expect(snapshot.recalled).toHaveLength(0);
    });
  });
it("aliases are stable, collision-separated and provider-safe", () => {
  expect(nativeToolWireName("a.b", "1")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(nativeToolWireName("a.b", "1")).not.toBe(
    nativeToolWireName("a_b", "1"),
  );
});
it("drops only complete interactions and rejects orphan tool results", () => {
  const pair: any[] = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "t", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "t",
          output: { type: "json", value: 1 },
        },
      ],
    },
  ];
  const last: any = { role: "user", content: "new" };
  expect(fitToolTranscript([...pair, last], 50)).toEqual([last]);
  expect(fitToolTranscriptWithMetadata([...pair, last], 50).metadata).toEqual({
    measurement: "native-message-array-json-utf8",
    truncated: true,
    omittedSegments: 1,
    originalBytes: Buffer.byteLength(JSON.stringify([...pair, last])),
    retainedBytes: Buffer.byteLength(JSON.stringify([last])),
    budgetBytes: 50,
  });
  expect(fitToolTranscriptWithMetadata(pair, 1000).metadata).toMatchObject({
    truncated: false,
    omittedSegments: 0,
  });
  expect(() => fitToolTranscript([pair[1]], 1000)).toThrow(
    "native-orphan-result",
  );
  const wrongName = structuredClone(pair);
  wrongName[1].content[0].toolName = "other";
  expect(() => fitToolTranscript(wrongName, 1000)).toThrow(
    "native-orphan-result",
  );
  const wrongRole = structuredClone(pair);
  wrongRole[1].role = "assistant";
  expect(() => fitToolTranscript(wrongRole, 1000)).toThrow(
    "native-orphan-result",
  );
  const wrongCallRole = structuredClone(pair);
  wrongCallRole[0].role = "user";
  expect(() => fitToolTranscript(wrongCallRole, 1000)).toThrow(
    "native-invalid-call",
  );
  expect(fitToolTranscript([pair[0]], 1000)).toEqual([pair[0]]);
});
