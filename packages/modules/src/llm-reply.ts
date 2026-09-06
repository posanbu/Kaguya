/**
 * 功能概述：把回复请求、LLM 完成、assistant 文本和投递请求组成 durable Information DAG。
 * 主要职责：createLlmReplyModule 声明输入/输出、Selector、Prompt renderer 和 llmReplyExecutorCapability；
 * handler 用声明的能力执行模型，并用 registerOnce 为 assistant 和 delivery 提交唯一输出。
 * 代码库关系：composition root 注入共享 completed kind 与受控 executor；Host 负责能力边界和 claim fencing，
 * reply-context 负责选择和可追溯 Prompt。模块不接触模型密钥、数据库或 Runtime 具体装配。
 * 输入输出与副作用：模型 tier 与出站设置经 schema 严格解析；操作键包含输入 ID 与设置 SHA-256，
 * 同语义实例共享结果，不同设置保持独立；handler 失败由可靠执行器有限重试，模块不保存请求状态。
 */
import { createHash } from "node:crypto";
import {
  type DeepReadonly,
  type CompiledPrompt,
  type InformationAtom,
  type OutboundMessageContent,
  type PlatformDestination,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineModuleCapability,
  onInformation,
  type InformationKindDefinition,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";

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

export interface LlmReplyExecutor {
  execute(input: {
    readonly operationKey: string;
    readonly reply: DeepReadonly<
      InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
    >;
    readonly prompt: CompiledPrompt;
    readonly contextAtoms: readonly DeepReadonly<InformationAtom>[];
    readonly selection: ModuleModelSelection;
    readonly originatingModuleInstanceId: string;
  }): Promise<
    DeepReadonly<
      InformationAtom<"core.llm.completed", LlmCompletedInformationPayload>
    >
  >;
}

export const llmReplyExecutorCapability =
  defineModuleCapability<LlmReplyExecutor>("kaguya:llm-reply-executor", 1);

export interface CreateLlmReplyModuleOptions {
  readonly llmCompletedInformationKind: InformationKindDefinition<
    "core.llm.completed",
    LlmCompletedInformationPayload
  >;
  readonly selector?: InformationSelectorDefinition;
  readonly promptCompiler?: PromptCompiler;
}

export function createLlmReplyModule(
  dependencies: CreateLlmReplyModuleOptions,
) {
  const selector = dependencies.selector ?? currentAcceptedMessageSelector;
  const promptCompiler = dependencies.promptCompiler ?? new PromptCompiler();
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      selectors: [selector],
      promptRenderers: [replyPromptRenderer, memoryPromptRenderer],
      requires: [llmReplyExecutorCapability],
      provides: [],
      definitionId: "demo.reply.llm",
      displayName: "LLM reply",
      settingsSchema: llmReplySettingsSchema,
      consumes: [
        replyRequestedInformationKind,
        dependencies.llmCompletedInformationKind,
        assistantTextInformationKind,
        coreMemoryTextInformationKind,
      ],
      produces: [
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
    },
    create: ({ settings }) => ({
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
            await context.use(llmReplyExecutorCapability).execute({
              operationKey: `reply-v1:${reply.informationId}:${createHash("sha256").update(JSON.stringify(settings)).digest("hex")}`,
              reply: persistedReply,
              prompt,
              contextAtoms,
              selection: { modelTier: settings.modelTier },
              originatingModuleInstanceId: context.instanceId,
            });
          },
        ),
        onInformation(
          dependencies.llmCompletedInformationKind,
          { subscriptionId: "kaguya.reply.completed", delivery: "durable" },
          async (completed, context) => {
            if (
              completed.payload.originatingModuleInstanceId !==
              context.instanceId
            )
              return;
            await context.registerOnce(
              "kaguya.reply.assistant.v1",
              completed.informationId,
              assistantTextInformationKind,
              {
                payload: {
                  text: completed.payload.output.text,
                  source: completed.payload.reply.source,
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
