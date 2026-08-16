import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  closeLogger,
  createLogger,
  createModuleLogger,
  getLogContext,
  type LogContext,
} from "@kaguya/logger";
import { configurationSetupGuidance } from "@kaguya/config";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import type { ConfigurationSetup } from "./setup.js";

const gatewayToken = "test-gateway-token-12345";
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken,
  corsOrigins: ["http://localhost:5173"],
  trustProxy: false,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  databasePath: "/tmp/kaguya-api-test.sqlite",
  configRoot: "/tmp/kaguya-config-test",
  development: false,
  webDistPath: "/tmp/kaguya-web-test",
  gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
  napcat: {
    enabled: false,
    adapterId: "napcat.qq.main",
    reconnectMs: 3000,
  },
};
const requestBody = { sessionId: "session-1", text: "Hello" };

function authorization(scheme = "Bearer") {
  return { authorization: `${scheme} ${gatewayToken}` };
}

describe("application API gateway", () => {
  it("serves first-run setup status and accepts initial configuration", async () => {
    const setup: ConfigurationSetup = {
      inspect: vi.fn(async () => ({
        status: "setup_required" as const,
        guidance: configurationSetupGuidance,
      })),
      initialize: vi.fn(async () => undefined),
    };
    const app = await createHttpApplication({ config, setup });

    const status = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      data: { status: "setup_required", guidance: configurationSetupGuidance },
    });

    const configured = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: authorization(),
      payload: {
        profileName: "default",
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        lightModel: "small-model",
        heavyModel: "large-model",
        acknowledgeOptional: true,
      },
    });
    expect(configured.statusCode).toBe(201);
    expect(configured.json()).toEqual({
      data: { status: "configured", restartRequired: true },
    });
    expect(setup.initialize).toHaveBeenCalledWith({
      profileName: "default",
      baseUrl: "https://api.example/v1",
      apiKey: "provider-secret",
      lightModel: "small-model",
      heavyModel: "large-model",
      acknowledgeOptional: true,
    });

    const message = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: requestBody,
    });
    expect(message.statusCode).toBe(503);
    expect(message.json()).toMatchObject({
      error: { code: "configuration_setup_required" },
    });
    await app.close();
  });

  it("rejects identical light and heavy models", async () => {
    const setup: ConfigurationSetup = {
      inspect: vi.fn(async () => ({
        status: "setup_required" as const,
        guidance: configurationSetupGuidance,
      })),
      initialize: vi.fn(async () => undefined),
    };
    const app = await createHttpApplication({ config, setup });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: authorization(),
      payload: {
        profileName: "default",
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        lightModel: "same-model",
        heavyModel: "same-model",
        acknowledgeOptional: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(setup.initialize).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not allow setup to overwrite a ready configuration", async () => {
    const setup: ConfigurationSetup = {
      inspect: vi.fn(async () => ({ status: "ready" as const })),
      initialize: vi.fn(async () => undefined),
    };
    const app = await createHttpApplication({ config, setup });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: authorization(),
      payload: {
        profileName: "replacement",
        baseUrl: "https://api.example/v1",
        apiKey: "replacement-secret",
        lightModel: "replacement-light",
        heavyModel: "replacement-heavy",
        acknowledgeOptional: true,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "configuration_not_required" },
    });
    expect(setup.initialize).not.toHaveBeenCalled();
    await app.close();
  });

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
              "413": {
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
              "415": {
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
    expect(response.json()).toMatchObject({
      error: { code: "not_found", message: "Route not found" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses bounded client request IDs and replaces unsafe values", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });
    const unsafeRequestId = "x".repeat(10_000);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        ...authorization(),
        "x-request-id": unsafeRequestId,
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(202);
    const responseRequestId = response.json().data.requestId as string;
    expect(responseRequestId).not.toBe(unsafeRequestId);
    expect(responseRequestId.length).toBeLessThanOrEqual(128);
    expect(enqueue).toHaveBeenCalledWith({
      ...requestBody,
      requestId: responseRequestId,
    });
    await app.close();
  });

  it("uses the same Unicode length semantics as the OpenAPI schema", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });
    const maximumLengthSessionId = "\u{1f600}".repeat(256);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: { ...requestBody, sessionId: maximumLengthSessionId },
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: {
        ...requestBody,
        sessionId: `${maximumLengthSessionId}\u{1f600}`,
      },
    });

    expect(accepted.statusCode).toBe(202);
    expect(rejected.statusCode).toBe(400);
    expect(enqueue).toHaveBeenCalledTimes(1);
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

  it("propagates request context without treating sourceId as a session", async () => {
    let capturedContext: Readonly<LogContext> | undefined;
    const app = await createApiGateway({
      config,
      messageIngress: {
        enqueue: () => {
          capturedContext = getLogContext();
          return Promise.resolve();
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        ...authorization(),
        "x-request-id": "request-context-1",
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(202);
    expect(capturedContext).toEqual({
      requestId: "request-context-1",
    });
    await app.close();
  });

  it("writes contextual Pino logs without credentials or message content", async () => {
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-api-test", stream });
    const logger = createModuleLogger(rootLogger, "api");
    const app = await createApiGateway({
      config,
      logger,
      messageIngress: fakeIngress(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        ...authorization(),
        "x-request-id": "request-log-1",
      },
      payload: requestBody,
    });

    expect(response.statusCode).toBe(202);
    await app.close();
    await closeLogger(rootLogger);
    const logs = stream.logs();
    expect(
      logs.find((entry) => entry.event === "http.message.accepted"),
    ).toMatchObject({
      service: "kaguya-api-test",
      module: "api",
      requestId: "request-log-1",
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(gatewayToken);
    expect(serialized).not.toContain(requestBody.text);
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

  it("reports malformed JSON as an invalid request", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        ...authorization(),
        "content-type": "application/json",
      },
      payload: '{"sessionId":"session-1",',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes unsupported media types and oversized bodies", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        ...authorization(),
        "content-type": "application/xml",
      },
      payload: "<message />",
    });
    const oversized = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: {
        sessionId: "session-1",
        text: "x".repeat(300_000),
      },
    });

    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({
      error: { code: "request_rejected" },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "request_rejected" },
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

interface MessageIngress {
  enqueue(command: {
    sessionId: string;
    text: string;
    requestId: string;
  }): Promise<void>;
}

function createApiGateway(options: {
  config: ServerConfig;
  messageIngress?: MessageIngress;
  logger?: Parameters<typeof createHttpApplication>[0]["logger"];
}) {
  const runtime =
    options.messageIngress === undefined
      ? undefined
      : {
          dispatch(message: {
            kind: "web";
            sessionId: string;
            text: string;
            requestId: string;
          }) {
            const { kind: _kind, ...command } = message;
            return (
              options.messageIngress?.enqueue(command) ?? Promise.resolve()
            );
          },
        };
  return createHttpApplication({
    config: options.config,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(runtime === undefined ? {} : { runtime }),
  });
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

class LogStream extends Writable {
  readonly #chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.#chunks.push(chunk.toString());
    callback();
  }

  logs(): Record<string, unknown>[] {
    return this.#chunks
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
