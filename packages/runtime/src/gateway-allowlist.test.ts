/**
 * 功能概述：验证 GatewayAllowlist 对平台、用户与群目标的组合匹配，
 * 使用不含 Core identity 的 `PlatformInboundMessage` fixture。
 * 主要职责：覆盖空维度通配、多维同时命中、群白名单拒绝私聊、
 * ID 修剪/去重，以及 Web 消息始终交由 bearer token 边界而不受平台名单拒绝。
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
  it("allows every platform message when no dimension is configured", () => {
    expect(new GatewayAllowlist().allows(baseMessage)).toBe(true);
  });

  it("requires every configured dimension to match", () => {
    const allowlist = new GatewayAllowlist({
      platforms: ["qq"],
      userIds: ["user-1"],
      groupIds: ["group-1"],
    });

    expect(allowlist.allows(baseMessage)).toBe(true);
    expect(
      allowlist.allows({ ...baseMessage, sender: { userId: "user-2" } }),
    ).toBe(false);
    expect(
      allowlist.allows({
        ...baseMessage,
        target: { kind: "group", groupId: "group-2" },
      }),
    ).toBe(false);
    expect(
      new GatewayAllowlist({ platforms: ["other"] }).allows(baseMessage),
    ).toBe(false);
  });

  it("rejects private messages when a group allowlist is configured", () => {
    const allowlist = new GatewayAllowlist({ groupIds: ["group-1"] });
    expect(
      allowlist.allows({
        ...baseMessage,
        target: { kind: "private", userId: "user-1" },
      }),
    ).toBe(false);
  });

  it("trims and deduplicates configured IDs", () => {
    const allowlist = new GatewayAllowlist({
      userIds: [" user-1 ", "user-1"],
    });
    expect(allowlist.allows(baseMessage)).toBe(true);
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

    expect(
      new GatewayAllowlist({
        platforms: ["qq"],
        userIds: ["112233"],
        groupIds: ["group-1"],
      }).allows(webMessage),
    ).toBe(true);
  });
});
