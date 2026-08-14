import {
  defineNode,
  defineWorkflow,
  type WorkflowDefinition,
} from "@kaguya/sdk";

import { memoryScheduleTickEvent } from "../events.js";

export type MemoryScheduleEvent = ReturnType<
  typeof memoryScheduleTickEvent.create
>;

/**
 * Memory scheduling accepts caller-owned contexts and never scans Core
 * messages for inferred private/group sessions.
 */
export function createMemoryWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: "memory-workflow",
    nodes: [
      defineNode<MemoryScheduleEvent, { contextKeys: readonly string[] }>({
        id: "accept-explicit-contexts",
        async run(event) {
          const payload = memoryScheduleTickEvent.payloadSchema.parse(
            event.payload,
          );
          return {
            contextKeys: payload.contexts.map(({ contextKey }) => contextKey),
          };
        },
      }),
    ],
    edges: [],
  });
}
