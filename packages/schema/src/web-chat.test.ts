/**
 * 功能概述：保护 Web 会话、消息和历史分页的共享数据边界。
 * 主要职责：验证 UUID 会话与旧匿名目标兼容，严格拒绝非法会话、时间及消息/分页额外字段。
 * 代码库关系：直接测试 schema 包公共入口，覆盖 Server、Web adapter 与浏览器共同消费的 wire contract。
 * 输入输出与副作用：仅解析内存对象，不访问网络或数据库，也不引入异步等待。
 */
import { describe, expect, it } from "vitest";
import {
  platformDestinationSchema,
  webChatHistorySchema,
  webChatMessageSchema,
  webConversationIdSchema,
} from "./index.js";

const conversationId = "a879c96e-afdd-4716-9b86-8d15d264907f";
const message = {
  id: "information-1",
  role: "assistant",
  text: "你好",
  createdAt: "2026-09-19T00:00:00.000Z",
};

describe("Web chat contract", () => {
  it("accepts isolated UUID targets and preserves the legacy anonymous target", () => {
    expect(platformDestinationSchema.parse({ kind: "web" })).toEqual({
      kind: "web",
    });
    expect(
      platformDestinationSchema.parse({ kind: "web", conversationId }),
    ).toEqual({ kind: "web", conversationId });
    expect(webConversationIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(
      platformDestinationSchema.safeParse({
        kind: "web",
        conversationId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("preserves independent inbound/outbound cursors and optional request correlation", () => {
    const history = {
      conversationId,
      messages: [{ ...message, requestId: "request-1" }],
      cursor: { inbound: "inbound-position", outbound: "outbound-position" },
      hasMore: true,
    };
    expect(webChatHistorySchema.parse(history)).toEqual(history);
    expect(
      webChatHistorySchema.parse({
        conversationId,
        messages: [],
        cursor: {},
        hasMore: false,
      }),
    ).toMatchObject({ messages: [], cursor: {} });
  });

  it("rejects invalid roles, dates and unknown nested fields", () => {
    for (const invalid of [
      { ...message, role: "system" },
      { ...message, createdAt: "yesterday" },
      { ...message, raw: "private-payload" },
    ]) {
      expect(webChatMessageSchema.safeParse(invalid).success).toBe(false);
    }
    const history = {
      conversationId,
      messages: [message],
      cursor: {},
      hasMore: false,
    };
    expect(
      webChatHistorySchema.safeParse({ ...history, extra: true }).success,
    ).toBe(false);
    expect(
      webChatHistorySchema.safeParse({
        ...history,
        cursor: { secret: "value" },
      }).success,
    ).toBe(false);
  });
});
