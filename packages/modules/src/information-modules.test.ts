/**
 * 功能概述：本文件验证信息模块以显式 kind 串接入站、回复、LLM 完成、assistant 和投递阶段，
 * 不再以旧事件、target instance 或成功 decision 驱动下一步。
 * 主要职责：过滤器用例验证通过时只注册回复请求、拒绝 fixture 只注册拒绝事实；回复用例
 * 验证三个订阅分别承担回复执行、LLM 完成到 assistant、assistant 到投递的直接因果阶段。
 * 代码库关系：覆盖 `always-reply-information-filter.ts`、`llm-information-reply.ts` 和
 * `information-kinds.ts`；`InformationModuleHost` 为每一次 register 自动补齐直接的
 * `core:caused-by` 与继承的 `core:context`，因此模块 handler 不伪造这些保留引用。
 * 输入输出与副作用：单元用例使用冻结 atom 与内存 register；集成用例使用真实 Core、宿主和
 * 校验引用规则的内存账本，断言实际 ID、持久化顺序及 context 继承，不访问真实 LLM；schema
 * 断言保护删除的 profile 与 reply target 设置不会重新进入模块契约。
 */
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
  onInformation,
  type InformationKindDefinition,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  InformationCore,
  InformationKindRegistry,
  InformationModuleHost,
  type InformationLedger,
  type InformationReferenceExpectation,
} from "@kaguya/engine";

import {
  alwaysReplyInformationFilterModule,
  alwaysReplyInformationFilterSettingsSchema,
} from "./always-reply-information-filter.js";
import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  filterDecisionInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
} from "./information-kinds.js";
import {
  createLlmInformationReplyModule,
  llmCompletedInformationPayloadSchema,
  llmInformationReplySettingsSchema,
} from "./llm-information-reply.js";

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

const llmCompletedInformationKind = defineInformationKind({
  kind: "core.llm.completed",
  payloadSchema: llmCompletedInformationPayloadSchema,
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [replyRequestedInformationKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});

const runtimeContextInformationKind = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({ requestId: z.string().min(1) }).strict(),
  references: {},
  log: { enabled: false },
});

class MemoryInformationLedger implements InformationLedger {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();

  async synchronizeKinds(): Promise<void> {}

  async append(
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
  ): Promise<void> {
    if (this.atoms.has(atom.informationId)) throw new Error("duplicate information id");
    const byRelation = new Map(expectations.map((expectation) => [expectation.relation, expectation]));
    const counts = new Map<string, number>();
    for (const reference of atom.references) {
      const expectation = byRelation.get(reference.relation);
      if (expectation === undefined) throw new Error(`undeclared reference: ${reference.relation}`);
      counts.set(reference.relation, (counts.get(reference.relation) ?? 0) + 1);
      if (!expectation.multiple && counts.get(reference.relation)! > 1) {
        throw new Error(`multiple references: ${reference.relation}`);
      }
      const target = this.atoms.get(reference.informationId);
      if (target === undefined) throw new Error(`missing reference: ${reference.informationId}`);
      if (expectation.targetKinds !== undefined && !expectation.targetKinds.includes(target.kind)) {
        throw new Error(`wrong reference kind: ${reference.relation}`);
      }
    }
    for (const expectation of expectations) {
      if (expectation.required && !counts.has(expectation.relation)) {
        throw new Error(`missing required reference: ${expectation.relation}`);
      }
    }
    this.atoms.set(atom.informationId, freezeInformationAtom(atom as InformationAtom));
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

function completedAtom() {
  const reply = replyAtom();
  return freezeInformationAtom({
    informationId: informationIdSchema.parse("completion-1"),
    kind: llmCompletedInformationKind.kind,
    occurredAt: "2026-09-04T00:00:01.000Z",
    source: "runtime:llm",
    payload: { output: { text: "Hello." }, reply: reply.payload },
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
    payload: { text: "Hello.", source: completed.payload.reply.source },
    references: [
      { relation: "core:caused-by", informationId: completed.informationId },
      { relation: "core:context", informationId: contextId },
    ],
  });
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
): InformationModuleHandlerContext {
  return {
    definitionId: "test.definition",
    instanceId: "test.instance",
    sourceAtom,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    register: async (definition, input) => {
      registrations.push({
        definition: definition as unknown as InformationKindDefinition<string, JsonObject>,
        input: input as Registration["input"],
      });
      return result as never;
    },
  };
}

describe("alwaysReplyInformationFilterModule", () => {
  it("registers the next kind when the filter passes", async () => {
    const instance = await alwaysReplyInformationFilterModule.create({
      instanceId: "filter-1",
      settings: alwaysReplyInformationFilterSettingsSchema.parse({}),
    });
    const atom = inboundAtom();
    const registrations: Registration[] = [];

    await instance.subscriptions[0]?.handle(
      atom,
      handlerContext(atom, registrations),
    );

    expect(alwaysReplyInformationFilterModule.manifest.informationKinds).toEqual([
      inboundTextInformationKind,
      replyRequestedInformationKind,
    ]);
    expect(registrations).toEqual([
      { definition: replyRequestedInformationKind, input: { payload: atom.payload } },
    ]);
  });

  it("records rejection without producing the next kind", async () => {
    const rejectingFilter = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "test.filter.rejecting",
        displayName: "Rejecting filter",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundTextInformationKind, filterDecisionInformationKind],
      },
      create: () => ({
        subscriptions: [
          onInformation(inboundTextInformationKind, async (_atom, context) => {
            await context.register(filterDecisionInformationKind, {
              payload: {
                accepted: false,
                reason: "blocked",
                filterDefinitionId: "test.filter.rejecting",
              },
            });
          }),
        ],
      }),
    });
    const atom = inboundAtom();
    const registrations: Registration[] = [];
    const instance = await rejectingFilter.create({ instanceId: "reject-1", settings: {} });

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
      alwaysReplyInformationFilterSettingsSchema.safeParse({
        replyTargetInstanceId: "reply-1",
      }).success,
    ).toBe(false);
    expect(
      alwaysReplyInformationFilterSettingsSchema.safeParse({
        profileId: "profile-1",
      }).success,
    ).toBe(false);
  });
});

describe("createLlmInformationReplyModule", () => {
  it("persists the full DAG with direct causes and one inherited context", async () => {
    const registry = new InformationKindRegistry();
    registry.registerBuiltin(runtimeContextInformationKind);
    registry.registerBuiltin(inboundTextInformationKind);
    registry.registerBuiltin(replyRequestedInformationKind);
    registry.registerBuiltin(llmCompletedInformationKind);
    registry.registerBuiltin(assistantTextInformationKind);
    registry.registerBuiltin(deliveryRequestedInformationKind);
    const ledger = new MemoryInformationLedger();
    let sequence = 0;
    const core = new InformationCore({
      registry,
      store: ledger,
      nextInformationId: () => `information-${++sequence}`,
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    });
    const replyModule = createLlmInformationReplyModule({
      llmCompletedInformationKind,
      executor: {
        async execute({ reply }) {
          const context = reply.references.find(
            ({ relation }) => relation === "core:context",
          );
          if (context === undefined) throw new Error("reply context is required");
          return core.register(llmCompletedInformationKind, {
            occurredAt: "2026-09-04T00:00:01.000Z",
            source: "runtime:llm",
            payload: { output: { text: "Hello." }, reply: reply.payload },
            references: [
              { relation: "core:caused-by", informationId: reply.informationId },
              context,
            ],
          });
        },
      },
    });
    const host = new InformationModuleHost({ core });
    host.register(alwaysReplyInformationFilterModule);
    host.register(replyModule);
    await core.start();
    await host.start([
      {
        instanceId: "filter-1",
        definitionId: alwaysReplyInformationFilterModule.manifest.definitionId,
        settings: {},
      },
      {
        instanceId: "reply-1",
        definitionId: replyModule.manifest.definitionId,
        settings: { modelTier: "heavy", outbound: { mode: "source", messageKind: "reply" } },
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
        references: [{ relation: "core:context", informationId: context.informationId }],
      });
      const atoms = [...ledger.atoms.values()];
      const reply = atoms.find(({ kind }) => kind === replyRequestedInformationKind.kind);
      const completed = atoms.find(({ kind }) => kind === llmCompletedInformationKind.kind);
      const assistant = atoms.find(({ kind }) => kind === assistantTextInformationKind.kind);
      const delivery = atoms.find(({ kind }) => kind === deliveryRequestedInformationKind.kind);

      expect(atoms.map(({ kind }) => kind)).toEqual([
        runtimeContextInformationKind.kind,
        inboundTextInformationKind.kind,
        replyRequestedInformationKind.kind,
        llmCompletedInformationKind.kind,
        assistantTextInformationKind.kind,
        deliveryRequestedInformationKind.kind,
      ]);
      expect(reply?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: inbound.informationId,
      });
      expect(completed?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: reply?.informationId,
      });
      expect(assistant?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: completed?.informationId,
      });
      expect(delivery?.references).toContainEqual({
        relation: "core:caused-by",
        informationId: assistant?.informationId,
      });
      for (const atom of [inbound, reply, completed, assistant, delivery]) {
        expect(atom?.references).toContainEqual({
          relation: "core:context",
          informationId: context.informationId,
        });
      }
    } finally {
      await host.stop();
    }
  });

  it("declares each direct causal edge and the shared context requirement", () => {
    expect(replyRequestedInformationKind.references).toMatchObject({
      "core:caused-by": { targetKinds: [inboundTextInformationKind.kind] },
      "core:context": { targetKinds: ["core.runtime.context"] },
    });
    expect(assistantTextInformationKind.references).toMatchObject({
      "core:caused-by": { targetKinds: [llmCompletedInformationKind.kind] },
      "core:context": { targetKinds: ["core.runtime.context"] },
    });
    expect(deliveryRequestedInformationKind.references).toMatchObject({
      "core:caused-by": { targetKinds: [assistantTextInformationKind.kind] },
      "core:context": { targetKinds: ["core.runtime.context"] },
    });
  });

  it("moves reply, completion and assistant through direct derived stages", async () => {
    const execute = vi.fn(async () => completedAtom());
    const definition = createLlmInformationReplyModule({
      executor: { execute },
      llmCompletedInformationKind,
    });
    const settings = llmInformationReplySettingsSchema.parse({
      modelTier: "heavy",
      outbound: { mode: "source", messageKind: "reply" },
    });
    const instance = await definition.create({ instanceId: "reply-1", settings });
    const reply = replyAtom();
    const completion = completedAtom();
    const assistant = assistantAtom();
    const executionRegistrations: Registration[] = [];
    const assistantRegistrations: Registration[] = [];
    const deliveryRegistrations: Registration[] = [];

    expect(instance.subscriptions.map(({ kind }) => kind)).toEqual([
      replyRequestedInformationKind.kind,
      llmCompletedInformationKind.kind,
      assistantTextInformationKind.kind,
    ]);

    await instance.subscriptions[0]?.handle(
      reply,
      handlerContext(reply, executionRegistrations),
    );
    await instance.subscriptions[1]?.handle(
      completion,
      handlerContext(completion, assistantRegistrations, assistant),
    );
    await instance.subscriptions[2]?.handle(
      assistant,
      handlerContext(assistant, deliveryRegistrations),
    );

    expect(execute).toHaveBeenCalledWith({
      reply,
      selection: { modelTier: "heavy" },
    });
    expect(executionRegistrations).toEqual([]);
    expect(assistantRegistrations).toEqual([
      {
        definition: assistantTextInformationKind,
        input: {
          payload: { text: "Hello.", source: reply.payload.source },
        },
      },
    ]);
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
  });

  it("strictly rejects profile and reply-target settings", () => {
    const base = {
      modelTier: "light",
      outbound: { mode: "source", messageKind: "text" },
    };
    expect(
      llmInformationReplySettingsSchema.safeParse({
        ...base,
        profileId: "profile-1",
      }).success,
    ).toBe(false);
    expect(
      llmInformationReplySettingsSchema.safeParse({
        ...base,
        replyTargetInstanceId: "reply-1",
      }).success,
    ).toBe(false);
  });
});
