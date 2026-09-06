/**
 * 功能概述：本文件验证信息模块以显式 kind 串接入站、turn context、speech decision、回复、通用 Model Task 完成、assistant 和投递阶段，
 * 不再以旧事件、target instance 或成功 decision 驱动下一步。
 * 主要职责：过滤器用例验证兼容的拒绝事实；speech DAG 用例验证 speak 才注册回复请求，回复用例
 * 验证三个订阅分别承担回复执行、Model Task 完成到 assistant、assistant 到投递的直接因果阶段；
 * completion 仅能跨同 definition 的 instance 共享，其他 definition 的伪造终态不会派生业务输出。
 * 代码库关系：覆盖最终 `always-reply-filter.ts`、`llm-reply.ts` 和
 * `information-kinds.ts`；engine `ModuleHost` 为每一次 register 自动补齐直接的
 * `core:caused-by` 与继承的 `core:context`，因此模块 handler 不伪造这些保留引用。
 * 输入输出与副作用：单元用例使用冻结 atom 与内存 register；集成用例使用真实 Core、宿主和
 * PGlite 账本，模块侧以结构契约 fixture 提供通用任务能力，断言实际 ID、持久化顺序及 context 继承；
 * 真实 ModelTaskClient 与共享 Runtime token/definition 的装配由 runtime.test.ts 覆盖，避免测试反向包依赖。
 * 不访问真实 LLM；schema 断言保护删除的 profile 与 reply target 设置不会重新进入模块契约。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import { defineInformationModuleCatalog } from "@kaguya/sdk";
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationIdSchema,
  type InformationAtom,
  type InformationId,
  type InformationReference,
  type JsonObject,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineModuleCapability,
  onInformation,
  type InformationFindQuery,
  type InformationKindDefinition,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
  type InformationLedger,
  type InformationReferenceExpectation,
} from "@kaguya/engine";

import {
  alwaysReplyFilterModule,
  alwaysReplyFilterSettingsSchema,
} from "./always-reply-filter.js";
import {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  deliveryRequestedInformationKind,
  filterDecisionInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  speechDecisionInformationKind,
  turnContextCompletedInformationKind,
  waitRequestedInformationKind,
} from "./information-kinds.js";
import {
  createLlmReplyModule as defineReplyModule,
  llmReplySettingsSchema,
  type ModelTaskCapability,
  type ModelTaskRequest,
} from "./llm-reply.js";
import * as informationKinds from "./information-kinds.js";
import { speechDecisionModule } from "./speech-decision.js";
import { speechReplyModule } from "./speech-reply.js";
import { turnContextModule } from "./turn-context.js";

const contextId = informationIdSchema.parse("context-1");
const inboundPayload = replyRequestedInformationPayloadSchema.parse({
  text: "hello",
  source: {
    adapterId: "adapter",
    platform: "qq",
    platformMessageId: "request-1",
    destination: { kind: "group", groupId: "group-1" },
    senderId: "sender-1",
  },
});

const runtimeContextInformationKind = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({ requestId: z.string().min(1) }).strict(),
  references: {},
  log: { enabled: false },
});

const modelTaskCapability = defineModuleCapability<ModelTaskCapability>(
  "kaguya:model-task",
  1,
);

const modelTaskRequestedInformationKind = defineInformationKind({
  kind: "core.model.task.requested",
  payloadSchema: z.object({}).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [runtimeContextInformationKind.kind],
    },
    "core:uses-context": { required: true, multiple: true },
  },
  log: { enabled: false },
});

const modelTaskCompletedInformationKind = defineInformationKind({
  kind: "core.model.task.completed",
  payloadSchema: z
    .object({
      taskId: z.string().min(1),
      version: z.string().min(1),
      sourceInformationId: informationIdSchema,
      activation: z
        .object({
          instanceId: z.string().min(1),
          definitionId: z.string().min(1),
        })
        .strict(),
      selectionPolicy: z.object({ tier: z.enum(["light", "heavy"]) }).strict(),
      output: z.object({ text: z.string().min(1) }).strict(),
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [modelTaskRequestedInformationKind.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [modelTaskRequestedInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [runtimeContextInformationKind.kind],
    },
  },
  log: { enabled: false },
});

const modelTaskInformationKinds = [
  modelTaskRequestedInformationKind,
  modelTaskCompletedInformationKind,
] as const;

class MemoryInformationLedger implements InformationLedger {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();

  async synchronizeKinds(): Promise<void> {}

  async append(
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
  ): Promise<void> {
    if (this.atoms.has(atom.informationId))
      throw new Error("duplicate information id");
    const byRelation = new Map(
      expectations.map((expectation) => [expectation.relation, expectation]),
    );
    const counts = new Map<string, number>();
    for (const reference of atom.references) {
      const expectation = byRelation.get(reference.relation);
      if (expectation === undefined)
        throw new Error(`undeclared reference: ${reference.relation}`);
      counts.set(reference.relation, (counts.get(reference.relation) ?? 0) + 1);
      if (!expectation.multiple && counts.get(reference.relation)! > 1) {
        throw new Error(`multiple references: ${reference.relation}`);
      }
      const target = this.atoms.get(reference.informationId);
      if (target === undefined)
        throw new Error(`missing reference: ${reference.informationId}`);
      if (
        expectation.targetKinds !== undefined &&
        !expectation.targetKinds.includes(target.kind)
      ) {
        throw new Error(`wrong reference kind: ${reference.relation}`);
      }
    }
    for (const expectation of expectations) {
      if (expectation.required && !counts.has(expectation.relation)) {
        throw new Error(`missing required reference: ${expectation.relation}`);
      }
    }
    this.atoms.set(
      atom.informationId,
      freezeInformationAtom(atom as InformationAtom),
    );
  }

  async get(informationId: InformationId) {
    return this.atoms.get(informationId);
  }

  async getMany(informationIds: readonly InformationId[]) {
    return informationIds.flatMap((informationId) => {
      const atom = this.atoms.get(informationId);
      return atom === undefined ? [] : [atom];
    });
  }

  async find(query: InformationFindQuery) {
    return [...this.atoms.values()]
      .filter(
        (atom) =>
          (query.kinds === undefined || query.kinds.includes(atom.kind)) &&
          (query.sources === undefined ||
            query.sources.includes(atom.source)) &&
          (query.occurredAfter === undefined ||
            Date.parse(atom.occurredAt) >= Date.parse(query.occurredAfter)) &&
          (query.occurredBefore === undefined ||
            Date.parse(atom.occurredAt) < Date.parse(query.occurredBefore)),
      )
      .sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          left.informationId.localeCompare(right.informationId),
      )
      .slice(0, query.limit);
  }

  async query() {
    return [...this.atoms.values()];
  }
}

function inboundAtom() {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("inbound-1"),
    kind: inboundTextInformationKind.kind,
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "adapter:test",
    payload: inboundPayload,
    references: [{ relation: "core:context", informationId: contextId }],
  });
}

function replyAtom() {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("reply-1"),
    kind: replyRequestedInformationKind.kind,
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "module:filter-1",
    payload: inboundPayload,
    references: [{ relation: "core:context", informationId: contextId }],
  });
}

function memoryAtom() {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("memory-1"),
    kind: coreMemoryTextInformationKind.kind,
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "module:memory",
    payload: { text: "likes tea" },
    references: [],
  });
}

function completedAtom() {
  const reply = replyAtom();
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("completion-1"),
    kind: modelTaskCompletedInformationKind.kind,
    occurredAt: "2026-09-04T00:00:01.000Z",
    source: "runtime:model-task",
    payload: {
      output: { text: "Hello." },
      taskId: "core.reply.generate",
      version: "1",
      sourceInformationId: reply.informationId,
      activation: { instanceId: "reply-1", definitionId: "demo.reply.llm" },
      selectionPolicy: { tier: "heavy" },
    },
    references: [
      { relation: "core:caused-by", informationId: reply.informationId },
      { relation: "core:context", informationId: contextId },
    ],
  });
}

function assistantAtom() {
  const completed = completedAtom();
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("assistant-1"),
    kind: assistantTextInformationKind.kind,
    occurredAt: "2026-09-04T00:00:02.000Z",
    source: "module:reply-1",
    payload: {
      text: "Hello.",
      source: inboundPayload.source,
      originatingModuleInstanceId: "reply-1",
    },
    references: [
      { relation: "core:caused-by", informationId: completed.informationId },
      { relation: "core:context", informationId: contextId },
    ],
  });
}

const executors = new WeakMap<object, ModelTaskCapability>();
function createLlmReplyModule(
  options: Omit<
    Parameters<
      typeof defineReplyModule<
        z.infer<typeof modelTaskCompletedInformationKind.payloadSchema>
      >
    >[0],
    "modelTaskCapability"
  > & {
    executor: ModelTaskCapability;
  },
) {
  const { executor, ...definitionOptions } = options;
  const definition = defineReplyModule({
    ...definitionOptions,
    modelTaskCapability,
  });
  executors.set(definition, executor);
  return definition;
}
function createInstance(
  definition: ReturnType<typeof defineInformationModule>,
  options: { instanceId: string; settings: unknown },
) {
  return definition.create(
    {
      ...options,
      activation: {
        instanceId: options.instanceId,
        definitionId: definition.manifest.definitionId,
      },
    },
    {
      signal: new AbortController().signal,
      now: () => new Date(),
      use: () => {
        const value = executors.get(definition);
        if (!value) throw Error("undeclared");
        return value as never;
      },
    },
  );
}

interface Registration {
  readonly definition: InformationKindDefinition<string, JsonObject>;
  readonly input: {
    readonly payload: JsonObject;
    readonly references?: readonly InformationReference[];
  };
}

function handlerContext(
  sourceAtom: DeepReadonly<InformationAtom>,
  registrations: Registration[],
  result: DeepReadonly<InformationAtom> = sourceAtom,
  instanceId = "test.instance",
  selectedAtoms: readonly DeepReadonly<InformationAtom>[] = [sourceAtom],
  executor?: ModelTaskCapability,
): InformationModuleHandlerContext {
  const context: InformationModuleHandlerContext = {
    registerOnce: async (_operation, _key, definition, input) =>
      context.register(definition, input),
    commitTerminal: async (_group, _subject, definition, input) =>
      context.register(definition, input),
    signal: new AbortController().signal,
    use: (token) => {
      if (!Object.is(token, modelTaskCapability))
        throw new Error("unexpected capability");
      if (!executor) throw new Error("undeclared test capability");
      return executor as never;
    },
    definitionId: "test.definition",
    instanceId,
    sourceAtom,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    select: async () => selectedAtoms,
    register: async (definition, input) => {
      registrations.push({
        definition: definition as unknown as InformationKindDefinition<
          string,
          JsonObject
        >,
        input: input as Registration["input"],
      });
      return result as never;
    },
  };
  return context;
}

describe("alwaysReplyFilterModule", () => {
  it("registers the next kind when the filter passes", async () => {
    const instance = await createInstance(alwaysReplyFilterModule, {
      instanceId: "filter-1",
      settings: alwaysReplyFilterSettingsSchema.parse({}),
    });
    const atom = inboundAtom();
    const registrations: Registration[] = [];

    await instance.subscriptions[0]?.handle(
      atom,
      handlerContext(atom, registrations),
    );

    expect([
      ...alwaysReplyFilterModule.manifest.consumes,
      ...alwaysReplyFilterModule.manifest.produces,
    ]).toEqual([inboundTextInformationKind, replyRequestedInformationKind]);
    expect(registrations).toEqual([
      {
        definition: replyRequestedInformationKind,
        input: { payload: atom.payload },
      },
    ]);
  });

  it("records rejection without producing the next kind", async () => {
    const rejectingFilter = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        moduleVersion: "1.0.0",
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
        definitionId: "test.filter.rejecting",
        displayName: "Rejecting filter",
        settingsSchema: z.object({}).strict(),
        consumes: [inboundTextInformationKind, filterDecisionInformationKind],
        produces: [inboundTextInformationKind, filterDecisionInformationKind],
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
              await context.register(filterDecisionInformationKind, {
                payload: {
                  accepted: false,
                  reason: "blocked",
                  filterDefinitionId: "test.filter.rejecting",
                },
              });
            },
          ),
        ],
      }),
    });
    const atom = inboundAtom();
    const registrations: Registration[] = [];
    const instance = await createInstance(rejectingFilter, {
      instanceId: "reject-1",
      settings: {},
    });

    await instance.subscriptions[0]?.handle(
      atom,
      handlerContext(atom, registrations),
    );

    expect(registrations).toEqual([
      {
        definition: filterDecisionInformationKind,
        input: {
          payload: {
            accepted: false,
            reason: "blocked",
            filterDefinitionId: "test.filter.rejecting",
          },
        },
      },
    ]);
  });

  it("strictly rejects removed reply targets", () => {
    expect(
      alwaysReplyFilterSettingsSchema.safeParse({
        replyTargetInstanceId: "reply-1",
      }).success,
    ).toBe(false);
    expect(
      alwaysReplyFilterSettingsSchema.safeParse({
        profileId: "profile-1",
      }).success,
    ).toBe(false);
  });
});

describe("createLlmReplyModule", () => {
  it("declares only the host-approved generic model-call capability", () => {
    const definition = defineReplyModule({
      modelTaskCapability,
      modelTaskCompletedInformationKind,
    });
    expect(definition.manifest.requires).toEqual([
      { id: "kaguya:model-task", apiVersion: 1 },
    ]);
  });
  it("stores Memory with ordered uses-context references", async () => {
    expect(informationKinds).toHaveProperty("coreMemoryTextInformationKind");
    const memoryKind = (
      informationKinds as typeof informationKinds & {
        coreMemoryTextInformationKind: InformationKindDefinition<
          "core.memory.text",
          { text: string }
        >;
      }
    ).coreMemoryTextInformationKind;
    expect(memoryKind.references).toMatchObject({
      "core:caused-by": { required: true, multiple: false },
      "core:context": {
        required: true,
        multiple: false,
        targetKinds: ["core.runtime.context"],
      },
      "core:uses-context": { required: true, multiple: true },
    });

    const registry = new InformationKindRegistry();
    registry.registerBuiltin(runtimeContextInformationKind);
    registry.registerBuiltin(inboundTextInformationKind);
    registry.registerBuiltin(memoryKind);
    const ledger = new MemoryInformationLedger();
    let sequence = 0;
    const core = new InformationCore({
      registry,
      store: ledger,
      nextInformationId: () => `memory-test-${++sequence}`,
      now: () => new Date("2026-09-04T00:00:02.000Z"),
    });
    const memoryModule = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        moduleVersion: "1.0.0",
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
        definitionId: "test.memory-writer",
        displayName: "Memory writer",
        settingsSchema: z.object({}).strict(),
        consumes: [inboundTextInformationKind, memoryKind],
        produces: [inboundTextInformationKind, memoryKind],
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
            async (inbound, context) => {
              const runtimeContext = inbound.references.find(
                ({ relation }) => relation === "core:context",
              );
              if (runtimeContext === undefined) {
                throw new Error("runtime context is required");
              }
              await context.register(memoryKind, {
                payload: { text: "likes tea" },
                references: [
                  {
                    relation: "core:uses-context",
                    informationId: runtimeContext.informationId,
                  },
                  {
                    relation: "core:uses-context",
                    informationId: inbound.informationId,
                  },
                ],
              });
            },
          ),
        ],
      }),
    });
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(memoryModule),
    });
    await core.start();
    await host.start([
      {
        instanceId: "memory.writer",
        definitionId: memoryModule.manifest.definitionId,
        settings: {},
      },
    ]);

    try {
      const runtimeContext = await core.register(
        runtimeContextInformationKind,
        {
          occurredAt: "2026-09-04T00:00:00.000Z",
          source: "core:runtime",
          payload: { requestId: "request-memory" },
          references: [],
        },
      );
      const inbound = await core.register(inboundTextInformationKind, {
        occurredAt: "2026-09-04T00:00:01.000Z",
        source: "adapter:test",
        payload: inboundPayload,
        references: [
          {
            relation: "core:context",
            informationId: runtimeContext.informationId,
          },
        ],
      });
      const memory = [...ledger.atoms.values()].find(
        ({ kind }) => kind === memoryKind.kind,
      );

      expect(
        memory?.references
          .filter(({ relation }) => relation === "core:uses-context")
          .map(({ informationId }) => informationId),
      ).toEqual([runtimeContext.informationId, inbound.informationId]);
    } finally {
      await host.stop();
    }
  });

  it("persists the full DAG with direct causes and one inherited context", async () => {
    const registry = new InformationKindRegistry();
    registry.registerBuiltin(runtimeContextInformationKind);
    registry.registerBuiltin(inboundTextInformationKind);
    registry.registerBuiltin(replyRequestedInformationKind);
    registry.register(turnContextCompletedInformationKind);
    registry.register(speechDecisionInformationKind);
    registry.register(waitRequestedInformationKind);
    for (const kind of modelTaskInformationKinds)
      registry.registerBuiltin(kind);
    registry.registerBuiltin(assistantTextInformationKind);
    registry.registerBuiltin(deliveryRequestedInformationKind);
    registry.registerBuiltin(coreMemoryTextInformationKind);
    const database = await createTestingDatabase();
    await database.migrate();
    const ledger = database.information;
    let sequence = 0;
    const core = new InformationCore({
      registry,
      store: ledger,
      nextInformationId: () => `information-${++sequence}`,
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    });
    const replyModule = createLlmReplyModule({
      modelTaskCompletedInformationKind,
      executor: {
        async execute(input) {
          const requested = await core.registerOnce(
            "test.model-task.requested",
            input.sourceInformationId,
            modelTaskRequestedInformationKind,
            {
              occurredAt: "2026-09-04T00:00:01.000Z",
              source: "runtime:model-task",
              payload: {},
              references: [
                {
                  relation: "core:caused-by",
                  informationId: input.sourceInformationId,
                },
                {
                  relation: "core:context",
                  informationId: input.contextInformationId,
                },
                ...input.contextAtoms.map(({ informationId }) => ({
                  relation: "core:uses-context" as const,
                  informationId,
                })),
              ],
            },
          );
          const completed = await core.commitTerminal(
            "test.model-task.terminal",
            requested.informationId,
            modelTaskCompletedInformationKind,
            {
              occurredAt: "2026-09-04T00:00:02.000Z",
              source: "runtime:model-task",
              payload: {
                taskId: input.task.taskId,
                version: input.task.version,
                sourceInformationId: input.sourceInformationId,
                activation: { ...input.activation },
                selectionPolicy: { ...input.selectionPolicy },
                output: { text: "Hello." },
              },
              references: [
                {
                  relation: "core:caused-by",
                  informationId: requested.informationId,
                },
                {
                  relation: "core:status-of",
                  informationId: requested.informationId,
                },
                {
                  relation: "core:context",
                  informationId: input.contextInformationId,
                },
              ],
            },
          );
          return {
            status: "completed",
            output: input.task.outputSchema.parse(
              modelTaskCompletedInformationKind.payloadSchema.parse(
                completed.payload,
              ).output,
            ),
            requestedInformationId: requested.informationId,
            terminalInformationId: completed.informationId,
          };
        },
        cancel: async () => {
          throw new Error("unexpected cancellation");
        },
      },
    });
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(
        turnContextModule,
        speechDecisionModule,
        speechReplyModule,
        replyModule,
      ),
      capabilities: [
        {
          capability: modelTaskCapability,
          value: executors.get(replyModule)!,
        },
      ],
    });
    await core.start();
    await host.start([
      {
        instanceId: "turn-context-1",
        definitionId: turnContextModule.manifest.definitionId,
        settings: {},
      },
      {
        instanceId: "speech-decision-1",
        definitionId: speechDecisionModule.manifest.definitionId,
        settings: {},
      },
      {
        instanceId: "speech-reply-1",
        definitionId: speechReplyModule.manifest.definitionId,
        settings: {},
      },
      {
        instanceId: "reply-1",
        definitionId: replyModule.manifest.definitionId,
        settings: {
          modelTier: "heavy",
          outbound: { mode: "source", messageKind: "reply" },
        },
      },
    ]);

    try {
      const context = await core.register(runtimeContextInformationKind, {
        occurredAt: "2026-09-04T00:00:00.000Z",
        source: "core:runtime",
        payload: { requestId: "request-1" },
        references: [],
      });
      const inbound = await core.register(inboundTextInformationKind, {
        occurredAt: "2026-09-04T00:00:00.000Z",
        source: "adapter:test",
        payload: inboundPayload,
        references: [
          { relation: "core:context", informationId: context.informationId },
        ],
      });
      const completedSource = await vi.waitFor(async () => {
        const completed = (
          await ledger.query({ informationId: context.informationId })
        ).find((atom) => atom.kind === modelTaskCompletedInformationKind.kind);
        expect(completed).toBeDefined();
        return completed!;
      });
      const sourceSelector = replyModule.manifest.selectors.find(
        (selector) => selector.selectorId === "kaguya.reply.completed-source",
      )!;
      expect(
        (await core.select(sourceSelector, completedSource.informationId)).map(
          (atom) => atom.informationId,
        ),
      ).toEqual([completedSource.payload.sourceInformationId]);
      await vi.waitFor(async () =>
        expect(
          (await ledger.query({ informationId: context.informationId })).map(
            (a) => a.kind,
          ),
        ).toContain(deliveryRequestedInformationKind.kind),
      );
      const atoms = [
        context,
        ...(await ledger.query({
          informationId: context.informationId,
        })),
      ];
      const reply = atoms.find(
        ({ kind }) => kind === replyRequestedInformationKind.kind,
      );
      const turnContext = atoms.find(
        ({ kind }) => kind === turnContextCompletedInformationKind.kind,
      );
      const decision = atoms.find(
        ({ kind }) => kind === speechDecisionInformationKind.kind,
      );
      const requested = atoms.find(
        ({ kind }) => kind === modelTaskRequestedInformationKind.kind,
      );
      const completed = atoms.find(
        ({ kind }) => kind === modelTaskCompletedInformationKind.kind,
      );
      const assistant = atoms.find(
        ({ kind }) => kind === assistantTextInformationKind.kind,
      );
      const delivery = atoms.find(
        ({ kind }) => kind === deliveryRequestedInformationKind.kind,
      );

      expect(atoms.map(({ kind }) => kind).sort()).toEqual(
        [
          runtimeContextInformationKind.kind,
          inboundTextInformationKind.kind,
          turnContextCompletedInformationKind.kind,
          speechDecisionInformationKind.kind,
          replyRequestedInformationKind.kind,
          modelTaskRequestedInformationKind.kind,
          modelTaskCompletedInformationKind.kind,
          assistantTextInformationKind.kind,
          deliveryRequestedInformationKind.kind,
        ].sort(),
      );
      expect(reply?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: decision?.informationId,
      });
      expect(reply?.references).toContainEqual({
        relation: "core:uses-context",
        informationId: turnContext?.informationId,
      });
      expect(requested?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: reply?.informationId,
      });
      expect(completed?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: requested?.informationId,
      });
      expect(assistant?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: completed?.informationId,
      });
      expect(delivery?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: assistant?.informationId,
      });
      // A durable replay of the same turn context must return the existing
      // speech terminal and leave the downstream reply DAG unchanged.
      const decisionPayload = speechDecisionInformationKind.payloadSchema.parse(
        decision!.payload,
      );
      const candidateInformationId = z.string().parse(
        decisionPayload.candidateInformationId,
      );
      const replayedDecision = await core.commitTerminal(
        "core.speech.decision",
        candidateInformationId,
        speechDecisionInformationKind,
        {
          occurredAt: decision!.occurredAt,
          source: decision!.source,
          payload: decisionPayload,
          references: decision!.references,
        },
      );
      expect(replayedDecision.informationId).toBe(decision!.informationId);
      const replayGraph = await ledger.query({
        informationId: context.informationId,
      });
      expect(
        replayGraph.filter(({ kind }) => kind === speechDecisionInformationKind.kind),
      ).toHaveLength(1);
      expect(
        replayGraph.filter(({ kind }) => kind === replyRequestedInformationKind.kind),
      ).toHaveLength(1);
      for (const atom of [inbound, reply, completed, assistant, delivery]) {
        expect(atom?.references).toContainEqual({
          relation: "core:context",
          informationId: context.informationId,
        });
      }
    } finally {
      await host.stop();
      await core.close();
      await database.close();
    }
  });

  it("declares each direct causal edge and the shared context requirement", () => {
    expect(replyRequestedInformationKind.references).toMatchObject({
      "core:caused-by": { targetKinds: ["agent.speech.decision"] },
      "core:context": { targetKinds: ["core.runtime.context"] },
      "core:uses-context": {
        required: true,
        targetKinds: ["agent.turn.context.completed"],
      },
    });
    expect(assistantTextInformationKind.references).toMatchObject({
      "core:caused-by": {
        targetKinds: [modelTaskCompletedInformationKind.kind],
      },
      "core:context": { targetKinds: ["core.runtime.context"] },
    });
    expect(deliveryRequestedInformationKind.references).toMatchObject({
      "core:caused-by": { targetKinds: [assistantTextInformationKind.kind] },
      "core:context": { targetKinds: ["core.runtime.context"] },
    });
  });

  it("requires the generic capability and passes the reloaded source, prompt, schema and activation", async () => {
    let request: ModelTaskRequest<unknown> | undefined;
    const executor: ModelTaskCapability = {
      async execute(input) {
        request = input;
        return {
          status: "completed",
          output: input.task.outputSchema.parse({ text: "Hello." }),
          requestedInformationId: "requested-1",
          terminalInformationId: "completion-1",
        };
      },
      cancel: async () => {
        throw new Error("unexpected cancellation");
      },
    };
    const definition = createLlmReplyModule({
      executor,
      modelTaskCompletedInformationKind,
    });
    const instance = await createInstance(definition, {
      instanceId: "reply-1",
      settings: {
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      },
    });
    expect(definition.manifest.requires).toEqual([
      { id: "kaguya:model-task", apiVersion: 1 },
    ]);
    const selected = [memoryAtom(), replyAtom()];
    const registrations: Registration[] = [];
    const context = handlerContext(
      replyAtom(),
      registrations,
      replyAtom(),
      "reply-1",
      selected,
      executor,
    );
    const use = vi.spyOn(context, "use");
    await instance.subscriptions[0]!.handle(replyAtom(), context);
    expect(use).toHaveBeenCalledWith(modelTaskCapability);
    expect(request).toMatchObject({
      task: {
        taskId: "core.reply.generate",
        version: "1",
        allowedTiers: ["light", "heavy"],
      },
      sourceInformationId: "reply-1",
      contextInformationId: "context-1",
      activation: { instanceId: "reply-1", definitionId: "demo.reply.llm" },
      selectionPolicy: { tier: "heavy" },
      prompt: {
        provenance: [
          expect.objectContaining({ informationId: "memory-1" }),
          expect.objectContaining({ informationId: "reply-1" }),
        ],
      },
    });
    expect(request!.contextAtoms).toBe(selected);
    expect(request!.task.outputSchema.safeParse({ text: "ok" }).success).toBe(
      true,
    );
    for (const output of [
      { text: "" },
      { text: 1 },
      { text: "ok", extra: true },
    ])
      expect(request!.task.outputSchema.safeParse(output).success).toBe(false);
    expect(registrations).toEqual([]);
    const unavailable = handlerContext(replyAtom(), []);
    await expect(
      instance.subscriptions[0]!.handle(replyAtom(), unavailable),
    ).rejects.toThrow("undeclared test capability");
  });

  it.each(["failed", "cancelled"] as const)(
    "does not register business atoms for a %s Model Task winner",
    async (status) => {
      const executor: ModelTaskCapability = {
        execute: async () =>
          status === "failed"
            ? {
                status,
                requestedInformationId: "requested-1",
                terminalInformationId: "terminal-1",
                error: {
                  name: "ModelTaskError",
                  kind: "non-retryable",
                  message: "Model task generation failed",
                },
              }
            : {
                status,
                requestedInformationId: "requested-1",
                terminalInformationId: "terminal-1",
                reason: "Explicit cancellation requested",
              },
        cancel: async () => {
          throw new Error("unexpected cancellation");
        },
      };
      const definition = createLlmReplyModule({
        executor,
        modelTaskCompletedInformationKind,
      });
      const instance = await createInstance(definition, {
        instanceId: "reply-1",
        settings: {
          modelTier: "heavy",
          outbound: { mode: "source", messageKind: "reply" },
        },
      });
      const registrations: Registration[] = [];
      await instance.subscriptions[0]!.handle(
        replyAtom(),
        handlerContext(
          replyAtom(),
          registrations,
          replyAtom(),
          "reply-1",
          [replyAtom()],
          executor,
        ),
      );
      expect(registrations).toEqual([]);
      expect(instance.subscriptions.map((s) => s.kind)).toEqual([
        "core.reply.requested",
        "core.model.task.completed",
        "core.message.assistant.text",
      ]);
    },
  );

  it("derives assistant only from its completed task and preserves source outbound routing", async () => {
    const definition = defineReplyModule({
      modelTaskCapability,
      modelTaskCompletedInformationKind,
    });
    const instance = await createInstance(definition, {
      instanceId: "reply-1",
      settings: {
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      },
    });
    const completed = completedAtom();
    const assistantRegistrations: Registration[] = [];
    const assistantContext = handlerContext(
      completed,
      assistantRegistrations,
      assistantAtom(),
      "reply-1",
      [replyAtom()],
    );
    const registerAssistant = vi.spyOn(assistantContext, "registerOnce");
    await instance.subscriptions[1]!.handle(
      {
        ...completed,
        payload: {
          ...completed.payload,
          activation: {
            instanceId: "reply-2",
            definitionId: "demo.reply.llm",
          },
        },
      },
      assistantContext,
    );
    expect(assistantRegistrations).toEqual([
      {
        definition: assistantTextInformationKind,
        input: {
          payload: {
            text: "Hello.",
            source: inboundPayload.source,
            originatingModuleInstanceId: "reply-1",
          },
        },
      },
    ]);
    expect(registerAssistant).toHaveBeenCalledWith(
      "kaguya.reply.assistant.v1",
      "reply-1:completion-1",
      assistantTextInformationKind,
      expect.any(Object),
    );
    const deliveryRegistrations: Registration[] = [];
    const deliveryContext = handlerContext(
      assistantAtom(),
      deliveryRegistrations,
      assistantAtom(),
      "reply-1",
    );
    const registerDelivery = vi.spyOn(deliveryContext, "registerOnce");
    await instance.subscriptions[2]!.handle(assistantAtom(), deliveryContext);
    expect(deliveryRegistrations).toEqual([
      {
        definition: deliveryRequestedInformationKind,
        input: {
          payload: {
            adapterId: "adapter",
            platform: "qq",
            destination: { kind: "group", groupId: "group-1" },
            message: {
              kind: "reply",
              replyToPlatformMessageId: "request-1",
              text: "Hello.",
            },
          },
        },
      },
    ]);
    expect(registerDelivery).toHaveBeenCalledWith(
      "kaguya.reply.delivery.v1",
      "reply-1:assistant-1",
      deliveryRequestedInformationKind,
      expect.any(Object),
    );
    for (const payload of [
      { ...completed.payload, taskId: "other.task" },
      { ...completed.payload, version: "2" },
      {
        ...completed.payload,
        selectionPolicy: { tier: "light" },
      },
    ]) {
      const registrations: Registration[] = [];
      await instance.subscriptions[1]!.handle(
        { ...completed, payload },
        handlerContext(completed, registrations, assistantAtom(), "reply-1", [
          replyAtom(),
        ]),
      );
      expect(registrations).toEqual([]);
    }
  });

  it("does not derive assistant or delivery from another definition's completed task", async () => {
    const definition = defineReplyModule({
      modelTaskCapability,
      modelTaskCompletedInformationKind,
    });
    const instance = await createInstance(definition, {
      instanceId: "reply-1",
      settings: {
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      },
    });
    const completed = completedAtom();
    const registrations: Registration[] = [];

    const completionContext = handlerContext(
      completed,
      registrations,
      assistantAtom(),
      "reply-1",
      [replyAtom()],
    );
    const registerOnce = vi.spyOn(completionContext, "registerOnce");
    await instance.subscriptions[1]!.handle(
      {
        ...completed,
        payload: {
          ...completed.payload,
          activation: {
            instanceId: "other-reply-instance",
            definitionId: "other.reply.definition",
          },
        },
      },
      completionContext,
    );

    expect(registerOnce).not.toHaveBeenCalled();
    expect(registrations).toEqual([]);
  });

  it("strictly rejects profile and reply-target settings", () => {
    const base = {
      modelTier: "light",
      outbound: { mode: "source", messageKind: "text" },
    };
    expect(
      llmReplySettingsSchema.safeParse({
        ...base,
        profileId: "profile-1",
      }).success,
    ).toBe(false);
    expect(
      llmReplySettingsSchema.safeParse({
        ...base,
        replyTargetInstanceId: "reply-1",
      }).success,
    ).toBe(false);
  });
});
