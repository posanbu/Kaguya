import { z } from "zod";

export { z };

export interface EventEnvelope<TType = string, TPayload = unknown> {
  id: string;
  type: TType;
  source: string;
  occurredAt: string;
  traceId: string;
  payload: TPayload;
  metadata: Record<string, unknown>;
}

export const eventEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    source: z.string().min(1),
    occurredAt: z.iso.datetime(),
    traceId: z.string().min(1),
    payload: z.unknown(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export const messageRecordSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  occurredAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()),
});

export type MessageRecord = z.infer<typeof messageRecordSchema>;

export const platformDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private"), userId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("group"), groupId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("web") }).strict(),
]);

export type PlatformDestination = z.infer<typeof platformDestinationSchema>;

export const outboundMessageContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("reply"),
      replyToPlatformMessageId: z.string().min(1),
      text: z.string().min(1),
    })
    .strict(),
]);

export type OutboundMessageContent = z.infer<
  typeof outboundMessageContentSchema
>;

const outboundMessageRecordBaseSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  adapterId: z.string().min(1),
  platform: z.string().min(1),
  destination: platformDestinationSchema,
  message: outboundMessageContentSchema,
  occurredAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()),
});

export const outboundMessageRecordSchema = z.discriminatedUnion("status", [
  outboundMessageRecordBaseSchema.extend({ status: z.literal("requested") }),
  outboundMessageRecordBaseSchema.extend({
    status: z.literal("delivered"),
    completedAt: z.iso.datetime(),
    receipt: z.record(z.string(), z.unknown()),
  }),
  outboundMessageRecordBaseSchema.extend({
    status: z.literal("failed"),
    completedAt: z.iso.datetime(),
    error: z.string().min(1),
  }),
]);

export type OutboundMessageRecord = z.infer<typeof outboundMessageRecordSchema>;

export type PromptFragmentSource =
  "template" | "history" | "memory" | "persona" | "policy" | "state";

export const promptFragmentSourceSchema = z.enum([
  "template",
  "history",
  "memory",
  "persona",
  "policy",
  "state",
]);

export const promptFragmentSchema = z.object({
  id: z.string().min(1),
  source: promptFragmentSourceSchema,
  priority: z.number(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

export type PromptFragment = z.infer<typeof promptFragmentSchema>;

export const promptKindSchema = z.enum(["route", "reply", "state", "memory"]);

export const compiledPromptSchema = z.object({
  kind: promptKindSchema,
  text: z.string(),
  fragments: z.array(promptFragmentSchema),
  provenance: z.array(
    z.object({
      fragmentId: z.string().min(1),
      source: promptFragmentSourceSchema,
      priority: z.number(),
      contentDigest: z.string().min(1),
    }),
  ),
});

export type CompiledPrompt = z.infer<typeof compiledPromptSchema>;

export const llmErrorKindSchema = z.enum([
  "retryable",
  "non-retryable",
  "cancelled",
]);

export type LlmErrorKind = z.infer<typeof llmErrorKindSchema>;

const traceBaseSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  kind: promptKindSchema,
  modelId: z.string().min(1),
  causationEventId: z.string().min(1).optional(),
  rootEventId: z.string().min(1).optional(),
  prompt: compiledPromptSchema,
  startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const llmTraceSchema = z.discriminatedUnion("status", [
  traceBaseSchema.extend({
    status: z.literal("completed"),
    completedAt: z.iso.datetime(),
    response: z.unknown(),
  }),
  traceBaseSchema.extend({
    status: z.literal("failed"),
    completedAt: z.iso.datetime(),
    error: z.object({
      name: z.string().min(1),
      message: z.string().min(1),
      kind: llmErrorKindSchema,
    }),
  }),
]);

export type LlmTrace = z.infer<typeof llmTraceSchema>;

const eventRunBaseSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  startedAt: z.iso.datetime(),
});

export const eventRunSchema = z.discriminatedUnion("status", [
  eventRunBaseSchema.extend({ status: z.literal("running") }),
  eventRunBaseSchema.extend({
    status: z.literal("completed"),
    completedAt: z.iso.datetime(),
    output: z.unknown(),
  }),
  eventRunBaseSchema.extend({
    status: z.literal("failed"),
    completedAt: z.iso.datetime(),
    retryable: z.boolean(),
    error: z.object({
      name: z.string().min(1),
      message: z.string().min(1),
    }),
  }),
  eventRunBaseSchema.extend({
    status: z.literal("cancelled"),
    completedAt: z.iso.datetime(),
  }),
]);

export type EventRun = z.infer<typeof eventRunSchema>;
