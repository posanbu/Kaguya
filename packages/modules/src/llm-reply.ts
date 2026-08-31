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
  type ModuleHandlerContext,
} from "@kaguya/sdk";

import {
  messagePersistedEvent,
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
  readonly profileId?: string;
  readonly modelTier: ModelTier;
}

export interface ReplyMessageReader {
  getById(
    id: string,
  ): Promise<MessageRecord | undefined> | MessageRecord | undefined;
}

export interface ReplyMessageWriter {
  insert(record: MessageRecord): void | Promise<void>;
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
  readonly messageWriter?: ReplyMessageWriter;
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
    profileId: z.string().trim().min(1).optional(),
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
                selection: {
                  ...(settings.profileId === undefined
                    ? {}
                    : { profileId: settings.profileId }),
                  modelTier: settings.modelTier,
                },
                prompt,
                traceId: context.traceId,
                workflowId: "message-module-pipeline",
                nodeId: instanceId,
              },
              context,
            ),
          );
          await persistWebReply(
            dependencies.messageWriter,
            parsedMessage.data,
            output.text,
            context,
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

async function persistWebReply(
  writer: ReplyMessageWriter | undefined,
  message: ModuleMessage,
  text: string,
  context: ModuleHandlerContext,
): Promise<void> {
  if (writer === undefined || message.source.kind !== "web") {
    return;
  }
  const record: MessageRecord = {
    id: context.nextId("message"),
    role: "assistant",
    content: text,
    occurredAt: context.now().toISOString(),
    metadata: {
      traceId: context.traceId,
      requestId: message.source.requestId,
      sourceMessageId: message.messageId,
      ...(message.source.sessionId === undefined
        ? {}
        : { sessionId: message.source.sessionId }),
    },
  };
  await writer.insert(record);
  await context.emit(messagePersistedEvent, {
    messageId: record.id,
    role: "assistant",
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
