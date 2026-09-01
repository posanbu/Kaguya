/**
 * 功能概述：本文件定义消息回复模块 `demo.reply.llm`，负责把一条已持久化的用户消息
 * 解析成 Prompt、调用运行时注入的 LLM 执行器，并把结果转成平台出站消息请求。
 * 主要职责：`modelTierSchema` 与 `ModuleModelSelection` 定义模块能向运行时声明的
 * 唯一模型选择维度；`llmReplySettingsSchema` 约束实例配置，只允许声明 tier、出站模式
 * 与 persona/instruction；`createLlmReplyModule` 负责读取消息、校验 metadata、构造 prompt、
 * 调用 LLM 并发布 `outboundMessageRequestedEvent`；`selectOutbound` 根据 source/fixed 规则
 * 选择回包目标；`compileReplyPrompt`/`fragment` 负责稳定生成 Prompt 片段。
 * 代码库关系：本文件被 `packages/modules/src/index.ts` 导出，并由 `packages/runtime`
 * 在启动时注册为默认回复模块，由 `apps/server` 提供的 Runtime resolver 根据
 * 当前 selected Profile 解析 tier；本次变更明确禁止模块实例、消息或单次调用传入
 * `profileId`，Profile 选择只属于服务启动阶段。
 * 输入输出与副作用：输入是回复请求事件和模块实例设置，输出是一次 LLM 调用与可选的
 * 出站消息事件；当消息记录缺失、metadata 非法或 LLM 输出不匹配 schema 时会直接抛错，
 * 不做 provider/profile fallback，也不缓存跨请求状态。
 */
import { replyOutputSchema, type ReplyOutput } from "@kaguya/llm/schemas";
import { PromptCompiler } from "@kaguya/prompt";
import {
  type CompiledPrompt,
  type MessageRecord,
  type PlatformDestination,
  type PromptFragment,
  z,
} from "@kaguya/schema";
import {
  defineModule,
  onTargetedEvent,
  type ExecutionContext,
} from "@kaguya/sdk";

import {
  moduleMessageSchema,
  outboundMessageRequestedEvent,
  replyRequestedEvent,
  type ModuleMessage,
} from "./events.js";

const DEFAULT_PERSONA = "You are Kaguya.";
const DEFAULT_INSTRUCTION =
  "Write one concise, natural message based only on the current input.";

export const modelTierSchema = z.enum(["light", "heavy"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModuleModelSelection {
  readonly modelTier: ModelTier;
}

export interface ReplyMessageReader {
  getById(
    id: string,
  ): Promise<MessageRecord | undefined> | MessageRecord | undefined;
}

export interface ReplyLlmExecutor {
  generate(
    request: {
      readonly kind: "reply";
      readonly selection: ModuleModelSelection;
      readonly prompt: CompiledPrompt;
      readonly traceId: string;
      readonly workflowId: string;
      readonly nodeId: string;
    },
    context: ExecutionContext,
  ): Promise<ReplyOutput>;
}

export interface CreateLlmReplyModuleOptions {
  readonly messageReader: ReplyMessageReader;
  readonly llm: ReplyLlmExecutor;
  readonly promptCompiler: PromptCompiler;
}

const sourceDestinationSchema = z
  .object({
    mode: z.literal("source"),
    messageKind: z.enum(["text", "reply"]),
  })
  .strict();

const fixedDestinationSchema = z
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
    messageKind: z.literal("text"),
  })
  .strict();

export const llmReplySettingsSchema = z
  .object({
    modelTier: modelTierSchema,
    outbound: z.discriminatedUnion("mode", [
      sourceDestinationSchema,
      fixedDestinationSchema,
    ]),
    persona: z.string().trim().min(1).default(DEFAULT_PERSONA),
    instruction: z.string().trim().min(1).default(DEFAULT_INSTRUCTION),
  })
  .strict();

export function createLlmReplyModule(
  dependencies: CreateLlmReplyModuleOptions,
) {
  return defineModule({
    manifest: {
      apiVersion: 1,
      definitionId: "demo.reply.llm",
      displayName: "LLM reply",
      settingsSchema: llmReplySettingsSchema,
    },
    create: ({ instanceId, settings }) => ({
      subscriptions: [
        onTargetedEvent(replyRequestedEvent, async (event, context) => {
          const record = await dependencies.messageReader.getById(
            event.payload.messageId,
          );
          if (record === undefined || record.role !== "user") {
            throw new Error(
              `Reply source message is unavailable: ${event.payload.messageId}`,
            );
          }
          const parsedMessage = moduleMessageSchema.safeParse(
            record.metadata.moduleMessage,
          );
          if (!parsedMessage.success) {
            throw new Error(
              `Reply source metadata is invalid: ${event.payload.messageId}`,
            );
          }

          const prompt = compileReplyPrompt(
            dependencies.promptCompiler,
            parsedMessage.data,
            settings.persona,
            settings.instruction,
          );
          const output = replyOutputSchema.parse(
            await dependencies.llm.generate(
              {
                kind: "reply",
                selection: { modelTier: settings.modelTier },
                prompt,
                traceId: context.traceId,
                workflowId: "message-module-pipeline",
                nodeId: instanceId,
              },
              context,
            ),
          );
          const outbound = selectOutbound(
            parsedMessage.data,
            settings.outbound,
          );
          if (outbound === undefined) {
            return;
          }
          await context.emit(outboundMessageRequestedEvent, {
            adapterId: outbound.adapterId,
            platform: outbound.platform,
            destination: outbound.destination,
            message:
              outbound.messageKind === "reply"
                ? {
                    kind: "reply",
                    replyToPlatformMessageId: outbound.platformMessageId,
                    text: output.text,
                  }
                : { kind: "text", text: output.text },
          });
        }),
      ],
    }),
  });
}

function selectOutbound(
  message: ModuleMessage,
  setting: z.infer<typeof llmReplySettingsSchema>["outbound"],
):
  | {
      adapterId: string;
      platform: string;
      destination: PlatformDestination;
      messageKind: "text" | "reply";
      platformMessageId: string;
    }
  | undefined {
  if (setting.mode === "fixed") {
    return {
      adapterId: setting.adapterId,
      platform: setting.platform,
      destination: setting.destination,
      messageKind: "text",
      platformMessageId: "unused",
    };
  }
  if (message.source.kind !== "platform") {
    return undefined;
  }
  return {
    adapterId: message.source.adapterId,
    platform: message.source.platform,
    destination: message.source.destination,
    messageKind: setting.messageKind,
    platformMessageId: message.source.platformMessageId,
  };
}

function compileReplyPrompt(
  compiler: PromptCompiler,
  message: ModuleMessage,
  persona: string,
  instruction: string,
): CompiledPrompt {
  const fragments: PromptFragment[] = [
    fragment("reply-persona", "persona", 10, persona),
    fragment("reply-current-message", "history", 20, message.text, {
      messageId: message.messageId,
    }),
    fragment(
      "reply-current-message-context",
      "state",
      30,
      JSON.stringify(message.source),
      { messageId: message.messageId },
    ),
    fragment("reply-policy", "policy", 40, instruction, { scope: "reply" }),
  ];
  return compiler.compile("reply", fragments);
}

function fragment(
  id: string,
  source: PromptFragment["source"],
  priority: number,
  content: string,
  metadata: Record<string, unknown> = {},
): PromptFragment {
  return { id, source, priority, content, metadata };
}
