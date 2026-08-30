/**
 * 功能概述：本文件验证服务层配置管理门面 `createConfigurationManagement`
 * 如何在 `apps/server` 内把底层 Profile Registry 包装成进程级 setup 状态源，
 * 并把“磁盘上的 selected Profile readiness”与“当前进程是否需要重启”这两个概念分离。
 * 主要职责：覆盖首次打开缺失仓库时的显式 bootstrap、`inspect` 对 selected Profile
 * readiness 的公开投影、`createProfile`/`replaceProfile`/`selectProfile`/`deleteProfile`
 * 四个独立操作的返回值，以及仅在当前进程修改到 selected Profile 时才置位的
 * `restartRequired` 行为；辅助函数 `readyProfileReplacement`/`readyProfileSettings`
 * 生成可执行 Profile 夹具，避免测试重复拼装 provider tier 数据。
 * 代码库关系：该文件直接驱动 `apps/server/src/setup.ts`，并通过真实
 * `@kaguya/config` FileUserConfigManager 观察 Registry v3 的持久化结果；
 * 它为后续 HTTP Profile 路由和 `server.ts` 启动流程提供门面契约，确保服务层不会退回
 * 旧的一次性 `initialize()` 聚合写入模型。
 * 输入输出与副作用：每个用例都在临时目录上创建或打开配置根目录，测试结束后删除；
 * 用例既验证进程内 `restart_required` 临时状态，也验证重新打开管理门面后只读取磁盘
 * readiness，不保留旧进程的重启标记。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createConfigurationManagement,
  type ConfigurationSetupStatus,
} from "./setup.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe("configuration management", () => {
  it("bootstraps a missing registry and keeps new profiles unselected", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-"));
    try {
      const management = await createConfigurationManagement(root);

      await expect(management.inspect()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
      } satisfies Partial<ConfigurationSetupStatus>);

      const created = await management.createProfile("work");

      expect(created.profile.id).toMatch(UUID_PATTERN);
      expect(created.profile.name).toBe("work");
      expect(created.restartRequired).toBe(false);
      await expect(management.listProfiles()).resolves.toEqual(
        expect.objectContaining({
          selectedProfileId: "default",
          profiles: expect.arrayContaining([
            expect.objectContaining({ id: "default", name: "default" }),
            expect.objectContaining({ id: created.profile.id, name: "work" }),
          ]),
        }),
      );
      await expect(
        management.getProfile(created.profile.id),
      ).resolves.toMatchObject({
        id: created.profile.id,
        name: "work",
        ai: { providers: [] },
      });
      await expect(management.inspect()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
      } satisfies Partial<ConfigurationSetupStatus>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only requires restart after a ready profile becomes selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-select-"));
    try {
      const management = await createConfigurationManagement(root);
      const created = await management.createProfile("work");

      const replaced = await management.replaceProfile(
        created.profile.id,
        readyProfileReplacement(
          created.profile.name,
          "work-light",
          "work-heavy",
        ),
      );

      expect(replaced.profile.id).toBe(created.profile.id);
      expect(replaced.restartRequired).toBe(false);
      await expect(management.inspect()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
      } satisfies Partial<ConfigurationSetupStatus>);

      const selected = await management.selectProfile(created.profile.id);

      expect(selected.profile.id).toBe(created.profile.id);
      expect(selected.restartRequired).toBe(true);
      await expect(management.inspect()).resolves.toEqual({
        status: "restart_required",
      });
      await expect(
        (await createConfigurationManagement(root)).inspect(),
      ).resolves.toEqual({
        status: "ready",
        selectedProfileId: created.profile.id,
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: "default", name: "default" }),
          expect.objectContaining({ id: created.profile.id, name: "work" }),
        ]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports selected invalid readiness even when a restart is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-replace-"));
    try {
      const management = await createConfigurationManagement(root);
      const created = await management.createProfile("work");
      await management.replaceProfile(
        created.profile.id,
        readyProfileReplacement(
          created.profile.name,
          "work-light",
          "work-heavy",
        ),
      );
      await management.selectProfile(created.profile.id);

      const replaced = await management.replaceProfile(created.profile.id, {
        name: created.profile.name,
        acknowledgedWarnings: [],
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      });

      expect(replaced.restartRequired).toBe(true);
      await expect(management.inspect()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: created.profile.id,
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: created.profile.id, name: "work" }),
        ]),
      } satisfies Partial<ConfigurationSetupStatus>);
      await expect(
        (await createConfigurationManagement(root)).inspect(),
      ).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: created.profile.id,
      } satisfies Partial<ConfigurationSetupStatus>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only unselected profiles without forcing a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-delete-"));
    try {
      const management = await createConfigurationManagement(root);
      const created = await management.createProfile("throwaway");

      const deleted = await management.deleteProfile(created.profile.id);

      expect(deleted.profile.id).toBe(created.profile.id);
      expect(deleted.restartRequired).toBe(false);
      await expect(management.listProfiles()).resolves.toEqual({
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
      });
      await expect(management.inspect()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
      } satisfies Partial<ConfigurationSetupStatus>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function readyProfileReplacement(
  name: string,
  lightModelId: string,
  heavyModelId: string,
) {
  return {
    name,
    acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
    ...readyProfileSettings(lightModelId, heavyModelId),
  };
}

function readyProfileSettings(lightModelId: string, heavyModelId: string) {
  return {
    ai: {
      defaultProviderId: "provider-1",
      modelTiers: {
        light: { providerId: "provider-1", modelId: lightModelId },
        heavy: { providerId: "provider-1", modelId: heavyModelId },
      },
      providers: [
        {
          id: "provider-1",
          type: "openai-compatible" as const,
          enabled: true,
          apiKey: "provider-key",
          baseUrl: "https://llm.example/v1",
          models: [lightModelId, heavyModelId],
          settings: {},
        },
      ],
    },
    platforms: [],
    plugins: [],
  };
}
