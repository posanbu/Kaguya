import { z } from "@kaguya/schema";

const generatedTextSchema = z.string().trim().min(1);

export const routeOutputSchema = z
  .object({
    shouldReply: z.boolean(),
    reason: generatedTextSchema.optional(),
  })
  .strict();

export const replyOutputSchema = z
  .object({
    text: generatedTextSchema,
  })
  .strict();

export const stateOutputSchema = z
  .object({
    mood: generatedTextSchema,
    relationship: generatedTextSchema,
    shortTermMemories: z.array(generatedTextSchema),
  })
  .strict();

export const memoryOutputSchema = z
  .object({
    memories: z.array(generatedTextSchema),
  })
  .strict();

export type RouteOutput = z.infer<typeof routeOutputSchema>;
export type ReplyOutput = z.infer<typeof replyOutputSchema>;
export type StateOutput = z.infer<typeof stateOutputSchema>;
export type MemoryOutput = z.infer<typeof memoryOutputSchema>;

export interface KaguyaLlmOutputByKind {
  route: RouteOutput;
  reply: ReplyOutput;
  state: StateOutput;
  memory: MemoryOutput;
}
