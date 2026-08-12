import { replyOutputSchema, routeOutputSchema } from "@kaguya/llm/schemas";
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
const llmLifecyclePayloadSchema = z
  .object({
    kind: promptKindSchema,
    modelId: nonBlankStringSchema,
    workflowId: nonBlankStringSchema,
    nodeId: nonBlankStringSchema,
  })
  .strict();

export const memoryWindowSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ from, to }) => Date.parse(from) <= Date.parse(to),
    "from must be before or equal to to",
  );

export const messageReceivedEvent = defineEvent(
  "message.received",
  z.object({ text: z.string() }).strict(),
  { sessionScoped: true },
);

export const messagePersistedEvent = defineEvent(
  "message.persisted",
  z
    .object({
      messageId: nonBlankStringSchema,
      role: z.enum(["assistant", "system", "user"]),
    })
    .strict(),
  { sessionScoped: true },
);

export const heartbeatTickEvent = defineEvent(
  "heartbeat.tick",
  emptyPayloadSchema,
  { sessionScoped: true },
);

export const memoryScheduleTickEvent = defineEvent(
  "memory.schedule.tick",
  memoryWindowSchema,
);

export const routeRequestedEvent = defineEvent(
  "route.requested",
  z
    .object({
      workflowId: nonBlankStringSchema,
      nodeId: nonBlankStringSchema,
    })
    .strict(),
  { sessionScoped: true },
);

export const routeDecidedEvent = defineEvent(
  "route.decided",
  routeOutputSchema,
  { sessionScoped: true },
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
  { sessionScoped: true },
);

export const llmRequestedEvent = defineEvent(
  "llm.requested",
  llmLifecyclePayloadSchema,
  { sessionScoped: true },
);

export const llmCompletedEvent = defineEvent(
  "llm.completed",
  llmLifecyclePayloadSchema,
  { sessionScoped: true },
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
  { sessionScoped: true },
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
  { sessionScoped: true },
);

export const memoryWrittenEvent = defineEvent(
  "memory.written",
  z
    .object({
      memoryId: nonBlankStringSchema,
      kind: memoryKindSchema,
    })
    .strict(),
  { sessionScoped: true },
);

export const replyGeneratedEvent = defineEvent(
  "reply.generated",
  replyOutputSchema,
  { sessionScoped: true },
);

export const memorySessionTickEvent = defineEvent(
  "memory.session.tick",
  memoryWindowSchema,
  { sessionScoped: true },
);

export const approvedEventDefinitions = [
  messageReceivedEvent,
  messagePersistedEvent,
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
  replyGeneratedEvent,
] as const;
