import type { RouteOutput } from "@kaguya/llm";
import {
  type CompiledPrompt,
  type MessageRecord,
  eventEnvelopeSchema,
} from "@kaguya/schema";
import {
  defineNode,
  defineWorkflow,
  type WorkflowDefinition,
} from "@kaguya/sdk";

import {
  messagePersistedEvent,
  messageReceivedEvent,
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
  loadContextNode,
  persistReplyNode,
  requiredSessionId,
  routeDecisionSchema,
  routeFragments,
  sendReplyNode,
  type SendReplyInput,
  type ConversationContext,
} from "./shared.js";

export type MessageReceivedEvent = ReturnType<
  typeof messageReceivedEvent.create
>;

const persistMessageNode = defineNode<
  MessageReceivedEvent,
  MessageReceivedEvent
>({
  id: "persist-message",
  async run(event, context) {
    assertOrigin(event, messageReceivedEvent, context);
    const payload = messageReceivedEvent.payloadSchema.parse(event.payload);
    const record: MessageRecord = {
      id: context.nextId("message"),
      sessionId: requiredSessionId(context),
      role: "user",
      content: payload.text,
      occurredAt: event.occurredAt,
      metadata: {
        ...event.metadata,
        eventId: event.id,
        traceId: context.traceId,
      },
    };
    getDatabase(context).messages.insert(record);
    await emitNodeEvent(context, messagePersistedEvent, "persist-message", {
      messageId: record.id,
      role: record.role,
    });
    return event;
  },
});

const compileRouteNode = defineNode<ConversationContext, CompiledPrompt>({
  id: "compile-route",
  async run(conversation, context) {
    return compileAndPublish(
      "route",
      routeFragments(conversation),
      "compile-route",
      context,
    );
  },
});

const decideRouteNode = defineNode<CompiledPrompt, RouteOutput>({
  id: "decide-route",
  async run(prompt, context) {
    await emitNodeEvent(context, routeRequestedEvent, "decide-route", {
      workflowId: "message-workflow",
      nodeId: "decide-route",
    });
    const decision = routeDecisionSchema.parse(
      await getLlmClient(context).generate(
        {
          kind: "route",
          modelId: MODEL_ID,
          prompt,
          traceId: context.traceId,
          workflowId: "message-workflow",
          nodeId: "decide-route",
        },
        context,
      ),
    );
    await emitNodeEvent(context, routeDecidedEvent, "decide-route", decision);
    return decision;
  },
});

const prepareSendReplyNode = defineNode<MessageRecord, SendReplyInput>({
  id: "prepare-send-reply",
  async run(reply, context) {
    const originalEvent = context.services.messageReceivedEvent;
    const event = eventEnvelopeSchema.parse(originalEvent);
    return { event: { ...event, sessionId: requiredSessionId(context) }, reply };
  },
});

export function createMessageWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "message-workflow",
    nodes: [
      persistMessageNode,
      loadContextNode,
      compileRouteNode,
      decideRouteNode,
      compileReplyNode,
      createGenerateReplyNode("message-workflow"),
      persistReplyNode,
      prepareSendReplyNode,
      sendReplyNode,
    ],
    edges: [
      { from: "persist-message", to: "load-context" },
      { from: "load-context", to: "compile-route" },
      { from: "compile-route", to: "decide-route" },
      {
        from: "decide-route",
        to: "compile-reply",
        when: (result) => routeDecisionSchema.parse(result).shouldReply,
      },
      { from: "compile-reply", to: "generate-reply" },
      { from: "generate-reply", to: "persist-reply" },
      { from: "persist-reply", to: "prepare-send-reply" },
      { from: "prepare-send-reply", to: "send-reply" },
    ],
  });
}
