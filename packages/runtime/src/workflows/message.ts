import type { MessageRecord } from "@kaguya/schema";
import {
  defineNode,
  defineWorkflow,
  type WorkflowDefinition,
} from "@kaguya/sdk";

import { messageReceivedEvent } from "../events.js";
import { getDatabase } from "../services.js";

export type MessageReceivedEvent = ReturnType<
  typeof messageReceivedEvent.create
>;

/** @deprecated Runtime message ingress now publishes message.ingested directly. */
export function createMessageWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "message-ingress-workflow",
    nodes: [
      defineNode<MessageReceivedEvent, MessageRecord>({
        id: "persist-message",
        async run(event, context) {
          const payload = messageReceivedEvent.payloadSchema.parse(
            event.payload,
          );
          const record: MessageRecord = {
            id: context.nextId("message"),
            role: "user",
            content: payload.text,
            occurredAt: event.occurredAt,
            metadata: { eventId: event.id, traceId: context.traceId },
          };
          getDatabase(context).messages.insert(record);
          return record;
        },
      }),
    ],
    edges: [],
  });
}
