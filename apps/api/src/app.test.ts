import { describe, expect, it, vi } from "vitest";

import { createApiGateway, type MessageIngress } from "./app.js";
import type { ApiGatewayConfig } from "./config.js";

const gatewayToken = "test-gateway-token-12345";
const config: ApiGatewayConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken,
  corsOrigins: ["http://localhost:5173"],
  trustProxy: false,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
};
const requestBody = { sessionId: "session-1", text: "Hello" };

function authorization(scheme = "Bearer") {
  return { authorization: `${scheme} ${gatewayToken}` };
}

describe("application API gateway", () => {
  it("exposes health, OpenAPI, and only the core message ingress contract", async () => {
    const app = await createApiGateway({
      config,
      messageIngress: fakeIngress(),
    });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const openapi = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });
    const document = openapi.json();

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(openapi.statusCode).toBe(200);
    expect(document).toMatchObject({
      info: { title: "Kaguya Application API", version: "1.0.0" },
      paths: {
        "/api/v1/messages": {
          post: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    required: ["sessionId", "text"],
                    properties: {
                      sessionId: { type: "string" },
                      text: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "202": {
                content: {
                  "application/json": {
                    schema: {
                      properties: {
                        data: {
                          properties: {
                            status: { enum: ["accepted"] },
                            requestId: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "503": {
                content: {
                  "application/json": {
                    schema: {
                      properties: {
                        error: {
                          required: ["code", "message", "requestId"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("/api/v1/llm/chat");
    expect(serialized).not.toContain('"apiKey"');
    expect(serialized).not.toContain('"baseUrl"');
    expect(serialized).not.toContain('"model"');
    expect(serialized).not.toContain('"provider"');
    expect(serialized).not.toContain('"workflowId"');
    expect(serialized).not.toContain('"systemPrompt"');
    expect(serialized).not.toContain('"userPrompt"');
    await app.close();
  });

  it("does not expose the removed model route", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: authorization(),
      payload: {
        apiKey: "provider-secret",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        systemPrompt: "You are helpful.",
        userPrompt: "Hello",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("authenticates before parsing or validating a message", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: { model: "must-not-be-routed" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates and enqueues a message without model configuration", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        ...authorization("bearer"),
        "x-request-id": "request-123",
      },
      payload: { sessionId: " session-1 ", text: " Hello " },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { status: "accepted", requestId: "request-123" },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      sessionId: "session-1",
      text: " Hello ",
      requestId: "request-123",
    });
    await app.close();
  });

  it("rejects model, provider, prompt, and workflow routing fields", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    for (const field of [
      "apiKey",
      "baseUrl",
      "model",
      "provider",
      "workflowId",
      "systemPrompt",
      "userPrompt",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers: authorization(),
        payload: { ...requestBody, [field]: "must-not-be-routed" },
      });

      expect(response.statusCode, field).toBe(400);
      expect(response.json(), field).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects blank messages", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: { sessionId: "session-1", text: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports an unavailable core handoff when it is not wired", async () => {
    const app = await createApiGateway({ config });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "core_unavailable",
        message: "Core message ingress is not configured",
      },
    });
    await app.close();
  });

  it("does not expose dispatcher failures", async () => {
    const app = await createApiGateway({
      config,
      messageIngress: {
        enqueue: () => Promise.reject(new Error("internal queue details")),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(response.body).not.toContain("internal queue details");
    await app.close();
  });

  it("separates authenticated and unauthenticated rate-limit quotas", async () => {
    const app = await createApiGateway({
      config: { ...config, rateLimitMax: 1 },
      messageIngress: fakeIngress(),
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      payload: requestBody,
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: requestBody,
    });
    const rateLimited = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: requestBody,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    expect(rateLimited.statusCode).toBe(429);
    await app.close();
  });

  it("uses forwarded client IPs only from explicitly trusted proxies", async () => {
    const trustedApp = await createApiGateway({
      config: {
        ...config,
        rateLimitMax: 1,
        trustProxy: ["127.0.0.1"],
      },
      messageIngress: fakeIngress(),
    });
    const firstTrustedClient = await injectFrom(trustedApp, "198.51.100.1");
    const secondTrustedClient = await injectFrom(trustedApp, "198.51.100.2");

    expect(firstTrustedClient.statusCode).toBe(202);
    expect(secondTrustedClient.statusCode).toBe(202);
    await trustedApp.close();

    const untrustedApp = await createApiGateway({
      config: { ...config, rateLimitMax: 1 },
      messageIngress: fakeIngress(),
    });
    const spoofedFirstClient = await injectFrom(untrustedApp, "198.51.100.1");
    const spoofedSecondClient = await injectFrom(untrustedApp, "198.51.100.2");

    expect(spoofedFirstClient.statusCode).toBe(202);
    expect(spoofedSecondClient.statusCode).toBe(429);
    await untrustedApp.close();
  });
});

function fakeIngress(): MessageIngress {
  return { enqueue: () => Promise.resolve() };
}

function injectFrom(
  app: Awaited<ReturnType<typeof createApiGateway>>,
  forwardedFor: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/messages",
    headers: {
      ...authorization(),
      "x-forwarded-for": forwardedFor,
    },
    payload: requestBody,
  });
}
