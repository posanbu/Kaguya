import { describe, expect, it } from "vitest";

import type { UserConfigProfile } from "@kaguya/config";

import {
  assertLoopbackHost,
  createServerConfig,
  readServerBootstrapConfig,
} from "./config.js";

const databaseUrl = "postgresql://kaguya:secret@db.example:5432/kaguya";

describe("Profile-backed server configuration", () => {
  it("reads only bootstrap location/mode from the environment", () => {
    expect(
      readServerBootstrapConfig({
        NODE_ENV: "development",
        KAGUYA_CONFIG_ROOT: "/tmp/kaguya-config-test",
      }),
    ).toEqual({
      configRoot: "/tmp/kaguya-config-test",
      development: true,
    });
  });

  it("uses selected Profile runtime values and always generates a fresh token", () => {
    const profile = completeProfile();
    const first = createServerConfig(
      profile,
      { configRoot: "/tmp/config", development: true },
      () => "first-process-token-12345",
    );
    const second = createServerConfig(
      profile,
      { configRoot: "/tmp/config", development: true },
      () => "second-process-token-1234",
    );

    expect(first).toMatchObject({
      host: "localhost",
      port: 4100,
      databaseUrl,
      gatewayToken: "first-process-token-12345",
      logLevel: "debug",
      logFormat: "pretty",
      development: true,
      napcat: { enabled: false },
    });
    expect(second.gatewayToken).toBe("second-process-token-1234");
  });

  it("requires a complete Profile runtime without exposing its values", () => {
    const profile = { ...completeProfile(), runtime: undefined };
    expect(() =>
      createServerConfig(profile, {
        configRoot: "/tmp/config",
        development: false,
      }),
    ).toThrow("Selected Profile runtime configuration is invalid");
  });

  it("accepts only explicit loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(() => assertLoopbackHost(host)).not.toThrow();
    }
    for (const host of ["0.0.0.0", "192.168.1.2", "example.com"]) {
      expect(() => assertLoopbackHost(host)).toThrow("must be loopback");
    }
  });

  it("maps the selected Profile NapCat platform", () => {
    const profile = completeProfile({
      platforms: [
        {
          id: "napcat.qq.primary",
          type: "napcat",
          enabled: true,
          credentials: { accessToken: "secret-token" },
          settings: {
            adapterId: "napcat.qq.primary",
            wsUrl: "ws://127.0.0.1:3001",
            selfId: "10001",
            reconnectMs: 500,
          },
        },
      ],
    });
    expect(
      createServerConfig(profile, {
        configRoot: "/tmp/config",
        development: false,
      }).napcat,
    ).toEqual({
      enabled: true,
      adapterId: "napcat.qq.primary",
      wsUrl: "ws://127.0.0.1:3001",
      accessToken: "secret-token",
      selfId: "10001",
      reconnectMs: 500,
    });
  });

  it.each([
    {},
    { adapterId: "qq", wsUrl: "https://secret", reconnectMs: 3000 },
    { adapterId: "web.ui.main", wsUrl: "ws://localhost", reconnectMs: 3000 },
  ])("isolates invalid NapCat configuration", (settings) => {
    const profile = completeProfile({
      platforms: [
        {
          id: "qq",
          type: "napcat",
          enabled: true,
          settings,
          credentials: { accessToken: "secret" },
        },
      ],
    });
    const result = createServerConfig(profile, {
      configRoot: "/tmp/config",
      development: false,
    });
    expect(result.napcat).toMatchObject({
      enabled: true,
      configurationError: "configuration_invalid",
    });
    expect(result.host).toBe("localhost");
    expect(JSON.stringify(result.napcat)).not.toContain("secret");
  });

  it("rejects retired runtime variables without exposing values", () => {
    for (const name of [
      "KAGUYA_DATABASE_URL",
      "KAGUYA_HOST",
      "KAGUYA_NAPCAT_ACCESS_TOKEN",
      "KAGUYA_LOG_DESTINATION",
      "KAGUYA_LLM_API_KEY",
    ]) {
      const error = (() => {
        try {
          readServerBootstrapConfig({ [name]: "private-value" });
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(String(error)).toContain(name);
      expect(String(error)).not.toContain("private-value");
    }
  });
});

function completeProfile(
  overrides: Partial<UserConfigProfile> = {},
): UserConfigProfile {
  return {
    version: 1,
    id: "default",
    name: "default",
    ai: { providers: [] },
    memory: { enabled: false },
    platforms: [],
    plugins: [],
    runtime: {
      host: "localhost",
      port: 4100,
      databaseMode: "external",
      databaseUrl,
      webDistPath: "apps/web/dist",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 20,
      rateLimitWindowMs: 10_000,
      logLevel: "debug",
      logFormat: "pretty",
      gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
    },
    ...overrides,
  };
}
