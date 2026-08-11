import { describe, expect, it } from "vitest";

import { readServerConfig } from "./config.js";

describe("readServerConfig", () => {
  it("parses unified server and NapCat configuration", () => {
    const config = readServerConfig({
      NODE_ENV: "development",
      KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
      KAGUYA_HOST: "0.0.0.0",
      KAGUYA_PORT: "4100",
      KAGUYA_CORS_ORIGINS: "https://ui.example, https://ui.example",
      KAGUYA_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8",
      KAGUYA_RATE_LIMIT_MAX: "20",
      KAGUYA_RATE_LIMIT_WINDOW_MS: "10000",
      KAGUYA_DATABASE_PATH: "/tmp/kaguya-test.sqlite",
      KAGUYA_NAPCAT_ENABLED: "true",
      KAGUYA_NAPCAT_WS_URL: "ws://127.0.0.1:3001",
      KAGUYA_NAPCAT_RECONNECT_MS: "500",
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 4100,
      gatewayToken: "a-secure-gateway-token",
      corsOrigins: ["https://ui.example"],
      trustProxy: ["127.0.0.1", "10.0.0.0/8"],
      rateLimitMax: 20,
      rateLimitWindowMs: 10_000,
      databasePath: "/tmp/kaguya-test.sqlite",
      development: true,
      napcat: {
        enabled: true,
        adapterId: "napcat.qq.main",
        wsUrl: "ws://127.0.0.1:3001",
        reconnectMs: 500,
      },
    });
  });

  it("uses the single repository database default", () => {
    const config = readServerConfig({
      KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
    });

    expect(config.databasePath).toMatch(/[/\\]\.data[/\\]kaguya\.sqlite$/u);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      development: false,
      napcat: { enabled: false, reconnectMs: 3000 },
    });
  });

  it("rejects legacy split-service variables", () => {
    for (const name of [
      "KAGUYA_API_HOST",
      "KAGUYA_API_PORT",
      "KAGUYA_API_DATABASE_PATH",
      "KAGUYA_BOT_DATABASE_PATH",
    ]) {
      expect(() =>
        readServerConfig({
          KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
          [name]: "legacy-value",
        }),
      ).toThrow("no longer supported");
    }
  });

  it("requires a non-trivial token and a URL for enabled NapCat", () => {
    expect(() => readServerConfig({})).toThrow(
      "KAGUYA_GATEWAY_TOKEN is required",
    );
    expect(() => readServerConfig({ KAGUYA_GATEWAY_TOKEN: "short" })).toThrow(
      "at least 16 characters",
    );
    expect(() =>
      readServerConfig({
        KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
        KAGUYA_NAPCAT_ENABLED: "true",
      }),
    ).toThrow("KAGUYA_NAPCAT_WS_URL is required");
  });
});
