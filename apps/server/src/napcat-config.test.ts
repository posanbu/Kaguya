/**
 * 功能概述：验证 NapCat selected Profile 配置的纯校验与脱敏投影。
 * 主要职责：覆盖 token 脱敏、采集身份/群/队列约束及启动配置的独立传递。
 * 代码库关系：直接保护 `napcat-config.ts`；持久化职责已统一收口到 Profile manager。
 * 输入输出与副作用：全部断言发生在内存中。
 */
import { describe, expect, it } from "vitest";

import {
  toNapCatStatus,
  toNapCatConfig,
  validateNapCatSettings,
} from "./napcat-config.js";
import { inspectNapCatConfig } from "./config.js";

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

it("preserves independent capture settings across runtime and safe status projections", () => {
  const value = {
    enabled: true,
    wsUrl: "ws://127.0.0.1:3001",
    selfId: "100",
    reconnectMs: 3000,
    captureEnabled: true,
    captureGroups: ["200"],
    captureQueueLimit: 42,
  };
  const saved = validateNapCatSettings(value);
  expect(toNapCatConfig(saved)).toMatchObject(value);
  expect(toNapCatStatus(saved)).toMatchObject({
    captureEnabled: true,
    captureGroups: ["200"],
    captureQueueLimit: 42,
  });
  expect(
    inspectNapCatConfig([
      {
        version: 1,
        instanceId: "adapter.napcat.main",
        definitionId: "adapter.napcat",
        enabled: true,
        settings: { ...value },
      },
    ]),
  ).toMatchObject({ captureEnabled: true, captureGroups: ["200"] });
});

it.each([
  { captureEnabled: "true" },
  { captureEnabled: true },
  { captureEnabled: true, captureGroups: [] },
  { captureEnabled: true, captureGroups: ["200"], selfId: "" },
  { captureGroups: ["200", "200"] },
  { captureGroups: ["*"] },
  { captureQueueLimit: 0 },
  { captureQueueLimit: 10001 },
])("rejects invalid capture configuration: %j", (capture) => {
  expect(() =>
    validateNapCatSettings({
      enabled: true,
      wsUrl: "ws://localhost",
      reconnectMs: 3000,
      ...capture,
    }),
  ).toThrow();
});
