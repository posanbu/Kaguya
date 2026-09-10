/**
 * 功能概述：本文件验证服务层配置管理门面 `createConfigurationManagement`
 * 如何在 `apps/server` 内把底层 Profile Registry 包装成进程级 readiness 状态源，
 * 并把“磁盘上的 selected Profile readiness”与“当前进程是否需要重启”这两个概念分离。
 * 主要职责：覆盖首次打开缺失仓库时的显式 bootstrap、`inspect` 对 selected Profile
 * readiness 的公开投影、`createProfile`/`replaceProfile`/`selectProfile`/`deleteProfile`
 * 四个独立操作的返回值，以及仅在当前进程修改到 selected Profile 时才置位的
 * `restartRequired` 行为；辅助函数 `readyProfileReplacement`/`readyProfileSettings`
 * 生成可执行 Profile 夹具，避免测试重复拼装 provider tier 数据。
 * 代码库关系：该文件直接驱动 `apps/server/src/configuration-management.ts`，并通过真实
 * `@kaguya/config` FileUserConfigManager 观察 Registry v1 的持久化结果；
 * 它为后续 HTTP Profile 路由和 `server.ts` 启动流程提供门面契约，确保服务层不会退回
 * 旧的一次性 `initialize()` 聚合写入模型。
 * 输入输出与副作用：每个用例都在临时目录上创建或打开配置根目录，测试结束后删除；
 * 用例既验证进程内 `restart_required` 临时状态，也验证重新打开管理门面后只读取磁盘
 * readiness，不保留旧进程的重启标记。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { FileUserConfigManager } from "@kaguya/config";

import {
  createConfigurationManagement,
  type ConfigurationRegistryStatus,
} from "./configuration-management.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe("configuration management", () => {
  it("bootstraps a missing registry and keeps new profiles unselected", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-"));
    try {
      const management = await createConfigurationManagement(root);

      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
      } satisfies Partial<ConfigurationRegistryStatus>);

      const created = await management.createProfile("work");

      expect(created.profile.id).toMatch(UUID_PATTERN);
      expect(created.profile.name).toBe("work");
      expect(created.restartRequired).toBe(false);
      await expect(management.getRegistryStatus()).resolves.toEqual(
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
        gatewayAllowlist: [],
        ai: { providers: [] },
      });
      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
      } satisfies Partial<ConfigurationRegistryStatus>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only requires restart after a ready profile becomes selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-select-"));
    try {
      const management = await createRuntimeBackedManagement(root);
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
      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
      } satisfies Partial<ConfigurationRegistryStatus>);

      const selected = await management.selectProfile(created.profile.id);

      expect(selected.profile.id).toBe(created.profile.id);
      expect(selected.restartRequired).toBe(true);
      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        status: "restart_required",
        selectedProfileId: created.profile.id,
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: "default", name: "default" }),
          expect.objectContaining({ id: created.profile.id, name: "work" }),
        ]),
      } satisfies Partial<ConfigurationRegistryStatus>);
      await expect(
        (await createConfigurationManagement(root)).getRegistryStatus(),
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
      const management = await createRuntimeBackedManagement(root);
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
        gatewayAllowlist: [],
        acknowledgedWarnings: [],
        ai: { providers: [] },
        memory: { enabled: false },
        platforms: [],
      });

      expect(replaced.restartRequired).toBe(true);
      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: created.profile.id,
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: created.profile.id, name: "work" }),
        ]),
      } satisfies Partial<ConfigurationRegistryStatus>);
      await expect(
        (await createConfigurationManagement(root)).getRegistryStatus(),
      ).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: created.profile.id,
      } satisfies Partial<ConfigurationRegistryStatus>);
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
      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
      });
      await expect(management.getRegistryStatus()).resolves.toMatchObject({
        status: "invalid",
        selectedProfileId: "default",
      } satisfies Partial<ConfigurationRegistryStatus>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits runtime for new profiles and preserves it across Web replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-runtime-"));
    try {
      const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
      const original = await manager.getProfile(manager.getSelectedProfileId());
      await manager.replaceProfile(original.id, {
        name: original.name,
        acknowledgedWarnings: [],
        ai: original.ai,
        memory: original.memory,
        platforms: original.platforms,
        runtime: runtimeFixture,
      });
      const management = await createConfigurationManagement(root);

      await expect(
        management.getRuntimeProfile(original.id),
      ).resolves.toMatchObject({ runtime: runtimeFixture });

      const created = await management.createProfile("inherits-runtime");
      expect(created.profile.gatewayAllowlist).toEqual([]);
      expect(created.profile).not.toHaveProperty("runtime");

      await management.replaceProfile(original.id, {
        name: "default-edited",
        gatewayAllowlist: ["qq:group:778899"],
        acknowledgedWarnings: [],
        ai: original.ai,
        memory: original.memory,
        platforms: original.platforms,
      });
      await expect(management.getProfile(original.id)).resolves.toMatchObject({
        gatewayAllowlist: ["qq:group:778899"],
      });
      const reopened = await FileUserConfigManager.open({ rootDir: root });
      await expect(reopened.getProfile(original.id)).resolves.toMatchObject({
        runtime: {
          ...runtimeFixture,
          gatewayAllowlist: ["qq:group:778899"],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a persisted gateway token without modifying the profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-configuration-strict-"));
    try {
      const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
      const original = await manager.getProfile(manager.getSelectedProfileId());
      await manager.replaceProfile(original.id, {
        name: original.name,
        acknowledgedWarnings: [],
        ai: original.ai,
        memory: original.memory,
        platforms: original.platforms,
        runtime: runtimeFixture,
      });
      const profilePath = join(root, "profiles", "profile_default.json");
      const persisted = JSON.parse(
        await readFile(profilePath, "utf8"),
      ) as Record<string, unknown>;
      persisted.runtime = {
        ...(persisted.runtime as Record<string, unknown>),
        gatewayToken: "legacy-persisted-gateway-token",
      };
      const beforeOpen = `${JSON.stringify(persisted, null, 2)}\n`;
      await writeFile(profilePath, beforeOpen);

      await expect(createConfigurationManagement(root)).rejects.toMatchObject({
        code: "CONFIG_CORRUPT_STORE",
      });
      await expect(readFile(profilePath, "utf8")).resolves.toBe(beforeOpen);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects allowlist replacement when the target profile has no runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-no-runtime-"));
    try {
      const management = await createConfigurationManagement(root);

      await expect(
        management.replaceProfile(
          "default",
          readyProfileReplacement("default", "light-model", "heavy-model"),
        ),
      ).rejects.toMatchObject({
        code: "CONFIG_INCOMPLETE",
        message: "Profile runtime is required to edit the gateway allowlist",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads and writes NapCat through the selected Profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-setup-napcat-"));
    try {
      const management = await createConfigurationManagement(root);
      const settings = {
        enabled: true,
        wsUrl: "ws://127.0.0.1:3001",
        accessToken: "napcat-secret",
        selfId: "123456",
        reconnectMs: 5000,
      };

      await expect(management.saveNapCatSettings?.(settings)).resolves.toEqual(
        settings,
      );
      await expect(management.getNapCatSettings?.()).resolves.toEqual(settings);
      const selected = await management.getProfile("default");
      expect(selected.platforms).toContainEqual(
        expect.objectContaining({
          id: "napcat.qq.main",
          type: "napcat",
          enabled: true,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores napcat.json and reads only the selected Profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-configuration-napcat-"));
    try {
      await writeFile(
        join(root, "napcat.json"),
        JSON.stringify({ enabled: true, accessToken: "legacy-secret" }),
      );

      const management = await createConfigurationManagement(root);
      await expect(management.getNapCatSettings?.()).resolves.toEqual({
        enabled: false,
        reconnectMs: 3000,
      });
      await expect(
        readFile(join(root, "napcat.json"), "utf8"),
      ).resolves.toContain("legacy-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const runtimeFixture = {
  host: "127.0.0.1",
  port: 3000,
  databaseMode: "external" as const,
  databaseUrl: "postgresql://profile:secret@database.example/kaguya",
  webDistPath: "apps/web/dist",
  corsOrigins: [],
  trustProxy: false as const,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  logLevel: "info" as const,
  logFormat: "json" as const,
  gatewayAllowlist: [],
};

function readyProfileReplacement(
  name: string,
  lightModelId: string,
  heavyModelId: string,
) {
  return {
    name,
    gatewayAllowlist: ["*:group:*", "*:private:*"],
    acknowledgedWarnings: [],
    ...readyProfileSettings(lightModelId, heavyModelId),
  };
}

async function createRuntimeBackedManagement(root: string) {
  const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
  const profile = await manager.getProfile(manager.getSelectedProfileId());
  await manager.replaceProfile(profile.id, {
    name: profile.name,
    acknowledgedWarnings: [],
    ai: profile.ai,
    memory: profile.memory,
    platforms: profile.platforms,
    runtime: runtimeFixture,
  });
  return createConfigurationManagement(root);
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
    memory: { enabled: false },
    platforms: [],
  };
}
