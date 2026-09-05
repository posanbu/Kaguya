/**
 * 功能概述：本文件定义信息原子版 LLM 回复模块，把回复请求、LLM 生命周期完成、assistant
 * 文本和投递请求拆成三个由 kind 连接的消费者阶段，保证每一条边都有直接因果引用。
 * 主要职责：`llmReplySettingsSchema` 仅允许模型 tier 与出站方式；reply handler 通过
 * `context.select` 取得 Core 重载原子并编译可追溯 Prompt；
 * `llmCompletedInformationPayloadSchema` 是 Runtime 注入的 completed kind 与本模块共享的
 * 输出契约；`createLlmReplyModule` 分别执行 LLM、产生 assistant、产生 delivery。
 * 代码库关系：依赖 `information-kinds.ts` 的模块拥有 kind；Runtime 注入同一份
 * `core.llm.completed` definition 和 executor，executor 负责注册 LLM requested/completed
 * 生命周期 atom，engine `ModuleHost` 则为 assistant 与 delivery 自动补齐直接因果和 context；
 * completed/assistant 的 originating instance 字段在全量广播下提供阶段归属，不改变 Core 路由。
 * 输入输出与副作用：reply handler 只读选择账本并调用注入 executor；completed handler 从
 * 严格 payload 注册 assistant；assistant handler 仅为本实例拥有的 atom 按 source/fixed
 * 设置注册投递。执行器抛错会交由 Core 记录 consumer.failed，模块不保存跨请求状态。
 */
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
  onInformation,
  type InformationKindDefinition,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";

import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
import {
  compileReplyPromptFromInformation,
  currentAcceptedMessageSelector,
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

export interface CreateLlmReplyModuleOptions {
  readonly executor: LlmReplyExecutor;
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
      apiVersion: 1,
      definitionId: "demo.reply.llm",
      displayName: "LLM reply",
      settingsSchema: llmReplySettingsSchema,
      informationKinds: [
        replyRequestedInformationKind,
        dependencies.llmCompletedInformationKind,
        assistantTextInformationKind,
        deliveryRequestedInformationKind,
      ],
    },
    create: ({ settings }) => ({
      subscriptions: [
        onInformation(replyRequestedInformationKind, async (reply, context) => {
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
          await dependencies.executor.execute({
            reply: persistedReply,
            prompt,
            contextAtoms,
            selection: { modelTier: settings.modelTier },
            originatingModuleInstanceId: context.instanceId,
          });
        }),
        onInformation(
          dependencies.llmCompletedInformationKind,
          async (completed, context) => {
            if (
              completed.payload.originatingModuleInstanceId !==
              context.instanceId
            )
              return;
            await context.register(assistantTextInformationKind, {
              payload: {
                text: completed.payload.output.text,
                source: completed.payload.reply.source,
                originatingModuleInstanceId: context.instanceId,
              },
            });
          },
        ),
        onInformation(
          assistantTextInformationKind,
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
            await context.register(deliveryRequestedInformationKind, {
              payload: outbound,
            });
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
