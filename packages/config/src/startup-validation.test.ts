import { mkdtemp, rm } from "node:fs/promises";
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
    runtime: {
      host: "127.0.0.1",
      port: 7897,
      gatewayToken: "startup-validation-token",
      databaseUrl: "postgresql://kaguya:password@127.0.0.1:5432/kaguya",
      webDistPath: "apps/web/dist",
      corsOrigins: [],
      trustProxy: false as const,
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      logLevel: "info" as const,
      logFormat: "json" as const,
      gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
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
    plugins: [],
  };
}
