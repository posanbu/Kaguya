import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  StartupConfigurationError,
  validateStartupConfiguration,
} from "./startup-validation.js";
import { FileUserConfigManager } from "./manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("startup configuration validation", () => {
  it("reports missing runtime and external platform configuration", async () => {
    const root = await createRoot();

    await expect(
      validateStartupConfiguration({ rootDir: root }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "RUNTIME_INVALID", path: "runtime" }),
        expect.objectContaining({
          code: "PLATFORM_REQUIRED",
          path: "platforms",
        }),
      ]),
    } satisfies Partial<StartupConfigurationError>);
  });

  it("accepts a complete profile and validates NapCat settings", async () => {
    const root = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir: root });
    await manager.replaceProfile(
      manager.getSelectedProfileId(),
      completeReplacement(),
    );

    const result = await validateStartupConfiguration({ rootDir: root });

    expect(result.runtime.port).toBe(7897);
    expect(result.profile.platforms[0]?.type).toBe("napcat");
  });

  it("never includes credentials in validation issues", async () => {
    const root = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir: root });
    await manager.replaceProfile(manager.getSelectedProfileId(), {
      ...completeReplacement(),
      platforms: [
        {
          id: "napcat.qq.main",
          type: "napcat",
          enabled: true,
          credentials: { accessToken: "secret-token-value" },
          settings: { adapterId: "napcat.qq.main", wsUrl: "http://bad" },
        },
      ],
    });

    const error = await validateStartupConfiguration({ rootDir: root }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(StartupConfigurationError);
    expect(JSON.stringify(error)).not.toContain("secret-token-value");
  });

  it("surfaces safe persisted Profile schema diagnostics", async () => {
    const root = await createRoot();
    const path = join(root, "profiles", "profile_default.json");
    const profile = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    profile.runtime = {
      ...completeReplacement().runtime,
      databaseUrl: "postgresql://user:persisted-secret@127.0.0.1:5432/kaguya",
      gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
    };
    await writeFile(path, JSON.stringify(profile), "utf8");

    const error = await validateStartupConfiguration({ rootDir: root }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({
      issues: [
        expect.objectContaining({
          code: "invalid_type",
          path: "runtime.gatewayAllowlist",
        }),
      ],
    });
    expect(JSON.stringify(error)).not.toContain("persisted-secret");
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-startup-validation-"));
  roots.push(root);
  await FileUserConfigManager.bootstrap({ rootDir: root });
  return root;
}

function completeReplacement() {
  return {
    name: "default",
    acknowledgedWarnings: [],
    identity: { name: "Kaguya", aliases: ["辉夜"], persona: "test" },
    runtime: {
      host: "127.0.0.1",
      port: 7897,
      databaseMode: "external" as const,
      databaseUrl: "postgresql://kaguya:password@127.0.0.1:5432/kaguya",
      webDistPath: "apps/web/dist",
      corsOrigins: [],
      trustProxy: false as const,
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      logLevel: "info" as const,
      logFormat: "json" as const,
      gatewayAllowlist: [],
    },
    ai: {
      defaultProviderId: "provider-1",
      modelTiers: {
        light: { providerId: "provider-1", modelId: "light" },
        heavy: { providerId: "provider-1", modelId: "heavy" },
      },
      providers: [
        {
          id: "provider-1",
          type: "openai-compatible",
          enabled: true,
          baseUrl: "https://llm.example/v1",
          apiKey: "test-only-placeholder",
          models: ["light", "heavy"],
          settings: {},
        },
      ],
    },
    memory: { enabled: false },
    platforms: [
      {
        id: "napcat.qq.main",
        type: "napcat",
        enabled: true,
        credentials: { accessToken: "test-only-placeholder" },
        settings: {
          adapterId: "napcat.qq.main",
          wsUrl: "ws://127.0.0.1:3001",
          reconnectMs: 3000,
        },
      },
    ],
  };
}
