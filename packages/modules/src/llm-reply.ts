import type { KaguyaLlmRequest } from "@kaguya/llm/client";
import { replyOutputSchema, type ReplyOutput } from "@kaguya/llm/schemas";
import { PromptCompiler } from "@kaguya/prompt";
import {
  type CompiledPrompt,
  type MemoryRecord,
  type MessageRecord,
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
  replyGeneratedEvent,
  replyRequestedEvent,
} from "./events.js";

const DEFAULT_PERSONA = "You are Kaguya.";
const DEFAULT_INSTRUCTION =
  "Write a concise, warm reply grounded in the conversation.";

export interface ReplyConversation {
  readonly messages: readonly MessageRecord[];
  readonly memories: readonly MemoryRecord[];
}

export interface ReplyConversationReader {
  load(sessionId: string): Promise<ReplyConversation> | ReplyConversation;
}

export interface ReplyLlmGenerator {
  generate(
    request: KaguyaLlmRequest & { readonly kind: "reply" },
    context: ExecutionContext,
  ): Promise<ReplyOutput>;
}

export interface CreateLlmReplyModuleOptions {
  readonly conversationReader: ReplyConversationReader;
  readonly llm: ReplyLlmGenerator;
  readonly promptCompiler: PromptCompiler;
}

export const llmReplySettingsSchema = z
  .object({
    modelId: z.string().trim().min(1),
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
          const sessionId = context.sessionId;
          if (sessionId === undefined) {
            throw new Error("LLM reply module requires a sessionId");
          }
          const conversation =
            await dependencies.conversationReader.load(sessionId);
          const sourceMessage = conversation.messages.find(
            (message) => message.id === event.payload.messageId,
          );
          if (
            sourceMessage === undefined ||
            sourceMessage.sessionId !== sessionId ||
            sourceMessage.role !== "user"
          ) {
            throw new Error(
              `Reply source message is unavailable: ${event.payload.messageId}`,
            );
          }

          const prompt = compileReplyPrompt(
            dependencies.promptCompiler,
            conversation,
            sourceMessage,
            settings,
          );
          const output = replyOutputSchema.parse(
            await dependencies.llm.generate(
              {
                kind: "reply",
                modelId: settings.modelId,
                prompt,
                traceId: context.traceId,
                workflowId: "message-module-pipeline",
                nodeId: instanceId,
              },
              context,
            ),
          );
          await context.emit(
            replyGeneratedEvent,
            { messageId: sourceMessage.id, text: output.text },
            { modelId: settings.modelId },
          );
        }),
      ],
    }),
  });
}

function compileReplyPrompt(
  compiler: PromptCompiler,
  conversation: ReplyConversation,
  sourceMessage: MessageRecord,
  settings: z.infer<typeof llmReplySettingsSchema>,
): CompiledPrompt {
  const messageContext = moduleMessageSchema.safeParse(
    sourceMessage.metadata.messageContext,
  );
  const fragments: PromptFragment[] = [
    fragment("reply-persona", "persona", 10, settings.persona),
    fragment(
      "reply-history",
      "history",
      20,
      conversation.messages.length === 0
        ? "(no messages)"
        : conversation.messages
            .map((message) => `${message.role}: ${message.content}`)
            .join("\n"),
      { messageIds: conversation.messages.map(({ id }) => id) },
    ),
    fragment(
      "reply-memory",
      "memory",
      30,
      conversation.memories.length === 0
        ? "(no memories)"
        : conversation.memories.map(({ content }) => content).join("\n"),
      { memoryIds: conversation.memories.map(({ id }) => id) },
    ),
    ...(messageContext.success
      ? [
          fragment(
            "reply-current-message-context",
            "state",
            35,
            JSON.stringify(messageContext.data),
            { messageId: sourceMessage.id },
          ),
        ]
      : []),
    fragment("reply-policy", "policy", 40, settings.instruction, {
      scope: "reply",
    }),
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
