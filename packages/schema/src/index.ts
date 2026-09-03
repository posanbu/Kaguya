/**
 * 功能概述：聚合 Kaguya 跨包共享的稳定 wire schema，包括信息原子、平台投递内容、
 * Prompt 结构与 LLM 错误分类；旧事件信封和持久化记录身份不再属于公共契约。
 * 主要职责：重新导出 `information.ts` 的不可变原子类型；本文件声明平台目标与消息
 * 内容 schema、Prompt fragment/compiled prompt schema，以及低层 LLM 错误种类。
 * 代码库关系：platform adapters、modules、prompt、llm 与 runtime 都从本入口消费数据
 * 边界；持久化事实统一使用 `InformationAtom`，数据库不再依赖事件或消息记录 schema。
 * 输入输出与副作用：所有 schema 只做同步解析与校验，不产生 I/O；严格对象 schema
 * 会拒绝未声明字段，平台返回的 `platformMessageId` 仍作为合法外部身份保留。
 */
import { z } from "zod";

export { z };

export {
  freezeInformationAtom,
  informationAtomSchema,
  informationIdSchema,
  informationReferenceSchema,
  jsonObjectSchema,
  jsonValueSchema,
  parseInformationAtom,
} from "./information.js";
export type {
  DeepReadonly,
  InformationAtom,
  InformationId,
  InformationReference,
  JsonObject,
  JsonPrimitive,
  JsonValue,
} from "./information.js";

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
