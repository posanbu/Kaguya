/**
 * 功能概述：验证 Web 私聊 HTTP 边界，确保历史鉴权、游标错误和持久化失败不会被隐藏。
 * 主要职责：通过 Fastify inject 覆盖认证优先级、严格参数、禁止缓存、独立轮询额度和
 * 异步入站结果；不依赖模型速度或定时休眠，持久化异常用受控 Promise 表达。
 * 代码库关系：补充 web-chat.integration.test.ts 的真实 Runtime 闭环，聚焦 app.ts 的外部契约。
 * 输入输出与副作用：仅使用合成凭据和内存 HTTP 请求，每个应用均在 finally 中关闭。
 */
import { describe, expect, it, vi } from "vitest";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { InvalidWebChatCursorError } from "./web-chat.js";

const conversationId = "74f05f76-e867-48a3-9937-07aa3fe64eb1";
const requestId = "4682d51e-fd96-490c-a8a8-17ba1954468f";
const token = "synthetic-web-chat-token";
const headers = { authorization: `Bearer ${token}` };
const url = `/api/v1/messages?conversationId=${conversationId}`;
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken: token,
  corsOrigins: [],
  trustProxy: false,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  databaseUrl: "postgresql://test@database.invalid:5432/test",
  configRoot: "/tmp/kaguya-chat-http",
  development: false,
  webDistPath: "/tmp/kaguya-chat-http-web",
  logLevel: "silent",
  logFormat: "json",
  inboundAllowlist: [],
  outboundAllowlist: [],
  napcat: { enabled: false, adapterId: "napcat.qq.main", reconnectMs: 3000 },
};
const emptyHistory = {
  conversationId,
  messages: [],
  cursor: {},
  hasMore: false,
};

describe("Web private chat HTTP contract", () => {
  it("authenticates before validating or reading, and does not cache history", async () => {
    const read = vi.fn(async () => emptyHistory);
    const app = await createHttpApplication({
      config,
      webChatHistory: () => ({ read }),
    });
    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/v1/messages?conversationId=invalid",
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.headers["cache-control"]).toBe("no-store");
      expect(read).not.toHaveBeenCalled();
      for (const invalidUrl of [
        "/api/v1/messages",
        "/api/v1/messages?conversationId=invalid",
        `${url}&extra=secret`,
        `${url}&afterInbound=`,
      ]) {
        const response = await app.inject({
          method: "GET",
          url: invalidUrl,
          headers,
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(read).not.toHaveBeenCalled();
      const response = await app.inject({
        method: "GET",
        url: `${url}&afterInbound=in-1&afterOutbound=out-2`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: emptyHistory });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(read).toHaveBeenCalledExactlyOnceWith({
        conversationId,
        afterInbound: "in-1",
        afterOutbound: "out-2",
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["unavailable", 503, "core_unavailable"],
    ["foreign-cursor", 400, "invalid_chat_cursor"],
  ] as const)(
    "reports %s history instead of an empty successful chat",
    async (mode, status, code) => {
      const app = await createHttpApplication({
        config,
        webChatHistory: () =>
          mode === "unavailable"
            ? undefined
            : {
                read: async () => {
                  throw new InvalidWebChatCursorError();
                },
              },
      });
      try {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        expect(response.headers["cache-control"]).toBe("no-store");
      } finally {
        await app.close();
      }
    },
  );

  it("forwards the stable conversation and request IDs, and awaits the asynchronous gateway result", async () => {
    const ingest = vi.fn(async () => {
      throw new Error("synthetic persistence failure");
    });
    const app = await createHttpApplication({ config, webGateway: { ingest } });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers: { ...headers, "x-request-id": requestId },
        payload: { text: "你好", conversationId },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("synthetic persistence failure");
      expect(ingest).toHaveBeenCalledExactlyOnceWith({
        text: "你好",
        conversationId,
        requestId,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("keeps normal history polling separate from the send budget", async () => {
    const ingest = vi.fn();
    const app = await createHttpApplication({
      config: { ...config, rateLimitMax: 2 },
      webGateway: { ingest },
      webChatHistory: () => ({ read: async () => emptyHistory }),
    });
    try {
      for (let index = 0; index < 35; index += 1) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode).toBe(200);
      }
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers,
        payload: { text: "hello", conversationId },
      });
      expect(response.statusCode).toBe(202);
      expect(ingest).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
