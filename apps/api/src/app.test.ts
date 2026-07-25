import { request as createHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import {
  OpenAiCompatibleError,
  type OpenAiCompatibleResult,
} from "@kaguya/llm";
import { describe, expect, it, vi } from "vitest";

import { createApiGateway, type ApiGatewayLlmService } from "./app.js";
import type { ApiGatewayConfig } from "./config.js";

const gatewayToken = "test-gateway-token-12345";
const config: ApiGatewayConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken,
  corsOrigins: ["http://localhost:5173"],
  llmAllowedHosts: new Set(["api.openai.com", "gateway.example"]),
  allowInsecureLlmHttp: false,
  llmRequestTimeoutMs: 300_000,
  trustProxy: false,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
};
const requestBody = {
  apiKey: "provider-secret",
  baseUrl: "https://gateway.example/v1",
  model: "model-a",
  systemPrompt: "You are helpful.",
  userPrompt: "Hello",
};
const result: OpenAiCompatibleResult = {
  content: "Hello back",
  model: "model-a",
  attempts: 1,
  durationMs: 12,
};

function authorization() {
  return { authorization: `Bearer ${gatewayToken}` };
}

describe("application API gateway", () => {
  it("exposes public health and OpenAPI endpoints", async () => {
    const app = await createApiGateway({ config, llmService: fakeService() });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const openapi = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({
      info: { title: "Kaguya Application API", version: "1.0.0" },
    });
    await app.close();
  });

  it("requires the gateway Bearer token", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      payload: requestBody,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("authenticates before parsing or validating the request body", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      payload: { unknown: true },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts the case-insensitive Bearer authentication scheme", async () => {
    const app = await createApiGateway({ config, llmService: fakeService() });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: { authorization: `bearer ${gatewayToken}` },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("forwards validated UI model configuration to the LLM service", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: { ...requestBody, temperature: 0.5, maxRetries: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: result });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        ...requestBody,
        temperature: 0.5,
        maxRetries: 1,
        signal: expect.any(AbortSignal),
      }),
    );
    await app.close();
  });

  it("rejects provider hosts outside the server allowlist", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: { ...requestBody, baseUrl: "https://internal.invalid/v1" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "provider_not_allowed" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects non-HTTP provider URLs before invoking the LLM service", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: { ...requestBody, baseUrl: "file://gateway.example/model" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "provider_url_rejected" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects insecure HTTP providers unless explicitly enabled", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: { ...requestBody, baseUrl: "http://gateway.example/v1" },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: { code: "provider_url_rejected" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows an allowlisted HTTP provider with the explicit opt-in", async () => {
    const app = await createApiGateway({
      config: { ...config, allowInsecureLlmHttp: true },
      llmService: fakeService(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: { ...requestBody, baseUrl: "http://gateway.example/v1" },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects embedded provider credentials and deceptive hostnames", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const embeddedCredentials = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: {
        ...requestBody,
        baseUrl: "https://user:password@gateway.example/v1",
      },
    });
    const deceptiveHostname = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: {
        ...requestBody,
        baseUrl: "https://gateway.example.attacker.invalid/v1",
      },
    });

    expect(embeddedCredentials.statusCode).toBe(400);
    expect(embeddedCredentials.json()).toMatchObject({
      error: { code: "provider_url_rejected" },
    });
    expect(deceptiveHostname.statusCode).toBe(403);
    expect(deceptiveHostname.json()).toMatchObject({
      error: { code: "provider_not_allowed" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unknown fields instead of forwarding them", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: { ...requestBody, additionalHeaders: { "x-secret": "value" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects API keys containing HTTP header control characters", async () => {
    const call = vi.fn(() => Promise.resolve(result));
    const app = await createApiGateway({ config, llmService: { call } });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: {
        ...requestBody,
        apiKey: "secret\r\nx-injected: yes",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(response.body).not.toContain("x-injected");
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps provider failures without exposing provider request bodies", async () => {
    const llmError = new OpenAiCompatibleError("provider unavailable", {
      kind: "retryable",
      attempts: 3,
      status: 503,
      cause: { apiKey: "must-not-leak" },
    });
    const app = await createApiGateway({
      config,
      llmService: { call: () => Promise.reject(llmError) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "llm_provider_error",
        message: "LLM provider is temporarily unavailable",
        kind: "retryable",
        attempts: 3,
        providerStatus: 503,
      },
    });
    expect(response.body).not.toContain("provider unavailable");
    expect(response.body).not.toContain("must-not-leak");
    await app.close();
  });

  it("cancels a provider call at the gateway request deadline", async () => {
    let receivedSignal: AbortSignal | undefined;
    const app = await createApiGateway({
      config: { ...config, llmRequestTimeoutMs: 20 },
      llmService: {
        call: (request) =>
          new Promise((_resolve, reject) => {
            receivedSignal = request.signal;
            request.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new OpenAiCompatibleError("LLM call cancelled", {
                    kind: "cancelled",
                    attempts: 1,
                  }),
                ),
              { once: true },
            );
          }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(408);
    expect(response.json()).toMatchObject({
      error: { code: "llm_provider_error", kind: "cancelled" },
    });
    expect(receivedSignal?.aborted).toBe(true);
    await app.close();
  });

  it("cancels the provider call when the HTTP client disconnects", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const app = await createApiGateway({
      config,
      llmService: {
        call: (request) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            const handleAbort = () => {
              aborted.resolve();
              reject(
                new OpenAiCompatibleError("LLM call cancelled", {
                  kind: "cancelled",
                  attempts: 1,
                }),
              );
            };
            if (request.signal?.aborted === true) {
              handleAbort();
            } else {
              request.signal?.addEventListener("abort", handleAbort, {
                once: true,
              });
            }
          }),
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const payload = JSON.stringify(requestBody);
    const client = createHttpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/v1/llm/chat",
      method: "POST",
      headers: {
        ...authorization(),
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    client.on("error", () => undefined);
    client.end(payload);
    await started.promise;

    client.destroy();

    await aborted.promise;
    await app.close();
  });

  it("rate limits authenticated API calls", async () => {
    const app = await createApiGateway({
      config: { ...config, rateLimitMax: 1 },
      llmService: fakeService(),
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: requestBody,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: requestBody,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it("does not let unauthorized requests consume the authenticated quota", async () => {
    const app = await createApiGateway({
      config: { ...config, rateLimitMax: 1 },
      llmService: fakeService(),
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      payload: requestBody,
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: requestBody,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    await app.close();
  });

  it("uses forwarded client IPs only from explicitly trusted proxies", async () => {
    const trustedApp = await createApiGateway({
      config: {
        ...config,
        rateLimitMax: 1,
        trustProxy: ["127.0.0.1"],
      },
      llmService: fakeService(),
    });
    const firstTrustedClient = await trustedApp.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: {
        ...authorization(),
        "x-forwarded-for": "198.51.100.1",
      },
      payload: requestBody,
    });
    const secondTrustedClient = await trustedApp.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: {
        ...authorization(),
        "x-forwarded-for": "198.51.100.2",
      },
      payload: requestBody,
    });

    expect(firstTrustedClient.statusCode).toBe(200);
    expect(secondTrustedClient.statusCode).toBe(200);
    await trustedApp.close();

    const untrustedApp = await createApiGateway({
      config: { ...config, rateLimitMax: 1 },
      llmService: fakeService(),
    });
    const spoofedFirstClient = await untrustedApp.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: {
        ...authorization(),
        "x-forwarded-for": "198.51.100.1",
      },
      payload: requestBody,
    });
    const spoofedSecondClient = await untrustedApp.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: {
        ...authorization(),
        "x-forwarded-for": "198.51.100.2",
      },
      payload: requestBody,
    });

    expect(spoofedFirstClient.statusCode).toBe(200);
    expect(spoofedSecondClient.statusCode).toBe(429);
    await untrustedApp.close();
  });
});

function fakeService(): ApiGatewayLlmService {
  return { call: () => Promise.resolve(result) };
}
