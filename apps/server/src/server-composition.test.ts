/**
 * 功能概述：验证 Server 作为唯一 composition root 组合 PostgreSQL information
 * database、Runtime、Web/NapCat ingress、HTTP 与启动期选定的全局 Profile。
 * 主要职责：用真实 PGlite 覆盖 Web 到 information DAG，验证 HTTP/Web UI/Vite
 * 组合和启动失败关闭；并区分数据库初始化与模块/Runtime 生命周期失败的固定错误分类，
 * 覆盖未知字母数字类名和抛出型 constructor/name getter；
 * `createRuntimeModelSelectionResolver` 用例保证 selected Profile
 * 在启动时冻结、light/heavy 共用一个 tier-only resolver，且模块不能传 `profileId`。
 * 代码库关系：直接驱动 `server.ts`、`app.ts`、`web-gateway.ts` 与 `web.ts`；
 * 真实配置 Registry 来自 `@kaguya/config`，信息账本来自 `@kaguya/database/testing`，
 * provider client 创建由 `@ai-sdk/openai-compatible` mock 观察。
 * 输入输出与副作用：每个用例使用独立临时配置目录或内存 PGlite；
 * 启动错误用人工包含密码的连接异常验证返回值与日志均已脱敏。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { KaguyaDatabase } from "@kaguya/database";
import { createTestingDatabase } from "@kaguya/database/testing";
import { FileUserConfigManager } from "@kaguya/config";
import { closeLogger, createLogger, createModuleLogger } from "@kaguya/logger";
import {
  KaguyaRuntime,
  type RuntimeModelSelectionResolver,
} from "@kaguya/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import {
  createRuntimeModelSelectionResolver,
  InformationRuntimeStartupError,
  startKaguyaServer,
} from "./server.js";
import { createWebMessageGateway } from "./web-gateway.js";
import { registerWebUi } from "./web.js";
import { llmReplySettingsSchema } from "../../../packages/modules/src/llm-reply.js";

const chatModel = vi.fn((modelId: string) => ({ modelId }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({ chatModel })),
}));

const gatewayToken = "test-gateway-token-12345";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-server-composition-"));
  roots.push(root);
  return root;
}

function config(workspaceRoot: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    gatewayToken,
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    databaseUrl: "postgresql://kaguya@database.example:5432/kaguya",
    configRoot: join(workspaceRoot, "config"),
    development: false,
    webDistPath: join(workspaceRoot, "web"),
    gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
    napcat: {
      enabled: false,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
    },
  };
}

describe("unified server composition", () => {
  it("sanitizes unknown and throwing Runtime startup error properties", () => {
    class DatabasePassword123 extends Error {}
    const named = new InformationRuntimeStartupError(
      new DatabasePassword123("runtime-password"),
    );
    const reflective = new Error("runtime-message-secret");
    Object.defineProperties(reflective, {
      constructor: {
        get() {
          throw new Error("constructor-getter-secret");
        },
      },
      name: {
        get() {
          throw new Error("name-getter-secret");
        },
      },
    });

    const throwing = new InformationRuntimeStartupError(reflective);

    expect(named).toMatchObject({ failureType: "Error" });
    expect(throwing).toMatchObject({ failureType: "Error" });
    expect(JSON.stringify([named, throwing])).not.toMatch(
      /DatabasePassword123|password|getter-secret|message-secret/u,
    );
  });

  it("ingests Web messages through the shared Runtime as a platform adapter", async () => {
    const workspaceRoot = tempWorkspaceRoot();
    const database = await createTestingDatabase();
    const runtime = new KaguyaRuntime({ database });
    runtime.registerTransport({
      adapterId: "web.ui.main",
      platform: "web",
      transport: {
        sendMessage: async (target) => ({
          ok: true,
          adapterId: "web.ui.main",
          platform: "web",
          target,
          platformMessageId: "web-delivery-1",
        }),
      },
    });
    await runtime.start();
    const rootLogger = createLogger({
      service: "kaguya-server-composition-test",
      level: "silent",
    });
    const receipts: Awaited<ReturnType<KaguyaRuntime["submit"]>>[] = [];
    const webGateway = createWebMessageGateway({
      adapterId: "web.ui.main",
      ingress: {
        submit: async (message) => {
          const receipt = await runtime.submit(message);
          receipts.push(receipt);
          return receipt;
        },
      },
      logger: rootLogger,
    });
    const app = await createHttpApplication({
      config: config(workspaceRoot),
      webGateway,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "x-request-id": "request-server-1",
      },
      payload: {
        text: "Hello from the browser",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: { status: "accepted", requestId: "request-server-1" },
    });
    await vi.waitFor(() => expect(receipts).toHaveLength(1));
    const graph = await database.information.query({
      informationId: receipts[0]!.rootInformationId,
    });
    const inbound = graph.find(
      ({ kind }) => kind === "core.message.inbound.text",
    );
    expect(inbound).toMatchObject({
      payload: {
        text: "Hello from the browser",
        source: {
          platform: "web",
          adapterId: "web.ui.main",
          platformMessageId: "request-server-1",
          destination: { kind: "web" },
          senderId: "web",
        },
      },
    });
    expect(new Set(graph.map(({ kind }) => kind))).toEqual(
      new Set([
        "core.message.inbound.text",
        "core.reply.requested",
        "core.llm.requested",
        "core.llm.completed",
        "core.message.assistant.text",
        "core.delivery.requested",
        "core.delivery.delivered",
      ]),
    );
    expect(JSON.stringify(graph)).not.toMatch(/traceId|raw/u);
    await app.close();
    await runtime.close();
    await database.close();
    await closeLogger(rootLogger);
  }, 20_000);

  it("serves the Web UI, health, OpenAPI, and SPA fallback on one app", async () => {
    const workspaceRoot = tempWorkspaceRoot();
    const webDistPath = join(workspaceRoot, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya UI</main>");
    writeFileSync(join(webDistPath, "app.js"), "globalThis.kaguya = true;");
    const serverConfig = { ...config(workspaceRoot), webDistPath };
    const app = await createHttpApplication({ config: serverConfig });
    const webUi = await registerWebUi(app, serverConfig);

    const [root, asset, spa, health, openapi, missingApi] = await Promise.all([
      app.inject({ method: "GET", url: "/" }),
      app.inject({ method: "GET", url: "/app.js" }),
      app.inject({
        method: "GET",
        url: "/conversation/one",
        headers: { accept: "text/html" },
      }),
      app.inject({ method: "GET", url: "/healthz" }),
      app.inject({ method: "GET", url: "/api/v1/openapi.json" }),
      app.inject({
        method: "GET",
        url: "/api/missing",
        headers: { accept: "text/html" },
      }),
    ]);

    expect(root.body).toContain("Kaguya UI");
    expect(asset.body).toContain("globalThis.kaguya");
    expect(spa.body).toContain("Kaguya UI");
    expect(health.json()).toEqual({ status: "ok" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toMatchObject({
      paths: {
        "/api/v1/setup": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      properties: {
                        data: {
                          required: [
                            "status",
                            "selectedProfileId",
                            "profiles",
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
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/setup" })).json(),
    ).toEqual({
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
        gatewayToken,
      },
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ error: { code: "not_found" } });

    await app.close();
    await webUi.close();
  });

  it("keeps API and health routes ahead of Vite middleware in development", async () => {
    const workspaceRoot = tempWorkspaceRoot();
    const serverConfig = { ...config(workspaceRoot), development: true };
    const app = await createHttpApplication({ config: serverConfig });
    const webUi = await registerWebUi(app, serverConfig);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const openapi = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });
    const root = await app.inject({ method: "GET", url: "/" });

    expect(health.headers["content-type"]).toContain("application/json");
    expect(health.json()).toEqual({ status: "ok" });
    expect(openapi.headers["content-type"]).toContain("application/json");
    expect(openapi.json()).toMatchObject({
      paths: { "/api/v1/messages": expect.any(Object) },
    });
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain("/@vite/client");

    await app.close();
    await webUi.close();
  });

  it("keeps unrecoverable management creation on the startup fatal-and-close path", async () => {
    const workspaceRoot = tempWorkspaceRoot();
    const configRoot = join(workspaceRoot, "config");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, "index.json"),
      JSON.stringify({ version: 2 }),
    );

    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    const createLoggerSpy = vi
      .spyOn(await import("@kaguya/logger"), "createLogger")
      .mockReturnValue(rootLogger);
    const closeLoggerSpy = vi.spyOn(
      await import("@kaguya/logger"),
      "closeLogger",
    );

    const error = await startKaguyaServer({
      ...config(workspaceRoot),
      configRoot,
      webDistPath: join(workspaceRoot, "web"),
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "CONFIG_UNSUPPORTED_VERSION" });
    expect(createLoggerSpy).toHaveBeenCalledTimes(1);
    expect(closeLoggerSpy).toHaveBeenCalledWith(rootLogger);
    expect(stream.logs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "server.start.failed",
          level: "fatal",
        }),
        expect.objectContaining({ event: "server.stopping", level: "info" }),
        expect.objectContaining({ event: "server.stopped", level: "info" }),
      ]),
    );

    createLoggerSpy.mockRestore();
    closeLoggerSpy.mockRestore();
    await closeLogger(rootLogger);
  });

  it("connects the information database once and redacts credentials from startup errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-database-startup-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    const selectedProfileId = manager.getSelectedProfileId();
    await manager.replaceProfile(
      selectedProfileId,
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(selectedProfileId, [
      "platforms-empty",
      "plugins-empty",
    ]);
    const databaseUrl =
      "postgresql://ledger:database-password@127.0.0.1:5432/kaguya";
    const connect = vi
      .spyOn(KaguyaDatabase, "connect")
      .mockRejectedValueOnce(new Error(`connection failed: ${databaseUrl}`));
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    const createLoggerSpy = vi
      .spyOn(await import("@kaguya/logger"), "createLogger")
      .mockReturnValue(rootLogger);

    const error = await startKaguyaServer({
      ...config(join(root, "database")),
      configRoot: root,
      databaseUrl,
      port: 0,
    }).catch((thrown: unknown) => thrown);

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ connectionString: databaseUrl });
    expect(error).toMatchObject({
      name: "InformationDatabaseConnectionError",
      message: "Information database connection failed",
      failureType: "Error",
    });
    const serialized = JSON.stringify(stream.logs());
    expect(serialized).toContain(
      '"errorType":"InformationDatabaseConnectionError"',
    );
    expect(`${String(error)}\n${serialized}`).not.toContain(databaseUrl);
    expect(`${String(error)}\n${serialized}`).not.toContain(
      "database-password",
    );

    connect.mockRestore();
    createLoggerSpy.mockRestore();
    await closeLogger(rootLogger);
  });

  it("redacts credentials when the first database I/O fails during Runtime startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-database-migrate-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    const selectedProfileId = manager.getSelectedProfileId();
    await manager.replaceProfile(
      selectedProfileId,
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(selectedProfileId, [
      "platforms-empty",
      "plugins-empty",
    ]);
    const databaseUrl =
      "postgresql://ledger:runtime-start-password@127.0.0.1:5432/kaguya";
    const database = await createTestingDatabase();
    const migrate = vi
      .spyOn(database, "migrate")
      .mockRejectedValueOnce(
        new Error(`authentication failed: ${databaseUrl}`),
      );
    const close = vi.spyOn(database, "close");
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    vi.spyOn(await import("@kaguya/logger"), "createLogger").mockReturnValue(
      rootLogger,
    );

    const error = await startKaguyaServer({
      ...config(join(root, "database")),
      configRoot: root,
      databaseUrl,
      port: 0,
    }).catch((thrown: unknown) => thrown);

    expect(migrate).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      name: "InformationDatabaseConnectionError",
      message: "Information database connection failed",
      failureType: "Error",
    });
    expect(error).not.toHaveProperty("cause");
    expect(stream.logs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "server.start.failed",
          errorType: "InformationDatabaseConnectionError",
        }),
      ]),
    );
    const serialized = `${String(error)}\n${JSON.stringify(error)}\n${JSON.stringify(stream.logs())}`;
    expect(serialized).not.toContain(databaseUrl);
    expect(serialized).not.toContain("runtime-start-password");

    await closeLogger(rootLogger);
  });

  it("classifies non-database Runtime startup failures without leaking their details", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-runtime-startup-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    const selectedProfileId = manager.getSelectedProfileId();
    await manager.replaceProfile(
      selectedProfileId,
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(selectedProfileId, [
      "platforms-empty",
      "plugins-empty",
    ]);
    const database = await createTestingDatabase();
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    const secret = "postgresql://module:module-secret@db.internal/kaguya";
    vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
      new Error(`module initialization failed: ${secret}`),
    );
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    vi.spyOn(await import("@kaguya/logger"), "createLogger").mockReturnValue(
      rootLogger,
    );

    const error = await startKaguyaServer({
      ...config(join(root, "database")),
      configRoot: root,
      port: 0,
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({
      name: "InformationRuntimeStartupError",
      message: "Information runtime startup failed",
      failureType: "Error",
    });
    expect(error).not.toHaveProperty("cause");
    const serialized = `${String(error)}\n${JSON.stringify(error)}\n${JSON.stringify(stream.logs())}`;
    expect(serialized).not.toContain("module-secret");
    expect(serialized).not.toContain("postgresql://");
    await closeLogger(rootLogger);
  });

  it("resolves the globally selected profile exactly once during startup", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "kaguya-selected-profile-startup-"),
    );
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    const selectedProfileId = manager.getSelectedProfileId();
    await manager.replaceProfile(
      selectedProfileId,
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(selectedProfileId, [
      "platforms-empty",
      "plugins-empty",
    ]);
    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya UI</main>");
    const database = await createTestingDatabase();
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    const rootLogger = createLogger({
      service: "kaguya-server-composition-test",
      level: "silent",
    });
    vi.spyOn(await import("@kaguya/logger"), "createLogger").mockReturnValue(
      rootLogger,
    );
    const selectedProfileReads = vi.spyOn(
      FileUserConfigManager.prototype,
      "getSelectedProfileId",
    );

    const server = await startKaguyaServer({
      ...config(join(root, "database")),
      configRoot: root,
      webDistPath,
      port: 0,
    });

    expect(selectedProfileReads).toHaveBeenCalledOnce();
    await server.close();
  }, 20_000);

  it("creates a heavy/light resolver from frozen profile configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-profile-resolver-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await manager.replaceProfile(
      manager.getSelectedProfileId(),
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(
      manager.getSelectedProfileId(),
      ["platforms-empty", "plugins-empty"],
    );
    await manager.createProfile("incomplete");

    const resolver = createRuntimeModelSelectionResolver(
      await selectedProfile(manager),
    );

    expect(resolver({ modelTier: "light" })).toEqual({
      modelId: "default-light",
      model: { modelId: "default-light" },
    });
    expect(resolver({ modelTier: "heavy" })).toEqual({
      modelId: "default-heavy",
      model: { modelId: "default-heavy" },
    });
    expect(chatModel).toHaveBeenCalledWith("default-light");
    expect(chatModel).toHaveBeenCalledWith("default-heavy");
  });

  it("freezes the selected profile even if the registry selection changes later", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-profile-resolver-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await manager.replaceProfile(
      manager.getSelectedProfileId(),
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(
      manager.getSelectedProfileId(),
      ["platforms-empty", "plugins-empty"],
    );
    const selected = await manager.createProfile("selected");
    await manager.replaceProfile(
      selected.id,
      readyProfileReplacement(
        selected.name,
        readyProfileSettings("selected-light", "selected-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(selected.id, [
      "platforms-empty",
      "plugins-empty",
    ]);
    await manager.selectProfile(selected.id);

    const resolver = createRuntimeModelSelectionResolver(
      await selectedProfile(manager),
    );
    await manager.selectProfile("default");

    expect(resolver({ modelTier: "light" })).toEqual({
      modelId: "selected-light",
      model: { modelId: "selected-light" },
    });
    expect(resolver({ modelTier: "heavy" })).toEqual({
      modelId: "selected-heavy",
      model: { modelId: "selected-heavy" },
    });
    expect(chatModel).toHaveBeenCalledWith("selected-light");
    expect(chatModel).toHaveBeenCalledWith("selected-heavy");
  });

  it("passes structured-output support from profile provider settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-profile-resolver-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await manager.replaceProfile(manager.getSelectedProfileId(), {
      name: "default",
      acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
      ai: {
        defaultProviderId: "provider-1",
        modelTiers: {
          light: { providerId: "provider-1", modelId: "light-model" },
          heavy: { providerId: "provider-1", modelId: "heavy-model" },
        },
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            apiKey: "provider-key",
            baseUrl: "https://llm.example/v1",
            models: ["light-model", "heavy-model"],
            settings: { supportsStructuredOutputs: true },
          },
        ],
      },
      platforms: [],
      plugins: [],
    });
    await manager.acknowledgeConfigurationWarnings(
      manager.getSelectedProfileId(),
      ["platforms-empty", "plugins-empty"],
    );

    createRuntimeModelSelectionResolver(await selectedProfile(manager));

    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ supportsStructuredOutputs: true }),
    );
  });

  it("rejects an incomplete selected profile before creating provider clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-incomplete-profile-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    vi.mocked(createOpenAICompatible).mockClear();
    const profile = await manager.getProfile(manager.getSelectedProfileId());

    expect(() => createRuntimeModelSelectionResolver(profile)).toThrow(
      "Configuration is incomplete",
    );
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it("rejects profile overrides at the module boundary and resolver call site", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-profile-resolver-"));
    roots.push(root);
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await manager.replaceProfile(
      manager.getSelectedProfileId(),
      readyProfileReplacement(
        "default",
        readyProfileSettings("default-light", "default-heavy"),
      ),
    );
    await manager.acknowledgeConfigurationWarnings(
      manager.getSelectedProfileId(),
      ["platforms-empty", "plugins-empty"],
    );
    const resolver: RuntimeModelSelectionResolver =
      createRuntimeModelSelectionResolver(await selectedProfile(manager));

    expect(
      llmReplySettingsSchema.safeParse({
        profileId: "profile-override",
        modelTier: "light",
        outbound: { mode: "source", messageKind: "text" },
      }).success,
    ).toBe(false);
    const invalidSelection: Parameters<RuntimeModelSelectionResolver>[0] = {
      // @ts-expect-error Runtime selections are tier-only and cannot carry a profile override.
      profileId: "profile-override",
      modelTier: "light",
    };
    expect(invalidSelection.modelTier).toBe("light");
    expect(resolver({ modelTier: "light" })).toEqual({
      modelId: "default-light",
      model: { modelId: "default-light" },
    });
    expect(chatModel).toHaveBeenCalledWith("default-light");
  });
});

async function selectedProfile(manager: FileUserConfigManager) {
  return manager.resolveProfileById(manager.getSelectedProfileId());
}

function readyProfileSettings(lightModelId: string, heavyModelId: string) {
  return {
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

function readyProfileReplacement(
  name: string,
  settings: ReturnType<typeof readyProfileSettings>,
) {
  return {
    name,
    acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
    ...settings,
  };
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
