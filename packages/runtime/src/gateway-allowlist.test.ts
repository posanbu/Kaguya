/**
 * 功能概述：验证 GatewayAllowlist 对平台、用户与群目标的组合匹配，
 * 使用不含 Core identity 的 `PlatformInboundMessage` fixture。
 * 主要职责：覆盖精确群聊/私聊、OR、platform/target 通配、空规则拒绝、
 * 非法规则忽略、修剪/去重，以及 Web 消息始终交由 bearer token 边界。
 * 代码库关系：直接测试 `gateway-allowlist.ts`；该类属于 Runtime 的暂存公共面，
 * Task 5 的 Web/NapCat ingress 收口不向 adapter 暴露它。
 * 输入输出与副作用：测试只构造内存消息并调用同步 `allows`，无 I/O。
 */
import { describe, expect, it } from "vitest";

import { GatewayAllowlist } from "./gateway-allowlist.js";

const baseMessage = {
  platform: "qq" as const,
  adapterId: "napcat.qq.main",
  selfId: "998877",
  platformMessageId: "message-1",
  occurredAt: "2026-08-16T00:00:00.000Z",
  text: "hello",
  mentions: [],
  target: { kind: "group" as const, groupId: "group-1" },
  sender: { userId: "user-1" },
  raw: {},
};

describe("GatewayAllowlist", () => {
  it("denies platform messages when no rule is configured", () => {
    expect(new GatewayAllowlist().allows(baseMessage)).toBe(false);
  });

  it("matches exact group and private targets without crossing chat types", () => {
    const allowlist = new GatewayAllowlist([
      "qq:group:group-1",
      "qq:private:user-2",
    ]);

    expect(allowlist.allows(baseMessage)).toBe(true);
    expect(
      allowlist.allows({
        ...baseMessage,
        sender: { userId: "another-group-member" },
      }),
    ).toBe(true);
    expect(
      allowlist.allows({
        ...baseMessage,
        target: { kind: "private", userId: "user-2" },
      }),
    ).toBe(true);
    expect(
      allowlist.allows({
        ...baseMessage,
        target: { kind: "private", userId: "group-1" },
      }),
    ).toBe(false);
    expect(
      allowlist.allows({
        ...baseMessage,
        target: { kind: "group", groupId: "group-2" },
      }),
    ).toBe(false);
  });

  it("ORs rules and supports platform and target wildcards", () => {
    const allowlist = new GatewayAllowlist(["*:group:group-2", "qq:private:*"]);
    expect(
      new GatewayAllowlist(["another-platform:group:group-1"]).allows(
        baseMessage,
      ),
    ).toBe(false);
    expect(
      allowlist.allows({
        ...baseMessage,
        platform: "qq",
        target: { kind: "group", groupId: "group-2" },
      }),
    ).toBe(true);
    expect(
      allowlist.allows({
        ...baseMessage,
        target: { kind: "private", userId: "any-user" },
      }),
    ).toBe(true);
    expect(allowlist.allows(baseMessage)).toBe(false);
  });

  it("trims, deduplicates and ignores malformed rules", () => {
    const allowlist = new GatewayAllowlist([
      " qq : group : group-1 ",
      "qq:group:group-1",
      "qq:channel:group-1",
      "qq:group",
      "qq:group:group-1:extra",
      ":group:group-1",
      "qq:private:",
    ]);
    expect(allowlist.allows(baseMessage)).toBe(true);
    expect(new GatewayAllowlist(["invalid"]).allows(baseMessage)).toBe(false);
  });

  it("leaves Web messages to the bearer-token boundary", () => {
    const webMessage = {
      platform: "web" as const,
      adapterId: "web.ui.main",
      platformMessageId: "request-1",
      occurredAt: "2026-08-16T00:00:00.000Z",
      text: "hello",
      mentions: [],
      target: { kind: "web" as const },
      sender: { userId: "web" },
      raw: {},
    };

    expect(new GatewayAllowlist([]).allows(webMessage)).toBe(true);
  });
});
