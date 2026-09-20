/**
 * 功能概述：验证 Web HTTP 输入被正规化为窄的平台入站内容，
 * 保留外部 request ID 但不在 adapter 层创建 Core 身份。
 * 主要职责：覆盖确定性 occurredAt、文本/request ID 修剪和严格输入拒绝；
 * 同时明确断言输出不含 `traceId` 或 `informationId`。
 * 会话测试覆盖不同 conversationId 的目标/发送者隔离；出口回执覆盖旧目标、独立平台 ID 与错误目标拒绝。
 * 代码库关系：直接测试 `web.ts`，服务端 `createWebMessageGateway`使用该结果
 * 调用 `InformationIngress.submit`，Core 身份只能由 Runtime 生成。
 * 输入输出与副作用：测试只处理内存值，无 I/O；非法输入返回 `undefined`。
 */
import { describe, expect, it } from "vitest";

import type { PlatformMessageTarget } from "./types.js";
import {
  createWebOutboundTransport,
  normalizeWebInboundMessage,
} from "./web.js";

const conversationA = "a879c96e-afdd-4716-9b86-8d15d264907f";
const conversationB = "9f23283f-fe96-4fcf-9c27-13349329a353";

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

  it("isolates browser conversations while retaining stable sender and target within one conversation", () => {
    const normalize = (conversationId: string, requestId: string) =>
      normalizeWebInboundMessage(
        { text: "hello", requestId, conversationId },
        { adapterId: "web.ui.main" },
      )!;
    const first = normalize(conversationA, "request-a1");
    const next = normalize(conversationA, "request-a2");
    const other = normalize(conversationB, "request-b1");
    expect(first.target).toEqual({
      kind: "web",
      conversationId: conversationA,
    });
    expect(first.sender).toEqual({ userId: `web:${conversationA}` });
    expect(next.target).toEqual(first.target);
    expect(next.sender).toEqual(first.sender);
    expect(other.target).not.toEqual(first.target);
    expect(other.sender).not.toEqual(first.sender);
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
    expect(
      normalizeWebInboundMessage(
        { text: "hello", requestId: "request-5", conversationId: "invalid" },
        options,
      ),
    ).toBeUndefined();
  });
});

describe("createWebOutboundTransport", () => {
  it("acknowledges each Web destination with a distinct platform receipt", async () => {
    const transport = createWebOutboundTransport();
    const targets: PlatformMessageTarget[] = [
      { kind: "web" },
      { kind: "web", conversationId: conversationA },
      { kind: "web", conversationId: conversationB },
    ];
    const receipts = await Promise.all(
      targets.map((target) =>
        transport.sendMessage(target, { kind: "text", text: "reply" }),
      ),
    );
    receipts.forEach((receipt, index) => {
      expect(receipt).toMatchObject({
        ok: true,
        adapterId: "web.ui.main",
        platform: "web",
        target: targets[index],
      });
      expect(receipt.platformMessageId).toMatch(/^[0-9a-f-]{36}$/u);
    });
    expect(
      new Set(receipts.map((receipt) => receipt.platformMessageId)).size,
    ).toBe(3);
    expect(
      await createWebOutboundTransport("web.secondary").sendMessage(
        { kind: "web", conversationId: conversationA },
        { kind: "text", text: "another reply" },
      ),
    ).toMatchObject({ adapterId: "web.secondary" });
  });

  it("rejects non-Web and malformed Web targets instead of acknowledging delivery", async () => {
    const transport = createWebOutboundTransport();
    await expect(
      transport.sendMessage(
        { kind: "private", userId: "123" },
        { kind: "text", text: "reply" },
      ),
    ).rejects.toThrow("Web transport only accepts web destinations");
    await expect(
      transport.sendMessage(
        { kind: "web", conversationId: "invalid" } as PlatformMessageTarget,
        { kind: "text", text: "reply" },
      ),
    ).rejects.toThrow();
  });
});
