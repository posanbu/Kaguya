import { z } from "@kaguya/schema";
import { defineEvent } from "@kaguya/sdk";

const nonBlankStringSchema = z.string().trim().min(1);

export const messageMentionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: nonBlankStringSchema }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
]);

export const messageConversationSchema = z
  .object({
    kind: z.enum(["direct", "group", "session"]),
    id: nonBlankStringSchema,
  })
  .strict();

export const messageSenderSchema = z
  .object({
    id: nonBlankStringSchema,
    displayName: nonBlankStringSchema.optional(),
  })
  .strict();

export const messageOriginSchema = z
  .object({
    platform: nonBlankStringSchema,
    adapterId: nonBlankStringSchema.optional(),
    messageId: nonBlankStringSchema,
    selfId: nonBlankStringSchema.optional(),
  })
  .strict();

export const messageContextSchema = z
  .object({
    conversation: messageConversationSchema,
    sender: messageSenderSchema.optional(),
    mentions: z.array(messageMentionSchema),
    origin: messageOriginSchema.optional(),
  })
  .strict();

export const moduleMessageSchema = messageContextSchema.extend({
  messageId: nonBlankStringSchema,
  text: z.string(),
});

export type MessageMention = z.infer<typeof messageMentionSchema>;
export type MessageContext = z.infer<typeof messageContextSchema>;
export type ModuleMessage = z.infer<typeof moduleMessageSchema>;

export const messageIngestedEvent = defineEvent(
  "message.ingested",
  z.object({ message: moduleMessageSchema }).strict(),
  { sessionScoped: true },
);

export const replyRequestedEvent = defineEvent(
  "reply.requested",
  z
    .object({
      targetInstanceId: nonBlankStringSchema,
      messageId: nonBlankStringSchema,
    })
    .strict(),
  { sessionScoped: true },
);

export const replyGeneratedEvent = defineEvent(
  "reply.generated",
  z
    .object({
      messageId: nonBlankStringSchema,
      text: nonBlankStringSchema,
    })
    .strict(),
  { sessionScoped: true },
);
