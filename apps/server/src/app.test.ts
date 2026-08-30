/**
 * 功能概述：本文件验证 HTTP 应用在消息模式与 setup 模式下的路由边界、鉴权和错误映射，
 * 并为服务层配置门面从旧 `initialize()` 迁移到 `ConfigurationManagement` 提供编译期回归保护。
 * 主要职责：前几组用例覆盖 `/api/v1/setup` 与 `/api/v1/messages` 的鉴权、状态码与
 * 请求校验；辅助构造会为管理门面提供最小可用 stub，使测试聚焦在 HTTP 行为而不是
 * config manager 细节；其余用例验证 OpenAPI、限流、请求 ID 与日志上下文契约。
 * 代码库关系：该文件直接驱动 `app.ts`，并通过 mock 的 `ConfigurationManagement`
 * 与 fake message ingress 隔离 Fastify 路由层；它与 `setup.ts`、`server.ts` 一起构成
 * 服务包在 Task 4 期间的过渡安全网，确保 setup API 重构不会破坏网关类型边界。
 * 输入输出与副作用：测试通过 `app.inject()` 发起内存内 HTTP 请求，不写真实配置目录；
 * 若路由重新依赖已删除的一次性 setup 门面或错误地跳过鉴权/校验顺序，本文件会立即失败。
 */
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  closeLogger,
  createLogger,
  createModuleLogger,
  getLogContext,
  type LogContext,
} from "@kaguya/logger";
import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import type { ConfigurationManagement } from "./setup.js";

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
const requestBody = { text: "Hello" };

function authorization(scheme = "Bearer") {
  return { authorization: `${scheme} ${gatewayToken}` };
}

describe("application API gateway", () => {
  it("serves first-run setup status and accepts initial configuration", async () => {
    const setup: ConfigurationManagement = {
      inspect: vi.fn(async () => ({
        status: "invalid" as const,
        selectedProfileId: "default",
        profiles: [],
        issues: [],
      })),
      listProfiles: vi.fn(async () => ({
        selectedProfileId: "default",
        profiles: [],
      })),
      getProfile: vi.fn(async () => ({
        version: 1 as const,
        id: "default",
        name: "default",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      })),
      createProfile: vi.fn(),
      replaceProfile: vi.fn(async () => ({
        profile: {
          version: 1 as const,
          id: "default",
          name: "default",
          ai: { providers: [] },
          platforms: [],
          plugins: [],
        },
        restartRequired: true,
      })),
      selectProfile: vi.fn(),
      deleteProfile: vi.fn(),
    };
    const app = await createHttpApplication({ config, setup });

    const status = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      data: { status: "invalid", selectedProfileId: "default", profiles: [] },
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
    expect(setup.replaceProfile).toHaveBeenCalledTimes(1);

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
    const setup: ConfigurationManagement = {
      inspect: vi.fn(async () => ({
        status: "invalid" as const,
        selectedProfileId: "default",
        profiles: [],
        issues: [],
      })),
      listProfiles: vi.fn(async () => ({
        selectedProfileId: "default",
        profiles: [],
      })),
      getProfile: vi.fn(),
      createProfile: vi.fn(),
      replaceProfile: vi.fn(),
      selectProfile: vi.fn(),
      deleteProfile: vi.fn(),
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
    expect(setup.replaceProfile).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not allow setup to overwrite a ready configuration", async () => {
    const setup: ConfigurationManagement = {
      inspect: vi.fn(async () => ({
        status: "ready" as const,
        selectedProfileId: "default",
        profiles: [],
      })),
      listProfiles: vi.fn(async () => ({
        selectedProfileId: "default",
        profiles: [],
      })),
      getProfile: vi.fn(),
      createProfile: vi.fn(),
      replaceProfile: vi.fn(),
      selectProfile: vi.fn(),
      deleteProfile: vi.fn(),
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
    expect(setup.replaceProfile).not.toHaveBeenCalled();
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
                    required: ["text"],
                    properties: {
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

  it("rejects the removed sessionId request field", async () => {
    const enqueue = vi.fn(() => Promise.resolve());
    const app = await createApiGateway({
      config,
      messageIngress: { enqueue },
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: { ...requestBody, sessionId: "legacy-session" },
    });

    expect(rejected.statusCode).toBe(400);
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
      payload: { text: " Hello " },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: { status: "accepted", requestId: "request-123" },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      text: " Hello ",
      requestId: "request-123",
    });
    await app.close();
  });

  it("propagates request context", async () => {
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
      payload: { text: "   " },
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
      payload: '{"text":"unfinished",',
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
  enqueue(command: { text: string; requestId: string }): Promise<void>;
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
          dispatch(message: { kind: "web"; text: string; requestId: string }) {
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
