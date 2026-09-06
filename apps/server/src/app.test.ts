/**
 * 功能概述：本文件验证 HTTP 应用在受保护 setup 状态、Profile 管理接口、
 * 消息入口与统一错误映射上的外部契约，确保服务端只暴露显式的全局 Profile Registry
 * 行为，不再保留临时 setup 写桥接或隐式 default 回退。
 * 主要职责：前几组用例覆盖 `/api/v1/setup` 仅返回无密钥元数据、`/api/v1/profiles`
 * 六个能力的鉴权优先级、CRUD/选择/删除语义，以及 `ConfigError` 到 HTTP 状态码和
 * 业务错误码的映射；其余用例继续保护 `/api/v1/messages`、OpenAPI、限流、请求 ID
 * 与日志上下文契约不回退。
 * 代码库关系：该文件直接驱动 `app.ts`，既会用 stub `ConfigurationManagement`
 * 验证路由层顺序，也会用真实 `createConfigurationManagement` 在临时目录上验证
 * Profile API 与 `packages/config`/`setup.ts` 的集成行为；它与 `setup.test.ts`、
 * `server-composition.test.ts` 一起覆盖 Task 5 的服务层收口。
 * 输入输出与副作用：测试通过 `app.inject()` 发起内存内 HTTP 请求；Profile CRUD
 * 集成用例会在临时配置目录中落盘 Registry 文件并在结束后删除。若路由泄漏 secret、
 * 未先鉴权就执行校验，或错误映射偏离契约，本文件会立即失败。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  createConfigurationManagement,
  type ConfigurationManagement,
} from "./setup.js";
import type { WebMessageGateway } from "./web-gateway.js";

const gatewayToken = "test-gateway-token-12345";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken,
  corsOrigins: ["http://localhost:5173"],
  trustProxy: false,
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  databaseUrl: "postgresql://kaguya@database.example:5432/kaguya",
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
  it("serves authenticated setup status without secrets", async () => {
    const setup: ConfigurationManagement = {
      inspect: vi.fn(async () => ({
        status: "invalid" as const,
        selectedProfileId: "default",
        profiles: [
          { id: "default", name: "default", createdAt: NOW, updatedAt: NOW },
        ],
        issues: [
          {
            id: "default-provider-missing",
            path: "ai.providers",
            message: "missing provider",
          },
        ],
        warnings: [
          {
            id: "platforms-empty",
            path: "platforms",
            message: "platforms empty",
          },
        ],
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

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/setup",
      headers: authorization(),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      data: {
        status: "invalid",
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
        issues: [expect.objectContaining({ id: "default-provider-missing" })],
        warnings: [expect.objectContaining({ id: "platforms-empty" })],
      },
    });
    expect(status.body).not.toContain("provider-secret");
    expect(status.body).not.toContain('"apiKey"');
    expect(status.body).not.toContain('"baseUrl"');

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

  it("authenticates profile management before path or body validation", async () => {
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

    for (const request of [
      { method: "GET" as const, url: "/api/v1/profiles" },
      {
        method: "POST" as const,
        url: "/api/v1/profiles",
        payload: { wrong: true },
      },
      { method: "GET" as const, url: "/api/v1/profiles/not-a-profile-id" },
      {
        method: "PUT" as const,
        url: "/api/v1/profiles/not-a-profile-id",
        payload: { bad: true },
      },
      {
        method: "PUT" as const,
        url: "/api/v1/profiles/selection",
        payload: { selectedProfileId: "not-a-profile-id" },
      },
      { method: "DELETE" as const, url: "/api/v1/profiles/not-a-profile-id" },
    ]) {
      const response = await app.inject(request);

      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
      expect(response.json(), `${request.method} ${request.url}`).toMatchObject(
        {
          error: { code: "unauthorized" },
        },
      );
    }
    await app.close();
  });

  it("creates profile without auto-selecting it", async () => {
    await withManagementApp(async (app, management) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/profiles",
        headers: authorization(),
        payload: { name: "work" },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        data: {
          restartRequired: false,
          profile: {
            id: expect.stringMatching(UUID_PATTERN),
            name: "work",
            ai: { providers: [] },
            platforms: [],
            plugins: [],
          },
        },
      });
      await expect(management.listProfiles()).resolves.toMatchObject({
        selectedProfileId: "default",
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: "default", name: "default" }),
          expect.objectContaining({ name: "work" }),
        ]),
      });
    });
  });

  it("reads profile metadata and body by explicit profile id", async () => {
    await withManagementApp(async (app, management) => {
      const created = await management.createProfile("work");

      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/profiles",
        headers: authorization(),
      });
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/profiles/${created.profile.id}`,
        headers: authorization(),
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        data: {
          selectedProfileId: "default",
          profiles: expect.arrayContaining([
            expect.objectContaining({ id: "default", name: "default" }),
            expect.objectContaining({ id: created.profile.id, name: "work" }),
          ]),
        },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        data: {
          profile: {
            id: created.profile.id,
            name: "work",
            ai: { providers: [] },
            platforms: [],
            plugins: [],
          },
        },
      });
    });
  });

  it("replaces profile with the submitted full body", async () => {
    await withManagementApp(async (app, management) => {
      const created = await management.createProfile("work");
      const payload = readyProfileReplacement(
        "work",
        "light-model",
        "heavy-model",
      );

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/profiles/${created.profile.id}`,
        headers: authorization(),
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          restartRequired: false,
          profile: {
            id: created.profile.id,
            name: "work",
            ai: payload.ai,
            platforms: [],
            plugins: [],
          },
        },
      });
    });
  });

  it("selects profile explicitly and reports restart requirement", async () => {
    await withManagementApp(async (app, management) => {
      const created = await management.createProfile("work");
      await management.replaceProfile(
        created.profile.id,
        readyProfileReplacement("work", "light-model", "heavy-model"),
      );

      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/profiles/selection",
        headers: authorization(),
        payload: { selectedProfileId: created.profile.id },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          restartRequired: true,
          profile: { id: created.profile.id, name: "work" },
        },
      });
      await expect(management.inspect()).resolves.toMatchObject({
        status: "restart_required",
        selectedProfileId: created.profile.id,
        profiles: expect.arrayContaining([
          expect.objectContaining({ id: "default", name: "default" }),
          expect.objectContaining({ id: created.profile.id, name: "work" }),
        ]),
      });
    });
  });

  it("serves metadata-complete ready setup status when management is absent", async () => {
    const app = await createApiGateway({ config });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setup",
      headers: authorization(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: "ready",
        selectedProfileId: "default",
        profiles: [
          {
            id: "default",
            name: "default",
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
    });
    await app.close();
  });

  it("deletes an unselected profile", async () => {
    await withManagementApp(async (app, management) => {
      const created = await management.createProfile("throwaway");

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/profiles/${created.profile.id}`,
        headers: authorization(),
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
      await expect(management.listProfiles()).resolves.toEqual({
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
      });
    });
  });

  it("maps profile validation and manager errors to the documented HTTP responses", async () => {
    await withManagementApp(async (app, management) => {
      const created = await management.createProfile("work");
      const unknownProfileId = "22222222-2222-4222-8222-222222222222";

      const invalidId = await app.inject({
        method: "GET",
        url: "/api/v1/profiles/not-a-profile-id",
        headers: authorization(),
      });
      const unknown = await app.inject({
        method: "GET",
        url: `/api/v1/profiles/${unknownProfileId}`,
        headers: authorization(),
      });
      const duplicateName = await app.inject({
        method: "POST",
        url: "/api/v1/profiles",
        headers: authorization(),
        payload: { name: "work" },
      });
      const protectedDelete = await app.inject({
        method: "DELETE",
        url: "/api/v1/profiles/default",
        headers: authorization(),
      });
      await management.selectProfile(created.profile.id);
      const inUseDelete = await app.inject({
        method: "DELETE",
        url: `/api/v1/profiles/${created.profile.id}`,
        headers: authorization(),
      });

      expect(invalidId.statusCode).toBe(400);
      expect(invalidId.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({
        error: { code: "profile_not_found" },
      });
      expect(duplicateName.statusCode).toBe(409);
      expect(duplicateName.json()).toMatchObject({
        error: { code: "profile_name_conflict" },
      });
      expect(protectedDelete.statusCode).toBe(409);
      expect(protectedDelete.json()).toMatchObject({
        error: { code: "profile_protected" },
      });
      expect(inUseDelete.statusCode).toBe(409);
      expect(inUseDelete.json()).toMatchObject({
        error: { code: "profile_in_use" },
      });
    });
  });

  it("requires the setup authorization contract", async () => {
    const app = await createApiGateway({
      config,
      setup: stubManagement(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/setup",
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(response.statusCode).toBe(401);
    const removed = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: authorization(),
    });
    expect(removed.statusCode).toBe(404);
    await app.close();
  });

  it("exposes health, OpenAPI, and the profile plus message contracts", async () => {
    const app = await createApiGateway({
      config,
      webGateway: fakeGateway(),
      setup: stubManagement(),
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
        "/api/v1/profiles": {
          get: { security: [{ bearerAuth: [] }] },
          post: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    required: ["name"],
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        "/api/v1/profiles/{profileId}": {
          get: { security: [{ bearerAuth: [] }] },
          put: { security: [{ bearerAuth: [] }] },
          delete: { security: [{ bearerAuth: [] }] },
        },
        "/api/v1/profiles/selection": {
          put: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    required: ["selectedProfileId"],
                    properties: {
                      selectedProfileId: {
                        anyOf: [
                          { enum: ["default"] },
                          { type: "string", format: "uuid" },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/api/v1/setup": {
          get: {
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      properties: {
                        data: {
                          required: ["status", "selectedProfileId", "profiles"],
                          properties: {
                            profiles: {
                              items: {
                                required: [
                                  "id",
                                  "name",
                                  "createdAt",
                                  "updatedAt",
                                ],
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
          },
        },
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
    expect(serialized).toContain("/api/v1/setup");
    expect(serialized).toContain('"selectedProfileId"');
    expect(serialized).toContain('"apiKey"');
    expect(serialized).toContain('"baseUrl"');
    expect(serialized).not.toContain('"workflowId"');
    expect(serialized).not.toContain('"systemPrompt"');
    expect(serialized).not.toContain('"userPrompt"');
    await app.close();
  });

  it("does not expose the removed model route", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/llm/chat",
      headers: { authorization: "Bearer wrong-token" },
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
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses bounded client request IDs and replaces unsafe values", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).toHaveBeenCalledWith({
      ...requestBody,
      requestId: responseRequestId,
    });
    await app.close();
  });

  it("rejects the removed sessionId request field", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: { ...requestBody, sessionId: "legacy-session" },
    });

    expect(rejected.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps a missing web gateway to the setup-required status", async () => {
    const app = await createApiGateway({
      config,
      setup: stubManagement(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: authorization(),
      payload: requestBody,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "configuration_setup_required" },
    });
    await app.close();
  });

  it("authenticates before parsing or validating a message", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates and ingests a message without model configuration", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith({
      text: " Hello ",
      requestId: "request-123",
    });
    await app.close();
  });

  it("propagates request context", async () => {
    let capturedContext: Readonly<LogContext> | undefined;
    const app = await createApiGateway({
      config,
      webGateway: {
        ingest: () => {
          capturedContext = getLogContext();
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
      webGateway: fakeGateway(),
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
    expect(serialized).not.toContain("traceId");
  });

  it("rejects model, provider, prompt, and workflow routing fields", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects blank messages", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports malformed JSON as an invalid request", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes unsupported media types and oversized bodies", async () => {
    const ingest = vi.fn();
    const app = await createApiGateway({
      config,
      webGateway: { ingest },
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
    expect(ingest).not.toHaveBeenCalled();
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
      webGateway: {
        ingest: () => {
          throw new Error("internal queue details");
        },
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
      webGateway: fakeGateway(),
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
      webGateway: fakeGateway(),
    });
    const firstTrustedClient = await injectFrom(trustedApp, "198.51.100.1");
    const secondTrustedClient = await injectFrom(trustedApp, "198.51.100.2");

    expect(firstTrustedClient.statusCode).toBe(202);
    expect(secondTrustedClient.statusCode).toBe(202);
    await trustedApp.close();

    const untrustedApp = await createApiGateway({
      config: { ...config, rateLimitMax: 1 },
      webGateway: fakeGateway(),
    });
    const spoofedFirstClient = await injectFrom(untrustedApp, "198.51.100.1");
    const spoofedSecondClient = await injectFrom(untrustedApp, "198.51.100.2");

    expect(spoofedFirstClient.statusCode).toBe(202);
    expect(spoofedSecondClient.statusCode).toBe(429);
    await untrustedApp.close();
  });
});

function fakeGateway(): WebMessageGateway {
  return { ingest: vi.fn() };
}

function createApiGateway(options: {
  config: ServerConfig;
  webGateway?: WebMessageGateway;
  setup?: ConfigurationManagement;
  logger?: Parameters<typeof createHttpApplication>[0]["logger"];
}) {
  return createHttpApplication({
    config: options.config,
    ...(options.webGateway === undefined
      ? {}
      : { webGateway: options.webGateway }),
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
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

const NOW = "2026-08-30T00:00:00.000Z";

async function withManagementApp(
  assertion: (
    app: Awaited<ReturnType<typeof createApiGateway>>,
    management: ConfigurationManagement,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-app-test-"));
  const management = await createConfigurationManagement(root);
  const app = await createApiGateway({ config, setup: management });
  try {
    await assertion(app, management);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function stubManagement(): ConfigurationManagement {
  return {
    inspect: vi.fn(async () => ({
      status: "invalid" as const,
      selectedProfileId: "default",
      profiles: [
        { id: "default", name: "default", createdAt: NOW, updatedAt: NOW },
      ],
      issues: [],
    })),
    listProfiles: vi.fn(async () => ({
      selectedProfileId: "default",
      profiles: [
        { id: "default", name: "default", createdAt: NOW, updatedAt: NOW },
      ],
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
    replaceProfile: vi.fn(),
    selectProfile: vi.fn(),
    deleteProfile: vi.fn(),
  };
}

function readyProfileReplacement(
  name: string,
  lightModelId: string,
  heavyModelId: string,
) {
  return {
    name,
    acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
    ai: {
      defaultProviderId: "provider-1",
      modelTiers: {
        light: { providerId: "provider-1", modelId: lightModelId },
        heavy: { providerId: "provider-1", modelId: heavyModelId },
      },
      providers: [
        {
          id: "provider-1",
          type: "openai-compatible" as const,
          enabled: true,
          apiKey: "provider-key",
          baseUrl: "https://llm.example/v1",
          models: [lightModelId, heavyModelId],
          settings: {},
        },
      ],
    },
    platforms: [],
    plugins: [],
  };
}
