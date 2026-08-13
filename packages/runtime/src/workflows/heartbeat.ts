import {
  defineNode,
  defineWorkflow,
  type WorkflowDefinition,
} from "@kaguya/sdk";

import { heartbeatTickEvent } from "../events.js";

export type HeartbeatEvent = ReturnType<typeof heartbeatTickEvent.create>;

/**
 * Heartbeat no longer discovers a conversation from a Core session. The
 * caller supplies its own context key and exact message selection.
 */
export function createHeartbeatWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "heartbeat-workflow",
    nodes: [
      defineNode<HeartbeatEvent, HeartbeatEvent["payload"]>({
        id: "accept-explicit-context",
        async run(event) {
          return heartbeatTickEvent.payloadSchema.parse(event.payload);
        },
      }),
    ],
    edges: [],
  });
}
