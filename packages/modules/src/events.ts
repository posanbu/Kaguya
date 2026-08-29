import {
  outboundMessageContentSchema,
  platformDestinationSchema,
  z,
} from "@kaguya/schema";
import { defineEvent } from "@kaguya/sdk";

const nonBlankStringSchema = z.string().trim().min(1);

export const messageMentionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: nonBlankStringSchema }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
]);

export const messageSenderSchema = z
  .object({
    id: nonBlankStringSchema,
    displayName: nonBlankStringSchema.optional(),
  })
  .strict();

export const moduleMessageSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("web"),
      requestId: nonBlankStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("platform"),
      platform: nonBlankStringSchema,
      adapterId: nonBlankStringSchema,
      platformMessageId: nonBlankStringSchema,
      selfId: nonBlankStringSchema.optional(),
      destination: platformDestinationSchema,
      sender: messageSenderSchema,
      mentions: z.array(messageMentionSchema),
    })
    .strict(),
]);

export const moduleMessageSchema = z
  .object({
    messageId: nonBlankStringSchema,
    text: z.string(),
    occurredAt: z.iso.datetime(),
    source: moduleMessageSourceSchema,
  })
  .strict();

export type MessageMention = z.infer<typeof messageMentionSchema>;
export type ModuleMessageSource = z.infer<typeof moduleMessageSourceSchema>;
export type ModuleMessage = z.infer<typeof moduleMessageSchema>;

export const messageIngestedEvent = defineEvent(
  "message.ingested",
  z.object({ message: moduleMessageSchema }).strict(),
);

export const replyRequestedEvent = defineEvent(
  "reply.requested",
  z
    .object({
      targetInstanceId: nonBlankStringSchema,
      messageId: nonBlankStringSchema,
    })
    .strict(),
);

export const outboundMessageRequestedEvent = defineEvent(
  "message.outbound.requested",
  z
    .object({
      adapterId: nonBlankStringSchema,
      platform: nonBlankStringSchema,
      destination: platformDestinationSchema,
      message: outboundMessageContentSchema,
    })
    .strict(),
);

const outboundResultBaseSchema = z.object({
  outboundMessageId: nonBlankStringSchema,
  adapterId: nonBlankStringSchema,
  platform: nonBlankStringSchema,
});

export const outboundMessageDeliveredEvent = defineEvent(
  "message.outbound.delivered",
  outboundResultBaseSchema.strict(),
);

export const outboundMessageFailedEvent = defineEvent(
  "message.outbound.failed",
  outboundResultBaseSchema.extend({ error: nonBlankStringSchema }).strict(),
);
