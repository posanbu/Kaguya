/**
 * 功能概述：定义 LLM 各类输出的严格校验契约。
 * 主要职责：按 route、message、state、memory 区分输出类型，由 LLM 客户端及其消费者使用。
 * 输入输出与副作用：消息生成使用 message Prompt kind；不注册或兼容旧 reply Prompt。
 */
import { z } from "@kaguya/schema";

const generatedTextSchema = z.string().trim().min(1);

export const routeOutputSchema = z
  .object({
    shouldReply: z.boolean(),
    reason: generatedTextSchema.optional(),
  })
  .strict();

export const messageOutputSchema = z
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
export type MessageOutput = z.infer<typeof messageOutputSchema>;
export type StateOutput = z.infer<typeof stateOutputSchema>;
export type MemoryOutput = z.infer<typeof memoryOutputSchema>;

export interface KaguyaLlmOutputByKind {
  route: RouteOutput;
  message: MessageOutput;
  state: StateOutput;
  memory: MemoryOutput;
}
