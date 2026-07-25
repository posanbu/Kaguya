import { describe, expect, it } from "vitest";

import { readApiGatewayConfig } from "./config.js";

describe("readApiGatewayConfig", () => {
  it("parses environment configuration and normalizes host lists", () => {
    const config = readApiGatewayConfig({
      KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
      KAGUYA_API_PORT: "4100",
      KAGUYA_CORS_ORIGINS: "https://ui.example, https://ui.example",
      KAGUYA_LLM_ALLOWED_HOSTS: "API.OPENAI.COM, gateway.example",
      KAGUYA_LLM_ALLOW_INSECURE_HTTP: "true",
      KAGUYA_LLM_REQUEST_TIMEOUT_MS: "120000",
      KAGUYA_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8",
      KAGUYA_RATE_LIMIT_MAX: "20",
      KAGUYA_RATE_LIMIT_WINDOW_MS: "10000",
    });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4100,
      gatewayToken: "a-secure-gateway-token",
      corsOrigins: ["https://ui.example"],
      allowInsecureLlmHttp: true,
      llmRequestTimeoutMs: 120_000,
      trustProxy: ["127.0.0.1", "10.0.0.0/8"],
      rateLimitMax: 20,
      rateLimitWindowMs: 10_000,
    });
    expect([...config.llmAllowedHosts]).toEqual([
      "api.openai.com",
      "gateway.example",
    ]);
  });

  it("requires a non-trivial gateway token", () => {
    expect(() => readApiGatewayConfig({})).toThrow(
      "KAGUYA_GATEWAY_TOKEN is required",
    );
    expect(() =>
      readApiGatewayConfig({ KAGUYA_GATEWAY_TOKEN: "short" }),
    ).toThrow("at least 16 characters");
  });

  it("rejects invalid boolean configuration", () => {
    expect(() =>
      readApiGatewayConfig({
        KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
        KAGUYA_LLM_ALLOW_INSECURE_HTTP: "yes",
      }),
    ).toThrow("KAGUYA_LLM_ALLOW_INSECURE_HTTP must be true or false");
  });
});
