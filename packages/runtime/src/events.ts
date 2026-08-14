import {
  messageIngestedEvent,
  outboundMessageDeliveredEvent,
  outboundMessageFailedEvent,
  outboundMessageRequestedEvent,
  replyRequestedEvent,
} from "@kaguya/modules";
import {
  llmErrorKindSchema,
  promptFragmentSourceSchema,
  promptKindSchema,
  z,
} from "@kaguya/schema";
import { defineEvent } from "@kaguya/sdk";

const nonBlankStringSchema = z.string().trim().min(1);
const emptyPayloadSchema = z.object({}).strict();
const memoryKindSchema = z.enum(["long-term", "short-term", "state"]);
const explicitContextSchema = z
  .object({
    contextKey: nonBlankStringSchema,
    messageIds: z.array(nonBlankStringSchema),
  })
  .strict();
const llmLifecyclePayloadSchema = z
  .object({
    kind: promptKindSchema,
    modelId: nonBlankStringSchema,
    workflowId: nonBlankStringSchema,
    nodeId: nonBlankStringSchema,
  })
  .strict();

export const memoryWindowSchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .strict()
  .refine(
    ({ from, to }) => Date.parse(from) <= Date.parse(to),
    "from must be before or equal to to",
  );

export const messageReceivedEvent = defineEvent(
  "message.received",
  z.object({ text: z.string() }).strict(),
);

export const messagePersistedEvent = defineEvent(
  "message.persisted",
  z
    .object({
      messageId: nonBlankStringSchema,
      role: z.enum(["assistant", "system", "user"]),
    })
    .strict(),
);

export const heartbeatTickEvent = defineEvent(
  "heartbeat.tick",
  explicitContextSchema,
);
export const memoryScheduleTickEvent = defineEvent(
  "memory.schedule.tick",
  memoryWindowSchema
    .extend({ contexts: z.array(explicitContextSchema) })
    .strict(),
);
export const memorySessionTickEvent = defineEvent(
  "memory.context.tick",
  memoryWindowSchema
    .extend({
      contextKey: nonBlankStringSchema,
      messageIds: z.array(nonBlankStringSchema),
    })
    .strict(),
);

export const routeRequestedEvent = defineEvent(
  "route.requested",
  z
    .object({
      workflowId: nonBlankStringSchema,
      nodeId: nonBlankStringSchema,
    })
    .strict(),
);
export const routeDecidedEvent = defineEvent(
  "route.decided",
  z.object({ shouldReply: z.boolean(), reason: z.string() }).strict(),
);

export const promptCompiledEvent = defineEvent(
  "prompt.compiled",
  z
    .object({
      kind: promptKindSchema,
      provenance: z.array(
        z
          .object({
            fragmentId: nonBlankStringSchema,
            source: promptFragmentSourceSchema,
            priority: z.number(),
            contentDigest: nonBlankStringSchema,
          })
          .strict(),
      ),
    })
    .strict(),
);

export const llmRequestedEvent = defineEvent(
  "llm.requested",
  llmLifecyclePayloadSchema,
);
export const llmCompletedEvent = defineEvent(
  "llm.completed",
  llmLifecyclePayloadSchema,
);
export const llmFailedEvent = defineEvent(
  "llm.failed",
  llmLifecyclePayloadSchema
    .extend({
      error: z
        .object({
          name: nonBlankStringSchema,
          message: nonBlankStringSchema,
          kind: llmErrorKindSchema,
        })
        .strict(),
    })
    .strict(),
);

export const memoryWriteRequestedEvent = defineEvent(
  "memory.write.requested",
  z
    .object({
      memoryId: nonBlankStringSchema,
      kind: memoryKindSchema,
      content: nonBlankStringSchema,
    })
    .strict(),
);
export const memoryWrittenEvent = defineEvent(
  "memory.written",
  z.object({ memoryId: nonBlankStringSchema, kind: memoryKindSchema }).strict(),
);

export const approvedEventDefinitions = [
  messageReceivedEvent,
  messagePersistedEvent,
  messageIngestedEvent,
  heartbeatTickEvent,
  memoryScheduleTickEvent,
  memorySessionTickEvent,
  routeRequestedEvent,
  routeDecidedEvent,
  promptCompiledEvent,
  llmRequestedEvent,
  llmCompletedEvent,
  llmFailedEvent,
  memoryWriteRequestedEvent,
  memoryWrittenEvent,
  replyRequestedEvent,
  outboundMessageRequestedEvent,
  outboundMessageDeliveredEvent,
  outboundMessageFailedEvent,
] as const;

export {
  messageIngestedEvent,
  outboundMessageDeliveredEvent,
  outboundMessageFailedEvent,
  outboundMessageRequestedEvent,
  replyRequestedEvent,
};
