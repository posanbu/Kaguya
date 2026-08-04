import {
  replyOutputSchema,
  routeOutputSchema,
  stateOutputSchema,
  type ReplyOutput,
  type RouteOutput,
  type StateOutput,
} from "@kaguya/llm/schemas";
import {
  type CompiledPrompt,
  type EventEnvelope,
  type MemoryRecord,
  type MessageRecord,
  type PromptFragment,
  eventEnvelopeSchema,
} from "@kaguya/schema";
import {
  defineNode,
  type EventDefinition,
  type WorkflowContext,
  type WorkflowNode,
} from "@kaguya/sdk";

import { emitDefinedEvent } from "../dispatch.js";
import {
  messagePersistedEvent,
  promptCompiledEvent,
  replyGeneratedEvent,
} from "../events.js";
import {
  getDatabase,
  getEventBus,
  getLlmClient,
  getPromptCompiler,
} from "../services.js";

export const MODEL_ID = "deterministic-model";
const RECENT_MESSAGE_LIMIT = 20;
const RECENT_MEMORY_LIMIT = 20;

export const routeDecisionSchema = routeOutputSchema;
export const replyResultSchema = replyOutputSchema;
export const stateResultSchema = stateOutputSchema;

export interface ConversationContext {
  messages: MessageRecord[];
  memories: MemoryRecord[];
}

export const loadContextNode: WorkflowNode<unknown, ConversationContext> =
  defineNode({
    id: "load-context",
    async run(_input, context) {
      return loadConversation(context);
    },
  });

export const compileReplyNode: WorkflowNode<RouteOutput, CompiledPrompt> =
  defineNode({
    id: "compile-reply",
    async run(decision, context) {
      routeDecisionSchema.parse(decision);
      return compileAndPublish(
        "reply",
        replyFragments(loadConversation(context)),
        "compile-reply",
        context,
      );
    },
  });

export const persistReplyNode: WorkflowNode<ReplyOutput, MessageRecord> =
  defineNode({
    id: "persist-reply",
    async run(output, context) {
      const reply = replyResultSchema.parse(output);
      const record: MessageRecord = {
        id: context.nextId("message"),
        sessionId: requiredSessionId(context),
        role: "assistant",
        content: reply.text,
        occurredAt: context.now().toISOString(),
        metadata: {
          generatedBy: "generate-reply",
          traceId: context.traceId,
        },
      };
      getDatabase(context).messages.insert(record);
      await emitNodeEvent(context, messagePersistedEvent, "persist-reply", {
        messageId: record.id,
        role: record.role,
      });
      return record;
    },
  });

export function createGenerateReplyNode(
  workflowId: "message-workflow" | "heartbeat-workflow",
): WorkflowNode<CompiledPrompt, ReplyOutput> {
  return defineNode({
    id: "generate-reply",
    async run(prompt, context) {
      const reply = replyResultSchema.parse(
        await getLlmClient(context).generate(
          {
            kind: "reply",
            modelId: MODEL_ID,
            prompt,
            traceId: context.traceId,
            workflowId,
            nodeId: "generate-reply",
          },
          context,
        ),
      );
      await emitNodeEvent(
        context,
        replyGeneratedEvent,
        "generate-reply",
        reply,
      );
      return reply;
    },
  });
}

export function loadConversation(
  context: WorkflowContext,
): ConversationContext {
  const database = getDatabase(context);
  const sessionId = requiredSessionId(context);
  return {
    messages: database.messages
      .listRecent(sessionId, RECENT_MESSAGE_LIMIT)
      .reverse(),
    memories: database.memories
      .listRecent(sessionId, RECENT_MEMORY_LIMIT)
      .reverse(),
  };
}

export function routeFragments(
  conversation: ConversationContext,
  state?: StateOutput,
): PromptFragment[] {
  return [
    promptFragment("route-persona", "persona", 10, "You are Kaguya."),
    historyFragment("route-history", conversation.messages),
    memoriesFragment("route-memory", conversation.memories),
    ...(state === undefined
      ? []
      : [promptFragment("route-state", "state", 35, JSON.stringify(state))]),
    promptFragment(
      "route-policy",
      "policy",
      40,
      "Decide whether a reply is useful and non-intrusive.",
      { scope: "route" },
    ),
  ];
}

function replyFragments(conversation: ConversationContext): PromptFragment[] {
  return [
    promptFragment("reply-persona", "persona", 10, "You are Kaguya."),
    historyFragment("reply-history", conversation.messages),
    memoriesFragment("reply-memory", conversation.memories),
    promptFragment(
      "reply-policy",
      "policy",
      40,
      "Write a concise, warm reply grounded in the conversation.",
      { scope: "reply" },
    ),
  ];
}

export function historyFragment(
  id: string,
  messages: readonly MessageRecord[],
  metadata: Record<string, unknown> = {},
): PromptFragment {
  return promptFragment(
    id,
    "history",
    20,
    messages.length === 0
      ? "(no messages)"
      : messages
          .map((record) => `${record.role}: ${record.content}`)
          .join("\n"),
    { ...metadata, messageIds: messages.map((record) => record.id) },
  );
}

export function memoriesFragment(
  id: string,
  memories: readonly MemoryRecord[],
): PromptFragment {
  return promptFragment(
    id,
    "memory",
    30,
    memories.length === 0
      ? "(no memories)"
      : memories.map((record) => record.content).join("\n"),
    { memoryIds: memories.map((record) => record.id) },
  );
}

export function promptFragment(
  id: string,
  source: PromptFragment["source"],
  priority: number,
  content: string,
  metadata: Record<string, unknown> = {},
): PromptFragment {
  return { id, source, priority, content, metadata };
}

export async function compileAndPublish(
  kind: CompiledPrompt["kind"],
  fragments: readonly PromptFragment[],
  nodeId: string,
  context: WorkflowContext,
): Promise<CompiledPrompt> {
  const prompt = getPromptCompiler(context).compile(kind, fragments);
  await emitNodeEvent(context, promptCompiledEvent, nodeId, {
    kind,
    provenance: prompt.provenance,
  });
  return prompt;
}

export async function emitNodeEvent<TType extends string, TPayload>(
  context: WorkflowContext,
  definition: EventDefinition<TType, TPayload>,
  nodeId: string,
  payload: TPayload,
): Promise<void> {
  const event = definition.create(
    {
      id: context.nextId("event"),
      source: `demo-workflow/${nodeId}`,
      occurredAt: context.now().toISOString(),
      traceId: context.traceId,
      sessionId: requiredSessionId(context),
      metadata: { nodeId },
    },
    payload,
  );
  await emitDefinedEvent({
    definition,
    event,
    eventBus: getEventBus(context),
  });
}

export function requiredSessionId(context: WorkflowContext): string {
  if (context.sessionId === undefined) {
    throw new Error("workflow requires a sessionId");
  }
  return context.sessionId;
}

export function assertOrigin<TType extends string, TPayload>(
  event: EventEnvelope,
  definition: EventDefinition<TType, TPayload>,
  context: WorkflowContext,
): asserts event is EventEnvelope<TType, TPayload> {
  eventEnvelopeSchema.parse(event);

  if (event.type !== definition.type) {
    throw new Error(`expected ${definition.type}, received ${event.type}`);
  }
  definition.payloadSchema.parse(event.payload);
  if (event.traceId !== context.traceId) {
    throw new Error("event traceId does not match workflow context");
  }
  if (
    definition.sessionScoped &&
    event.sessionId !== requiredSessionId(context)
  ) {
    throw new Error("event sessionId does not match workflow context");
  }
}
