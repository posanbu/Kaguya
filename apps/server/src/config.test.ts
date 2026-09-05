import { describe, expect, it } from "vitest";

import { assertLoopbackHost, readServerConfig } from "./config.js";

const databaseUrl = "postgresql://kaguya:secret@db.example:5432/kaguya";

describe("readServerConfig", () => {
  it("parses server settings and always generates a fresh token", () => {
    const environment = {
      NODE_ENV: "development",
      KAGUYA_DATABASE_URL: databaseUrl,
      KAGUYA_GATEWAY_TOKEN: "ignored-environment-token",
      KAGUYA_HOST: "localhost",
      KAGUYA_PORT: "4100",
      KAGUYA_CORS_ORIGINS: "https://ui.example, https://ui.example",
      KAGUYA_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8",
      KAGUYA_RATE_LIMIT_MAX: "20",
      KAGUYA_RATE_LIMIT_WINDOW_MS: "10000",
      KAGUYA_CONFIG_ROOT: "/tmp/kaguya-config-test",
      KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS: "qq, qq",
      KAGUYA_GATEWAY_ALLOWLIST_USER_IDS: "user-1, user-2",
    };
    const first = readServerConfig(environment);
    const second = readServerConfig(environment);

    expect(first).toMatchObject({
      host: "localhost",
      port: 4100,
      corsOrigins: ["https://ui.example"],
      trustProxy: ["127.0.0.1", "10.0.0.0/8"],
      rateLimitMax: 20,
      rateLimitWindowMs: 10_000,
      databaseUrl,
      development: true,
      gatewayAllowlist: { platforms: ["qq"], userIds: ["user-1", "user-2"] },
    });
    expect(first.gatewayToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    expect(first.gatewayToken).not.toBe(environment.KAGUYA_GATEWAY_TOKEN);
    expect(second.gatewayToken).not.toBe(first.gatewayToken);
  });

  it("requires the PostgreSQL URL", () => {
    expect(() => readServerConfig({})).toThrow(
      "KAGUYA_DATABASE_URL is required",
    );
  });

  it("accepts only explicit loopback hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(() => assertLoopbackHost(host)).not.toThrow();
    }
    for (const host of ["0.0.0.0", "192.168.1.2", "example.com"]) {
      expect(() =>
        readServerConfig({
          KAGUYA_DATABASE_URL: databaseUrl,
          KAGUYA_HOST: host,
        }),
      ).toThrow("KAGUYA_HOST must be 127.0.0.1, localhost, or ::1");
    }
  });

  it("requires a URL when NapCat is enabled", () => {
    expect(() =>
      readServerConfig({
        KAGUYA_DATABASE_URL: databaseUrl,
        KAGUYA_NAPCAT_ENABLED: "true",
      }),
    ).toThrow("KAGUYA_NAPCAT_WS_URL is required");
  });

  it("rejects legacy split-service variables without exposing values", () => {
    for (const name of ["KAGUYA_API_HOST", "KAGUYA_LLM_API_KEY"]) {
      expect(() =>
        readServerConfig({
          KAGUYA_DATABASE_URL: databaseUrl,
          [name]: "secret",
        }),
      ).toThrow("no longer supported");
    }
  });
});
