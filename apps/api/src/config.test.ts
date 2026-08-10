import { describe, expect, it } from "vitest";

import { readApiGatewayConfig } from "./config.js";

describe("readApiGatewayConfig", () => {
  it("parses environment configuration and deduplicates lists", () => {
    const config = readApiGatewayConfig({
      KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
      KAGUYA_API_PORT: "4100",
      KAGUYA_CORS_ORIGINS: "https://ui.example, https://ui.example",
      KAGUYA_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8",
      KAGUYA_RATE_LIMIT_MAX: "20",
      KAGUYA_RATE_LIMIT_WINDOW_MS: "10000",
      KAGUYA_API_DATABASE_PATH: "/tmp/kaguya-test.sqlite",
    });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4100,
      gatewayToken: "a-secure-gateway-token",
      corsOrigins: ["https://ui.example"],
      trustProxy: ["127.0.0.1", "10.0.0.0/8"],
      rateLimitMax: 20,
      rateLimitWindowMs: 10_000,
      databasePath: "/tmp/kaguya-test.sqlite",
    });
  });

  it("defaults the local ingress database path under the repository data directory", () => {
    const config = readApiGatewayConfig({
      KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
    });

    expect(config.databasePath).toMatch(
      /[/\\]\.data[/\\]kaguya-api\.sqlite$/u,
    );
  });

  it("requires a non-trivial gateway token", () => {
    expect(() => readApiGatewayConfig({})).toThrow(
      "KAGUYA_GATEWAY_TOKEN is required",
    );
    expect(() =>
      readApiGatewayConfig({ KAGUYA_GATEWAY_TOKEN: "short" }),
    ).toThrow("at least 16 characters");
  });

  it("rejects out-of-range integer configuration", () => {
    expect(() =>
      readApiGatewayConfig({
        KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
        KAGUYA_RATE_LIMIT_MAX: "0",
      }),
    ).toThrow("KAGUYA_RATE_LIMIT_MAX must be an integer between 1 and 10000");
  });
});
