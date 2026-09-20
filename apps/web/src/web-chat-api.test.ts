/**
 * 功能概述：验证 Web 私聊 API 在浏览器与服务端之间的会话、增量水位和鉴权契约。
 * 主要职责：检查发送请求的会话体与关联 ID、双向历史游标编码、取消信号和严格响应校验。
 * 代码库关系：测试 api.ts 的 sendMessage/getConversationMessages，补充 api.test.ts 的旧发送兼容路径。
 * 输入输出与副作用：所有请求使用模拟 fetch 和 Response，不访问网络；401 测试临时模拟浏览器
 * EventTarget 并恢复，确保聊天读取也触发 App 的既有锁屏事件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_UNAUTHORIZED_EVENT,
  getConversationMessages,
  sendMessage,
} from "./api.js";

const config = { token: "test-token" };
const conversationId = "7fbad7c9-5998-421d-9608-a6cfb5ed9bdc";
const page = {
  conversationId,
  messages: [
    {
      id: "inbound-1",
      role: "user",
      text: "你好",
      createdAt: "2026-09-19T00:00:00.000Z",
      requestId: "request-1",
    },
  ],
  cursor: { inbound: "next-inbound", outbound: "next-outbound" },
  hasMore: false,
};
afterEach(() => vi.unstubAllGlobals());

describe("Web chat API", () => {
  it("sends the conversation in JSON and the optimistic request ID only in its header", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { data: { status: "accepted", requestId: "request-1" } },
          { status: 202 },
        ),
      );
    const signal = new AbortController().signal;
    await expect(
      sendMessage(config, { text: "你好", conversationId }, request, {
        signal,
        requestId: "request-1",
      }),
    ).resolves.toEqual({ status: "accepted", requestId: "request-1" });
    const init = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "你好",
      conversationId,
    });
    expect(init?.signal).toBe(signal);
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-token",
      "x-request-id": "request-1",
    });
  });

  it("encodes both cursors and preserves the cancellation signal without caching history", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: page }));
    const signal = new AbortController().signal;
    await expect(
      getConversationMessages(
        config,
        { conversationId, cursor: { inbound: "in+1", outbound: "out/2" } },
        signal,
        request,
      ),
    ).resolves.toEqual(page);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/messages?conversationId=${conversationId}&afterInbound=in%2B1&afterOutbound=out%2F2`,
      {
        method: "GET",
        cache: "no-store",
        signal,
        headers: { authorization: "Bearer test-token" },
      },
    );
  });

  it.each([
    { ...page, conversationId: "another-conversation" },
    { ...page, messages: [{ ...page.messages[0], role: "system" }] },
    { ...page, messages: [{ ...page.messages[0], createdAt: "not-a-date" }] },
    { ...page, cursor: { inbound: 1 } },
    { ...page, hasMore: "yes" },
  ])("rejects malformed or cross-conversation history", async (data) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data }));
    await expect(
      getConversationMessages(
        config,
        { conversationId },
        new AbortController().signal,
        request,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("emits the existing lock event on an authenticated history 401", async () => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const lock = vi.fn();
    window.addEventListener(GATEWAY_UNAUTHORIZED_EVENT, lock);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          {
            error: {
              code: "unauthorized",
              message: "Unauthorized",
              requestId: "request-401",
            },
          },
          { status: 401 },
        ),
      );
    await expect(
      getConversationMessages(
        config,
        { conversationId },
        new AbortController().signal,
        request,
      ),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(lock).toHaveBeenCalledOnce();
  });
});
