/**
 * 功能概述：本文件定义信息原子版 LLM 回复模块，把回复请求、LLM 生命周期完成、assistant
 * 文本和投递请求拆成三个由 kind 连接的消费者阶段，保证每一条边都有直接因果引用。
 * 主要职责：`llmInformationReplySettingsSchema` 仅允许模型 tier 与出站方式；
 * `llmCompletedInformationPayloadSchema` 是 Runtime 注入的 completed kind 与本模块共享的
 * 输出契约；`createLlmInformationReplyModule` 分别执行 LLM、产生 assistant、产生 delivery。
 * 代码库关系：依赖 `information-kinds.ts` 的模块拥有 kind；Runtime 注入同一份
 * `core.llm.completed` definition 和 executor，executor 负责注册 LLM requested/completed
 * 生命周期 atom，InformationModuleHost 则为 assistant 与 delivery 自动补齐直接因果和 context。
 * 输入输出与副作用：reply handler 只调用注入 executor；completed handler 从其严格 payload
 * 注册 assistant；assistant handler 按 source/fixed 设置注册投递或跳过 web source。执行器抛错
 * 会交由 Core 记录 consumer.failed，模块不吞掉错误、不保存跨请求状态。
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
  onInformation,
  type InformationKindDefinition,
} from "@kaguya/sdk";

import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";

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
      z.object({ kind: z.literal("private"), userId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("group"), groupId: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

export const llmInformationReplySettingsSchema = z
  .object({
    modelTier: modelTierSchema,
    outbound: z.discriminatedUnion("mode", [sourceOutboundSchema, fixedOutboundSchema]),
  })
  .strict();
export type LlmInformationReplySettings = z.infer<
  typeof llmInformationReplySettingsSchema
>;

export const llmCompletedInformationPayloadSchema = z
  .object({
    output: z.object({ text: z.string().min(1) }).strict(),
    reply: replyRequestedInformationPayloadSchema,
  })
  .strict();
export type LlmCompletedInformationPayload = z.infer<
  typeof llmCompletedInformationPayloadSchema
>;

export interface LlmInformationReplyExecutor {
  execute(input: {
    readonly reply: DeepReadonly<
      InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
    >;
    readonly selection: ModuleModelSelection;
  }): Promise<
    DeepReadonly<
      InformationAtom<"core.llm.completed", LlmCompletedInformationPayload>
    >
  >;
}

export interface CreateLlmInformationReplyModuleOptions {
  readonly executor: LlmInformationReplyExecutor;
  readonly llmCompletedInformationKind: InformationKindDefinition<
    "core.llm.completed",
    LlmCompletedInformationPayload
  >;
}

export function createLlmInformationReplyModule(
  dependencies: CreateLlmInformationReplyModuleOptions,
) {
  return defineInformationModule({
    manifest: {
      apiVersion: 1,
      definitionId: "demo.reply.llm-information",
      displayName: "LLM information reply",
      settingsSchema: llmInformationReplySettingsSchema,
      informationKinds: [
        replyRequestedInformationKind,
        dependencies.llmCompletedInformationKind,
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
    },
    create: ({ settings }) => ({
      subscriptions: [
        onInformation(replyRequestedInformationKind, async (reply) => {
          await dependencies.executor.execute({
            reply,
            selection: { modelTier: settings.modelTier },
          });
        }),
        onInformation(dependencies.llmCompletedInformationKind, async (completed, context) => {
          await context.register(assistantTextInformationKind, {
            payload: {
              text: completed.payload.output.text,
              source: completed.payload.reply.source,
            },
          });
        }),
        onInformation(assistantTextInformationKind, async (assistant, context) => {
          const outbound = selectOutbound(
            assistant.payload.source,
            settings.outbound,
            assistant.payload.text,
          );
          if (outbound === undefined) return;
          await context.register(deliveryRequestedInformationKind, {
            payload: outbound,
          });
        }),
      ],
    }),
  });
}

function selectOutbound(
  source: ReplyRequestedInformationPayload["source"],
  setting: LlmInformationReplySettings["outbound"],
  text: string,
): {
  readonly adapterId: string;
  readonly platform: string;
  readonly destination: PlatformDestination;
  readonly message: OutboundMessageContent;
} | undefined {
  if (setting.mode === "fixed") {
    return {
      adapterId: setting.adapterId,
      platform: setting.platform,
      destination: setting.destination,
      message: { kind: "text", text },
    };
  }
  if (source.destination.kind === "web") return undefined;
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
