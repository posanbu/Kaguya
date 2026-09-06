/**
 * 功能概述：通过宿主批准的 Model Task 能力将回复请求、通用完成事实、assistant 与投递组成 durable DAG。
 * 主要职责：createLlmReplyModule 声明能力和共享 completed definition；请求 handler 经 context.use
 * 调用 core.reply.generate v1，replyTaskOutputSchema 严格校验文本。完成 handler 仅处理本 activation
 * 的任务赢家，经 completedReplySelector 重载来源 reply，再用 registerOnce 派生 assistant 和 delivery。
 * 代码库关系：Runtime 注入 token 和 definition 身份，Host 提供 activation、受限 Selector 与 claim fencing；
 * reply-context 保留原有 Prompt/Memory 顺序与 provenance，selectOutbound 保留 source/fixed 路由。
 * 类型通过 Runtime 构建声明引用，运行时不导入 Runtime、provider、模型、密钥或 Core。
 * 输入输出与副作用：requested/terminal 生命周期完全归 ModelTaskClient；failed/cancelled 不触发业务写入，
 * completed 与 assistant 广播按 originating activation 过滤，重投使用唯一操作槽，不保存请求内存状态。
 */
import {
  type DeepReadonly,
  type InformationAtom,
  type OutboundMessageContent,
  type PlatformDestination,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  type ModuleCapability,
  onInformation,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";
import type { ModelTaskCapability } from "../../runtime/dist/model-task.js";
import type { modelTaskCompletedInformationKind } from "../../runtime/dist/information-kinds.js";

import {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  deliveryRequestedInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
import {
  compileReplyPromptFromInformation,
  currentAcceptedMessageSelector,
  replyPromptRenderer,
  memoryPromptRenderer,
} from "./reply-context.js";

export const modelTierSchema = z.enum(["light", "heavy"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModuleModelSelection {
  readonly modelTier: ModelTier;
}

const sourceOutboundSchema = z
  .object({
    mode: z.literal("source"),
    messageKind: z.enum(["text", "reply"]),
  })
  .strict();

const fixedOutboundSchema = z
  .object({
    mode: z.literal("fixed"),
    adapterId: z.string().trim().min(1),
    platform: z.string().trim().min(1),
    destination: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("private"), userId: z.string().min(1) })
        .strict(),
      z
        .object({ kind: z.literal("group"), groupId: z.string().min(1) })
        .strict(),
    ]),
  })
  .strict();

export const llmReplySettingsSchema = z
  .object({
    modelTier: modelTierSchema,
    outbound: z.discriminatedUnion("mode", [
      sourceOutboundSchema,
      fixedOutboundSchema,
    ]),
  })
  .strict();
export type LlmReplySettings = z.infer<typeof llmReplySettingsSchema>;

export const llmCompletedInformationPayloadSchema = z
  .object({
    output: z.object({ text: z.string().min(1) }).strict(),
    reply: replyRequestedInformationPayloadSchema,
    originatingModuleInstanceId: z.string().trim().min(1),
  })
  .strict();
export type LlmCompletedInformationPayload = z.infer<
  typeof llmCompletedInformationPayloadSchema
>;

export const replyTaskOutputSchema = z
  .object({ text: z.string().min(1) })
  .strict();

export interface CreateLlmReplyModuleOptions {
  readonly modelTaskCapability: ModuleCapability<ModelTaskCapability>;
  readonly modelTaskCompletedInformationKind: typeof modelTaskCompletedInformationKind;
  readonly selector?: InformationSelectorDefinition;
  readonly promptCompiler?: PromptCompiler;
}

export function createLlmReplyModule(
  dependencies: CreateLlmReplyModuleOptions,
) {
  const { modelTaskCapability } = dependencies;
  if (
    modelTaskCapability.id !== "kaguya:model-task" ||
    modelTaskCapability.apiVersion !== 1
  )
    throw new Error("Invalid model task capability");
  const selector = dependencies.selector ?? currentAcceptedMessageSelector;
  const promptCompiler = dependencies.promptCompiler ?? new PromptCompiler();
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [selector, completedReplySelector],
      promptRenderers: [replyPromptRenderer, memoryPromptRenderer],
      requires: [modelTaskCapability],
      provides: [],
      definitionId: "demo.reply.llm",
      displayName: "LLM reply",
      settingsSchema: llmReplySettingsSchema,
      consumes: [
        replyRequestedInformationKind,
        dependencies.modelTaskCompletedInformationKind,
        assistantTextInformationKind,
        coreMemoryTextInformationKind,
      ],
      produces: [
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
    },
    create: ({ settings, activation }) => ({
      provisions: [],
      subscriptions: [
        onInformation(
          replyRequestedInformationKind,
          { subscriptionId: "kaguya.reply.requested", delivery: "durable" },
          async (reply, context) => {
            const contextAtoms = await context.select(selector);
            const persistedReply = requireSelectedReply(
              contextAtoms,
              reply.informationId,
            );
            const prompt = compileReplyPromptFromInformation(
              promptCompiler,
              contextAtoms,
              reply.informationId,
            );
            const contexts = persistedReply.references.filter(
              (r) => r.relation === "core:context",
            );
            if (contexts.length !== 1)
              throw new Error("Reply must have one context");
            await context.use(modelTaskCapability).execute({
              task: {
                taskId: "core.reply.generate",
                version: "1",
                outputSchema: replyTaskOutputSchema,
                allowedTiers: ["light", "heavy"],
              },
              sourceInformationId: persistedReply.informationId,
              contextInformationId: contexts[0]!.informationId,
              activation,
              selectionPolicy: { tier: settings.modelTier },
              prompt,
              contextAtoms,
            });
          },
        ),
        onInformation(
          dependencies.modelTaskCompletedInformationKind,
          {
            subscriptionId: "kaguya.reply.model-task-completed",
            delivery: "durable",
          },
          async (completed, context) => {
            if (
              completed.payload.taskId !== "core.reply.generate" ||
              completed.payload.version !== "1" ||
              completed.payload.activation.instanceId !==
                activation.instanceId ||
              completed.payload.activation.definitionId !==
                activation.definitionId
            )
              return;
            const output = replyTaskOutputSchema.parse(
              completed.payload.output,
            );
            const reply = requireSelectedReply(
              await context.select(completedReplySelector),
              completed.payload.sourceInformationId,
            );
            await context.registerOnce(
              "kaguya.reply.assistant.v1",
              completed.informationId,
              assistantTextInformationKind,
              {
                payload: {
                  text: output.text,
                  source: reply.payload.source,
                  originatingModuleInstanceId: context.instanceId,
                },
              },
            );
          },
        ),
        onInformation(
          assistantTextInformationKind,
          { subscriptionId: "kaguya.reply.assistant", delivery: "durable" },
          async (assistant, context) => {
            if (
              assistant.payload.originatingModuleInstanceId !==
              context.instanceId
            )
              return;
            const outbound = selectOutbound(
              assistant.payload.source,
              settings.outbound,
              assistant.payload.text,
            );
            if (outbound === undefined) return;
            await context.registerOnce(
              "kaguya.reply.delivery.v1",
              assistant.informationId,
              deliveryRequestedInformationKind,
              {
                payload: outbound,
              },
            );
          },
        ),
      ],
    }),
  });
}

const completedReplySelector = defineInformationSelector({
  selectorId: "kaguya.reply.completed-source",
  select: ({ sourceAtom }) => {
    const payload = z
      .object({ sourceInformationId: z.string().min(1) })
      .parse(sourceAtom.payload);
    return [payload.sourceInformationId];
  },
});

function requireSelectedReply(
  atoms: readonly DeepReadonly<InformationAtom>[],
  informationId: string,
): DeepReadonly<
  InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
> {
  const reply = atoms.find((atom) => atom.informationId === informationId);
  if (reply === undefined) {
    throw new Error("Reply selection must include the current input");
  }
  if (reply.kind !== replyRequestedInformationKind.kind) {
    throw new Error(
      `Selected reply has unexpected information kind: ${reply.kind}`,
    );
  }
  replyRequestedInformationPayloadSchema.parse(reply.payload);
  return reply as DeepReadonly<
    InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
  >;
}

function selectOutbound(
  source: ReplyRequestedInformationPayload["source"],
  setting: LlmReplySettings["outbound"],
  text: string,
):
  | {
      readonly adapterId: string;
      readonly platform: string;
      readonly destination: PlatformDestination;
      readonly message: OutboundMessageContent;
    }
  | undefined {
  if (setting.mode === "fixed") {
    return {
      adapterId: setting.adapterId,
      platform: setting.platform,
      destination: setting.destination,
      message: { kind: "text", text },
    };
  }
  if (source.destination.kind === "web") {
    return {
      adapterId: source.adapterId,
      platform: source.platform,
      destination: source.destination,
      message: { kind: "text", text },
    };
  }
  return {
    adapterId: source.adapterId,
    platform: source.platform,
    destination: source.destination,
    message:
      setting.messageKind === "reply"
        ? {
            kind: "reply",
            replyToPlatformMessageId: source.platformMessageId,
            text,
          }
        : { kind: "text", text },
  };
}
