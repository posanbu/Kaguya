/**
 * 功能概述：验证 NapCat selected Profile 配置的纯校验与脱敏投影。
 * 主要职责：覆盖 token 脱敏和非法参数拒绝。
 * 代码库关系：直接保护 `napcat-config.ts`；持久化职责已统一收口到 Profile manager。
 * 输入输出与副作用：全部断言发生在内存中。
 */
import { describe, expect, it } from "vitest";

import { toNapCatStatus, validateNapCatSettings } from "./napcat-config.js";

describe("NapCat Profile configuration", () => {
  it("validates settings without exposing the access token", () => {
    const saved = validateNapCatSettings({
      enabled: true,
      wsUrl: "ws://127.0.0.1:3001",
      accessToken: "napcat-secret",
      selfId: "123456",
      reconnectMs: 5000,
    });

    expect(saved).toEqual({
      enabled: true,
      wsUrl: "ws://127.0.0.1:3001",
      accessToken: "napcat-secret",
      selfId: "123456",
      reconnectMs: 5000,
    });
    expect(toNapCatStatus(saved)).toEqual({
      enabled: true,
      wsUrl: "ws://127.0.0.1:3001",
      hasAccessToken: true,
      selfId: "123456",
      reconnectMs: 5000,
    });
  });

  it("rejects an enabled configuration without a WebSocket URL", () => {
    expect(() =>
      validateNapCatSettings({
        enabled: true,
        wsUrl: "",
        accessToken: "",
        selfId: "",
        reconnectMs: 3000,
      }),
    ).toThrow("WebSocket URL is required");
  });
});
