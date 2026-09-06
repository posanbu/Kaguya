/**
 * 功能概述：验证 NapCat WebUI 配置在服务端的持久化边界，确保配置可安全落盘、读取时隐藏敏感令牌，并能转换为启动所需的 NapCatConfig。
 * 主要职责：覆盖默认配置、写入后读取、令牌脱敏和非法 WebSocket/重连参数拒绝。
 * 代码库关系：直接保护 `napcat-config.ts`，由 `setup.ts` 和 `server.ts` 在 HTTP 管理与服务启动之间复用；测试使用临时目录，不触碰真实 `.data`。
 * 输入输出与副作用：测试会在临时目录创建受保护配置文件，断言公开状态不返回 access token 原文。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultNapCatSettings,
  loadNapCatSettings,
  saveNapCatSettings,
  toNapCatStatus,
} from "./napcat-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("NapCat configuration persistence", () => {
  it("loads defaults and persists settings without exposing the access token", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-napcat-"));
    roots.push(root);

    expect(await loadNapCatSettings(root)).toEqual(defaultNapCatSettings);

    const saved = await saveNapCatSettings(root, {
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

  it("rejects an enabled configuration without a WebSocket URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-napcat-"));
    roots.push(root);

    await expect(
      saveNapCatSettings(root, {
        enabled: true,
        wsUrl: "",
        accessToken: "",
        selfId: "",
        reconnectMs: 3000,
      }),
    ).rejects.toThrow("WebSocket URL is required");
  });
});
