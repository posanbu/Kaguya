/**
 * 功能概述：本文件验证信息模块以显式 kind 串接入站、回复、LLM 完成、assistant 和投递阶段，
 * 不再以旧事件、target instance 或成功 decision 驱动下一步。
 * 主要职责：过滤器用例验证通过时只注册回复请求、拒绝 fixture 只注册拒绝事实；回复用例
 * 验证三个订阅分别承担回复执行、LLM 完成到 assistant、assistant 到投递的直接因果阶段。
 * 代码库关系：覆盖 `always-reply-information-filter.ts`、`llm-information-reply.ts` 和
 * `information-kinds.ts`；`InformationModuleHost` 为每一次 register 自动补齐直接的
 * `core:caused-by` 与继承的 `core:context`，因此模块 handler 不伪造这些保留引用。
 * 输入输出与副作用：测试使用冻结 atom 和内存 register 记录，不访问 Core、账本或真实 LLM；
 * schema 断言保护删除的 profile 与 reply target 设置不会重新进入模块契约。
 */
import {
  type DeepReadonly,
  freezeInformationAtom,
  informationIdSchema,
  type InformationAtom,
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
