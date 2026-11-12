/**
 * 功能概述：保存模型原生消息与工具声明，供 LLM 单步生成和 Runtime 持久循环共用。
 * nativeToolDeclarationSchema 固定领域身份、wire 别名及输入 schema；nativeToolCallSchema
 * 保存适配器解析前参数和校验状态，不能把 SDK 合成错误当作执行回执。
 * nativeResponseSchema 保留 reasoning/provider 数据；本文件无执行、授权或持久化副作用。
 */
import { z } from "zod";
import { jsonValueSchema } from "./information.js";

/** Provider message contents stay intact. This envelope is independent of situation contract 1.0.0. */
const providerMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(jsonValueSchema)]),
  })
  .catchall(jsonValueSchema);
// The representative branch lets the Information registry verify JSON output.
export const nativeMessageSchema = z
  .union([
    z.strictObject({ role: z.literal("user"), content: z.string() }),
    z.unknown(),
  ])
  .pipe(providerMessageSchema);
const nativeJson = z.union([z.null(), z.unknown()]).pipe(jsonValueSchema);

export const nativeMessagesSchema = z.array(nativeMessageSchema).min(1);
const nativeResponseBase = z
  .object({
    version: z.literal(1),
    messages: nativeMessagesSchema,
    reasoning: z.array(nativeJson),
  })
  .strict();
export const nativeResponseSchema = z.union([
  nativeResponseBase.extend({ providerMetadata: nativeJson }),
  nativeResponseBase,
]);

export type NativeMessage = z.infer<typeof nativeMessageSchema>;
export type NativeResponse = z.infer<typeof nativeResponseSchema>;

export const nativeToolDeclarationSchema = z
  .object({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    wireName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    description: z.string().min(1).max(4000),
    inputSchema: z.record(z.string(), z.json()),
  })
  .strict();
export const nativeToolCallSchema = z
  .object({
    toolCallId: z.string().min(1).max(1000),
    toolName: z.string().min(1).max(1000),
    rawInput: z.string(),
    input: nativeJson,
    validation: z.enum([
      "valid",
      "invalid-input",
      "unknown-tool",
      "provider-executed",
    ]),
  })
  .strict();
export type NativeToolDeclaration = z.infer<typeof nativeToolDeclarationSchema>;
export type NativeToolCall = z.infer<typeof nativeToolCallSchema>;
