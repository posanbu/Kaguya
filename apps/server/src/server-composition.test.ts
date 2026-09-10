/**
 * 功能概述：验证 Server 作为唯一 composition root 组合 PostgreSQL information
 * database、Runtime、Web/NapCat ingress、HTTP 与启动期选定的全局 Profile。
 * 主要职责：用真实 PGlite 覆盖 Web 到 information DAG，验证 HTTP/Web UI/Vite
 * 组合和启动失败关闭；并区分数据库初始化与模块/Runtime 生命周期失败的固定错误分类，
 * 覆盖未知字母数字类名和抛出型 constructor/name getter；
 * `createRuntimeModelSelectionResolver` 用例保证 selected Profile
 * 在启动时冻结、保留 provider/model 复合身份、light/heavy 共用一个 tier-only resolver，
 * 且模块不能传 `profileId`；同名 model 的跨 provider 并发调用不得串线。
 * 代码库关系：直接驱动 `server.ts`、`app.ts`、`web-gateway.ts` 与 `web.ts`；
 * 真实配置 Registry 来自 `@kaguya/config`，信息账本来自 `@kaguya/database/testing`，
 * provider client 创建由 `@ai-sdk/openai-compatible` mock 观察。
 * 输入输出与副作用：每个用例使用独立临时配置目录或内存 PGlite；
 * 启动错误用人工包含密码的连接异常验证返回值与日志均已脱敏。
 */
import {
  createReplyComposition,
  type RuntimeModelSelectionResolver,
} from "./runtime-composition.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { KaguyaDatabase } from "@kaguya/database";
import { createTestingDatabase } from "@kaguya/database/testing";
import { FileUserConfigManager } from "@kaguya/config";
import { closeLogger, createLogger, createModuleLogger } from "@kaguya/logger";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import { KaguyaRuntime } from "@kaguya/runtime";
import { type CompiledPrompt, z } from "@kaguya/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import {
  createRuntimeModelSelectionResolver,
  formatAccessUrl,
  InformationRuntimeStartupError,
  startKaguyaServer,
} from "./server.js";
import { createWebMessageGateway } from "./web-gateway.js";
import { registerWebUi } from "./web.js";
import { llmReplySettingsSchema } from "@kaguya/modules";

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
    logLevel: "silent",
    logFormat: "json",
    gatewayAllowlist: [],
    napcat: {
      enabled: false,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
    },
  };
}

describe("unified server composition", () => {
  it("formats loopback access links including IPv6", () => {
    expect(
      formatAccessUrl({ host: "127.0.0.1", port: 3000, gatewayToken: "a b" }),
    ).toBe("Kaguya access URL: http://127.0.0.1:3000/#gatewayToken=a%20b");
    expect(
      formatAccessUrl({ host: "::1", port: 4100, gatewayToken: "token" }),
    ).toBe("Kaguya access URL: http://[::1]:4100/#gatewayToken=token");
  });
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
    const runtime = new KaguyaRuntime({
      database,
      ...createReplyComposition(undefined, { profile: "test" }),
    });
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
    await vi.waitFor(
      async () =>
        expect((await database.information.reliable.health()).pending).toBe(0),
      { timeout: 5000 },
    );
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
        "agent.association.completed",
        "agent.association.query",
        "agent.association.requested",
        "agent.chat.scope.binding",
        "agent.chat.scope.entity",
        "agent.heartbeat.scheduled",
        "agent.person.context.completed",
        "agent.attention.arousal.completed",
        "agent.turn.candidate",
        "agent.turn.claimed",
        "agent.turn.completed",
        "agent.turn.context.completed",
        "agent.turn.started",
        "agent.person.resolution",
        "core.message.inbound.text",
        "core.reply.requested",
        "core.model.task.requested",
        "core.model.task.completed",
        "core.message.assistant.text",
        "core.delivery.requested",
        "core.delivery.delivered",
      ]),
    );
    expect(
      graph.find(({ kind }) => kind === "core.model.task.requested")?.payload,
    ).toMatchObject({
      resolvedModel: {
        providerId: "kaguya-deterministic",
        modelId: "deterministic-heavy",
      },
    });
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
                          required: ["status", "selectedProfileId", "profiles"],
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
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/setup",
          headers: { authorization: `Bearer ${gatewayToken}` },
        })
      ).json(),
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
          phase: "configuration",
          errorType: "ConfigError",
          errorCode: "CONFIG_UNSUPPORTED_VERSION",
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

    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
    const server = await startKaguyaServer({
      ...config(join(root, "database")),
      webDistPath,
      configRoot: root,
      databaseUrl,
      port: 0,
    });

    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ connectionString: databaseUrl });
    expect(server.runtime).toBeUndefined();
    expect(server.adapterHost.status().runtime).toEqual({
      ingress: "runtime_unavailable",
      reason: "database_unavailable",
    });
    expect((await server.app.inject("/healthz")).statusCode).toBe(200);
    await server.close();
    const serialized = JSON.stringify(stream.logs());
    expect(serialized).toContain('"reason":"database_unavailable"');
    expect(serialized).toContain('"phase":"database"');
    expect(serialized).not.toContain(databaseUrl);
    expect(serialized).not.toContain("database-password");

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

    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
    const server = await startKaguyaServer({
      ...config(join(root, "database")),
      webDistPath,
      configRoot: root,
      databaseUrl,
      port: 0,
    });

    expect(migrate).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(server.runtime).toBeUndefined();
    expect(server.adapterHost.status().runtime.reason).toBe(
      "database_unavailable",
    );
    expect((await server.app.inject("/healthz")).statusCode).toBe(200);
    await server.close();
    const serialized = JSON.stringify(stream.logs());
    expect(serialized).toContain('"phase":"database"');
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

    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
    const server = await startKaguyaServer({
      ...config(join(root, "database")),
      webDistPath,
      configRoot: root,
      port: 0,
    });

    expect(server.runtime).toBeUndefined();
    expect(server.adapterHost.status().runtime.reason).toBe(
      "runtime_start_failed",
    );
    expect((await server.app.inject("/healthz")).statusCode).toBe(200);
    await server.close();
    const serialized = JSON.stringify(stream.logs());
    expect(serialized).toContain('"phase":"runtime"');
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

  it.each([false, true])(
    "checks the database independently when AI is incomplete (database failure: %s)",
    async (databaseFails) => {
      const root = tempWorkspaceRoot();
      await FileUserConfigManager.bootstrap({ rootDir: root });
      const webDistPath = join(root, "web");
      mkdirSync(webDistPath, { recursive: true });
      writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
      const database = await createTestingDatabase();
      const migrate = vi.spyOn(database, "migrate");
      if (databaseFails)
        migrate.mockRejectedValueOnce(new Error("database-secret"));
      const connect = vi
        .spyOn(KaguyaDatabase, "connect")
        .mockResolvedValueOnce(database);
      const startRuntime = vi.spyOn(KaguyaRuntime.prototype, "start");
      const { NapCatConnectionSupervisor } = await import("./napcat.js");
      const startAdapter = vi
        .spyOn(NapCatConnectionSupervisor.prototype, "start")
        .mockResolvedValue();
      const serverConfig = config(root);
      const server = await startKaguyaServer({
        ...serverConfig,
        configRoot: root,
        webDistPath,
        port: 0,
        napcat: {
          ...serverConfig.napcat,
          enabled: true,
          wsUrl: "ws://localhost:3001",
        },
      });
      try {
        expect(connect).toHaveBeenCalledOnce();
        expect(migrate).toHaveBeenCalledOnce();
        expect(startRuntime).not.toHaveBeenCalled();
        expect(startAdapter).toHaveBeenCalledOnce();
        expect(server.adapterHost.status()).toMatchObject({
          adapterHostState: "running",
          runtime: {
            ingress: "runtime_unavailable",
            reason: "configuration_not_ready",
          },
        });
        expect(
          server.adapterHost
            .status()
            .adapters.every((adapter) => adapter.lifecycle === "running"),
        ).toBe(true);
        expect((await server.app.inject("/healthz")).statusCode).toBe(200);
      } finally {
        await server.close();
      }
    },
  );

  it("keeps Runtime and Web running with invalid NapCat configuration and drains after stopping ingress", async () => {
    const root = tempWorkspaceRoot();
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await manager.replaceProfile(
      "default",
      readyProfileReplacement(
        "default",
        readyProfileSettings("light", "heavy"),
      ),
    );
    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
    const database = await createTestingDatabase();
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    const serverConfig = config(root);
    const server = await startKaguyaServer({
      ...serverConfig,
      configRoot: root,
      webDistPath,
      port: 0,
      napcat: {
        ...serverConfig.napcat,
        enabled: true,
        configurationError: "configuration_invalid",
      },
    });
    expect(server.runtime).toBeDefined();
    expect(server.adapterHost.status().adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "napcat", lifecycle: "failed" }),
        expect.objectContaining({
          type: "web",
          lifecycle: "running",
          ingress: "ready",
        }),
      ]),
    );
    const order: string[] = [];
    const closeRuntime = server.runtime!.close.bind(server.runtime);
    vi.spyOn(server.runtime!, "close").mockImplementation(async () => {
      expect(server.adapterHost.status().runtime.ingress).toBe("stopping");
      expect(
        server.adapterHost.status().adapters.find((a) => a.type === "web")
          ?.lifecycle,
      ).toBe("stopped");
      order.push("runtime");
      await closeRuntime();
    });
    const closeDatabase = database.close.bind(database);
    vi.spyOn(database, "close").mockImplementation(async () => {
      order.push("database");
      await closeDatabase();
    });
    await server.close();
    expect(order).toEqual(["runtime", "database"]);
  });

  it("retains failed cleanup resources for the final shutdown attempt", async () => {
    const root = tempWorkspaceRoot();
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await manager.replaceProfile(
      "default",
      readyProfileReplacement(
        "default",
        readyProfileSettings("light", "heavy"),
      ),
    );
    const database = await createTestingDatabase();
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
      new Error("runtime failed"),
    );
    const runtimeClose = vi
      .spyOn(KaguyaRuntime.prototype, "close")
      .mockRejectedValueOnce(new Error("runtime cleanup failed"));
    const databaseClose = vi
      .spyOn(database, "close")
      .mockRejectedValueOnce(new Error("database cleanup failed"));
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    vi.spyOn(await import("@kaguya/logger"), "createLogger").mockReturnValue(
      rootLogger,
    );
    // Missing static assets deliberately fail HTTP preparation before any socket binding.
    await expect(
      startKaguyaServer({ ...config(root), configRoot: root, port: 0 }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtimeClose).toHaveBeenCalledTimes(2);
    expect(databaseClose).toHaveBeenCalledTimes(2);
    expect(stream.logs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "server.start.failed",
          phase: "web_ui",
          errorCode: "ENOENT",
        }),
      ]),
    );
  });

  it("classifies an occupied HTTP port as a listen failure", async () => {
    const root = tempWorkspaceRoot();
    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Expected a loopback TCP address");
    }
    const database = await createTestingDatabase();
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    vi.spyOn(await import("@kaguya/logger"), "createLogger").mockReturnValue(
      rootLogger,
    );

    try {
      await expect(
        startKaguyaServer({
          ...config(root),
          webDistPath,
          port: address.port,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(stream.logs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "server.start.failed",
            phase: "listen",
            errorCode: "EADDRINUSE",
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("classifies a platform adapter startup failure", async () => {
    const root = tempWorkspaceRoot();
    const webDistPath = join(root, "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya</main>");
    const database = await createTestingDatabase();
    vi.spyOn(KaguyaDatabase, "connect").mockResolvedValueOnce(database);
    const { NapCatConnectionSupervisor } = await import("./napcat.js");
    vi.spyOn(
      NapCatConnectionSupervisor.prototype,
      "start",
    ).mockRejectedValueOnce(
      Object.assign(new Error("adapter-token-secret"), {
        code: "ADAPTER_FAILED",
      }),
    );
    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    vi.spyOn(await import("@kaguya/logger"), "createLogger").mockReturnValue(
      rootLogger,
    );
    const serverConfig = config(root);

    const server = await startKaguyaServer({
      ...serverConfig,
      webDistPath,
      port: 0,
      napcat: {
        ...serverConfig.napcat,
        enabled: true,
        wsUrl: "ws://127.0.0.1:3001",
      },
    });
    expect(server.adapterHost.status().adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapterId: serverConfig.napcat.adapterId,
          lifecycle: "failed",
          errorType: "start_failed",
        }),
      ]),
    );
    await server.close();
    const serialized = JSON.stringify(stream.logs());
    expect(serialized).toContain('"phase":"adapter_start"');
    expect(serialized).not.toContain("adapter-token-secret");
  });

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
      providerId: "provider-1",
      modelId: "default-light",
      model: { modelId: "default-light" },
    });
    expect(resolver({ modelTier: "heavy" })).toEqual({
      providerId: "provider-1",
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
      providerId: "provider-1",
      modelId: "selected-light",
      model: { modelId: "selected-light" },
    });
    expect(resolver({ modelTier: "heavy" })).toEqual({
      providerId: "provider-1",
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
      providerId: "provider-1",
      modelId: "default-light",
      model: { modelId: "default-light" },
    });
    expect(chatModel).toHaveBeenCalledWith("default-light");
  });

  it("routes the same model id through its provider identity without losing audit metadata", async () => {
    const models = {
      light: createRepeatingDeterministicModel({ text: "from-provider-one" }),
      heavy: createRepeatingDeterministicModel({ text: "from-provider-two" }),
    };
    const composition = createReplyComposition(({ modelTier }) => ({
      providerId: modelTier === "light" ? "provider-one" : "provider-two",
      modelId: "shared-model",
      model: models[modelTier],
    }));
    const prompt: CompiledPrompt = {
      kind: "reply",
      text: "hello",
      fragments: [],
      provenance: [],
    };
    const outputSchema = z.object({ text: z.string() }).strict();
    let ready = 0;
    let release!: () => void;
    const bothResolved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (tier: "light" | "heavy") => {
      const identity = composition.modelTask.resolveModel({ tier });
      ready += 1;
      if (ready === 2) release();
      await bothResolved;
      const generation = await composition.modelTask.client.generate({
        modelId: identity.modelId,
        prompt,
        outputMode: "object",
        outputSchema,
      });
      return { identity, output: generation.output };
    };

    await expect(Promise.all([run("light"), run("heavy")])).resolves.toEqual([
      {
        identity: { providerId: "provider-one", modelId: "shared-model" },
        output: { text: "from-provider-one" },
      },
      {
        identity: { providerId: "provider-two", modelId: "shared-model" },
        output: { text: "from-provider-two" },
      },
    ]);
  });

  it("keeps Memory disabled unless composition explicitly enables it", () => {
    expect(createReplyComposition().memory).toEqual({ enabled: false });
    expect(
      createReplyComposition(undefined, { memoryEnabled: true }).memory,
    ).toEqual({ enabled: true });
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
