/**
 * 功能概述：验证 Web HTTP 输入被正规化为窄的平台入站内容，
 * 保留外部 request ID 但不在 adapter 层创建 Core 身份。
 * 主要职责：覆盖确定性 occurredAt、文本/request ID 修剪和严格输入拒绝；
 * 同时明确断言输出不含 `traceId` 或 `informationId`。
 * 代码库关系：直接测试 `web.ts`，服务端 `createWebMessageGateway`使用该结果
 * 调用 `InformationIngress.submit`，Core 身份只能由 Runtime 生成。
 * 输入输出与副作用：测试只处理内存值，无 I/O；非法输入返回 `undefined`。
 */
import { describe, expect, it } from "vitest";

import { normalizeWebInboundMessage } from "./web.js";

describe("normalizeWebInboundMessage", () => {
  it("maps a browser request to a first-class web platform message", () => {
    const input = { text: "hello from web", requestId: "request-1" };
    const message = normalizeWebInboundMessage(input, {
      adapterId: "web.ui.main",
      now: () => new Date("2026-09-01T01:02:03.000Z"),
    });

    expect(message).toEqual({
      platform: "web",
      adapterId: "web.ui.main",
      platformMessageId: "request-1",
      occurredAt: "2026-09-01T01:02:03.000Z",
      text: "hello from web",
      mentions: [],
      target: { kind: "web" },
      sender: { userId: "web" },
      raw: input,
    });
    expect(message).not.toHaveProperty("traceId");
    expect(message).not.toHaveProperty("informationId");
  });

  it("trims surrounding whitespace from text and request ID", () => {
    const message = normalizeWebInboundMessage(
      { text: "  hello  ", requestId: " request-2 " },
      { adapterId: "web.ui.main" },
    );

    expect(message?.text).toBe("hello");
    expect(message?.platformMessageId).toBe("request-2");
    expect(message).not.toHaveProperty("traceId");
    expect(message).not.toHaveProperty("informationId");
  });

  it("rejects blank text, blank request IDs, and extra fields", () => {
    const options = { adapterId: "web.ui.main" };

    expect(
      normalizeWebInboundMessage(
        { text: "   ", requestId: "request-3" },
        options,
      ),
    ).toBeUndefined();
    expect(
      normalizeWebInboundMessage({ text: "hello", requestId: "   " }, options),
    ).toBeUndefined();
    expect(
      normalizeWebInboundMessage({ text: "hello" }, options),
    ).toBeUndefined();
    expect(
      normalizeWebInboundMessage(
        { text: "hello", requestId: "request-4", sessionId: "legacy" },
        options,
      ),
    ).toBeUndefined();
  });
});
