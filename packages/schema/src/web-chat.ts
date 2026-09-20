/**
 * 功能概述：定义浏览器对话的共享 wire contract，让会话隔离与历史分页在 Server/WebUI 之间保持一致。
 * 主要职责：webConversationIdSchema 校验 UUID 会话标识；webChatMessageSchema 校验可展示消息；
 * webChatHistorySchema 保留会话、消息数组及入站/出站独立游标，供历史读取接口与客户端共同解析。
 * 代码库关系：由 schema/index.ts 导出；平台 Web 目标与正规化器复用会话标识，不替代 Runtime 的信息身份。
 * 输入输出与副作用：所有对象严格拒绝额外字段，createdAt 使用 ISO 时间；仅同步校验，无缓存或 I/O。
 */
import { z } from "zod";

export const webConversationIdSchema = z.uuid();
export type WebConversationId = z.infer<typeof webConversationIdSchema>;

export const webChatMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    createdAt: z.iso.datetime(),
    requestId: z.string().optional(),
  })
  .strict();
export type WebChatMessage = z.infer<typeof webChatMessageSchema>;

export const webChatHistorySchema = z
  .object({
    conversationId: webConversationIdSchema,
    messages: z.array(webChatMessageSchema),
    cursor: z
      .object({
        inbound: z.string().optional(),
        outbound: z.string().optional(),
      })
      .strict(),
    hasMore: z.boolean(),
  })
  .strict();
export type WebChatHistory = z.infer<typeof webChatHistorySchema>;
