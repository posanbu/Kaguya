/**
 * 功能概述：验证 NapCat selected Profile 配置的纯校验、脱敏投影与遗留文件门禁。
 * 主要职责：覆盖 token 脱敏、非法参数拒绝和 `napcat.json` 的稳定迁移错误。
 * 代码库关系：直接保护 `napcat-config.ts`；持久化职责已统一收口到 Profile manager。
 * 输入输出与副作用：仅遗留门禁用例在临时目录创建占位文件，不读取其内容。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoLegacyNapCatSettings,
  toNapCatStatus,
  validateNapCatSettings,
} from "./napcat-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

  it("rejects the retired napcat.json without reading its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-napcat-"));
    roots.push(root);
    await writeFile(join(root, "napcat.json"), "napcat-super-secret");

    await expect(assertNoLegacyNapCatSettings(root)).rejects.toThrow(
      "Legacy napcat.json is not supported",
    );
    await expect(
      assertNoLegacyNapCatSettings(`${root}-missing`),
    ).resolves.toBeUndefined();
  });
});
