import { describe, expect, it } from "vitest";

import { GatewayAllowlist } from "./gateway-allowlist.js";

const baseMessage = {
  platform: "qq" as const,
  adapterId: "napcat.qq.main",
  selfId: "998877",
  traceId: "napcat:998877:message-1",
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

  it("applies the same dimensions to web platform messages", () => {
    const webMessage = {
      platform: "web" as const,
      adapterId: "web.ui.main",
      traceId: "web:request-1",
      platformMessageId: "request-1",
      occurredAt: "2026-08-16T00:00:00.000Z",
      text: "hello",
      mentions: [],
      target: { kind: "web" as const },
      sender: { userId: "web" },
      raw: {},
    };

    expect(new GatewayAllowlist().allows(webMessage)).toBe(true);
    expect(
      new GatewayAllowlist({ platforms: ["web"] }).allows(webMessage),
    ).toBe(true);
    expect(
      new GatewayAllowlist({ platforms: ["qq"] }).allows(webMessage),
    ).toBe(false);
    expect(
      new GatewayAllowlist({ userIds: ["web"] }).allows(webMessage),
    ).toBe(true);
    expect(
      new GatewayAllowlist({ userIds: ["112233"] }).allows(webMessage),
    ).toBe(false);
    expect(
      new GatewayAllowlist({ groupIds: ["group-1"] }).allows(webMessage),
    ).toBe(false);
    expect(
      new GatewayAllowlist({
        platforms: ["web"],
        userIds: ["web"],
      }).allows(webMessage),
    ).toBe(true);
  });
});
