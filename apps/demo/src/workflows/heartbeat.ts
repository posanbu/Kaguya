import type { RouteOutput, StateOutput } from "@kaguya/llm/schemas";
import {
  type CompiledPrompt,
  type MemoryRecord,
  type PromptFragment,
} from "@kaguya/schema";
import {
  defineNode,
  defineWorkflow,
  type WorkflowDefinition,
} from "@kaguya/sdk";

import {
  heartbeatTickEvent,
  memoryWriteRequestedEvent,
  memoryWrittenEvent,
  routeDecidedEvent,
  routeRequestedEvent,
} from "../events.js";
import { getDatabase, getLlmClient } from "../services.js";
import {
  MODEL_ID,
  assertOrigin,
  compileAndPublish,
  compileReplyNode,
  createGenerateReplyNode,
  emitNodeEvent,
  historyFragment,
  loadConversation,
  memoriesFragment,
  persistReplyNode,
  promptFragment,
  requiredSessionId,
  routeDecisionSchema,
  routeFragments,
  stateResultSchema,
  type ConversationContext,
} from "./shared.js";

export type HeartbeatEvent = ReturnType<typeof heartbeatTickEvent.create>;

const loadContextNode = defineNode<HeartbeatEvent, ConversationContext>({
  id: "load-context",
  async run(event, context) {
    assertOrigin(event, heartbeatTickEvent, context);
    heartbeatTickEvent.payloadSchema.parse(event.payload);
    return loadConversation(context);
  },
});

const compileStateNode = defineNode<ConversationContext, CompiledPrompt>({
  id: "compile-state",
  async run(conversation, context) {
    return compileAndPublish(
      "state",
      stateFragments(conversation),
      "compile-state",
      context,
    );
  },
});

const updateStateNode = defineNode<CompiledPrompt, StateOutput>({
  id: "update-state",
  async run(prompt, context) {
    const state = stateResultSchema.parse(
      await getLlmClient(context).generate(
        {
          kind: "state",
          modelId: MODEL_ID,
          prompt,
          traceId: context.traceId,
          workflowId: "heartbeat-workflow",
          nodeId: "update-state",
        },
        context,
      ),
    );
    const database = getDatabase(context);
    const sessionId = requiredSessionId(context);
    const stateRecord: MemoryRecord = {
      id: context.nextId("memory"),
      sessionId,
      content: `Mood: ${state.mood}\nRelationship: ${state.relationship}`,
      occurredAt: context.now().toISOString(),
      metadata: {
        kind: "state",
        mood: state.mood,
        relationship: state.relationship,
        traceId: context.traceId,
      },
    };
    await emitNodeEvent(context, memoryWriteRequestedEvent, "update-state", {
      memoryId: stateRecord.id,
      kind: "state",
      content: stateRecord.content,
    });
    database.memories.insert(stateRecord);
    await emitNodeEvent(context, memoryWrittenEvent, "update-state", {
      memoryId: stateRecord.id,
      kind: "state",
    });

    for (const content of state.shortTermMemories) {
      const record: MemoryRecord = {
        id: context.nextId("memory"),
        sessionId,
        content,
        occurredAt: context.now().toISOString(),
        metadata: {
          kind: "short-term",
          mood: state.mood,
          relationship: state.relationship,
          traceId: context.traceId,
        },
      };
      await emitNodeEvent(context, memoryWriteRequestedEvent, "update-state", {
        memoryId: record.id,
        kind: "short-term",
        content: record.content,
      });
      database.memories.insert(record);
      await emitNodeEvent(context, memoryWrittenEvent, "update-state", {
        memoryId: record.id,
        kind: "short-term",
      });
    }
    return state;
  },
});

const compileRouteNode = defineNode<StateOutput, CompiledPrompt>({
  id: "compile-route",
  async run(output, context) {
    const state = stateResultSchema.parse(output);
    return compileAndPublish(
      "route",
      routeFragments(loadConversation(context), state),
      "compile-route",
      context,
    );
  },
});

const decideRouteNode = defineNode<CompiledPrompt, RouteOutput>({
  id: "decide-route",
  async run(prompt, context) {
    await emitNodeEvent(context, routeRequestedEvent, "decide-route", {
      workflowId: "heartbeat-workflow",
      nodeId: "decide-route",
    });
    const decision = routeDecisionSchema.parse(
      await getLlmClient(context).generate(
        {
          kind: "route",
          modelId: MODEL_ID,
          prompt,
          traceId: context.traceId,
          workflowId: "heartbeat-workflow",
          nodeId: "decide-route",
        },
        context,
      ),
    );
    await emitNodeEvent(context, routeDecidedEvent, "decide-route", decision);
    return decision;
  },
});

export function createHeartbeatWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "heartbeat-workflow",
    nodes: [
      loadContextNode,
      compileStateNode,
      updateStateNode,
      compileRouteNode,
      decideRouteNode,
      compileReplyNode,
      createGenerateReplyNode("heartbeat-workflow"),
      persistReplyNode,
    ],
    edges: [
      { from: "load-context", to: "compile-state" },
      { from: "compile-state", to: "update-state" },
      { from: "update-state", to: "compile-route" },
      { from: "compile-route", to: "decide-route" },
      {
        from: "decide-route",
        to: "compile-reply",
        when: (result) => routeDecisionSchema.parse(result).shouldReply,
      },
      { from: "compile-reply", to: "generate-reply" },
      { from: "generate-reply", to: "persist-reply" },
    ],
  });
}

function stateFragments(conversation: ConversationContext): PromptFragment[] {
  return [
    historyFragment("state-history", conversation.messages),
    memoriesFragment("state-memory", conversation.memories),
    promptFragment(
      "state-policy",
      "policy",
      40,
      "Update mood, relationship, and useful short-term memories.",
      { scope: "state" },
    ),
  ];
}
