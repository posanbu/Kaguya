/**
 * 功能概述：本文件验证服务层组合逻辑，确保 HTTP、Web UI、Runtime 与配置 Profile
 * Registry 在统一启动流程下按预期协作，尤其覆盖启动期构造的模型解析器如何从配置中
 * 冻结一个已选中的 Profile 并向 Runtime 暴露仅含 tier 的解析接口。
 * 主要职责：前半部分用例覆盖 Web/API/Vite 路由组合与启动失败路径；Profile 解析器
 * 相关用例验证 `createRuntimeModelSelectionResolver` 会在服务启动时读取当前
 * selected Profile、校验 light/heavy tier、保留 provider 能力设置，并拒绝模块或
 * 调用方继续传入 `profileId`。
 * 代码库关系：测试直接驱动 `server.ts`、`app.ts` 与 `web.ts`，并借助
 * `@kaguya/config` 的真实文件型 Registry、`@kaguya/runtime` 的共享 Runtime、
 * `@ai-sdk/openai-compatible` 的 mock 客户端观察 provider client 创建行为。
 * 输入输出与副作用：每个用例都在临时目录中创建数据库与配置根目录，结束后删除；
 * 若服务层重新引入按请求切换 Profile、重新扫描全部 Profile、或在错误路径中泄露配置细节，
 * 本文件会作为回归测试立即失败。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { KaguyaDatabase } from "@kaguya/database";
import { FileUserConfigManager } from "@kaguya/config";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
} from "@kaguya/logger";
import { KaguyaRuntime, type RuntimeModelSelectionResolver } from "@kaguya/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createRuntimeModelSelectionResolver, startKaguyaServer } from "./server.js";
import { registerWebUi } from "./web.js";
import { llmReplySettingsSchema } from "../../../packages/modules/src/llm-reply.js";

const chatModel = vi.fn((modelId: string) => ({ modelId }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({ chatModel })),
}));

const gatewayToken = "test-gateway-token-12345";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-server-composition-"));
  roots.push(root);
  return join(root, "kaguya.sqlite");
}

function config(databasePath: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    gatewayToken,
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    databasePath,
    configRoot: join(dirnameOf(databasePath), "config"),
    development: false,
    webDistPath: join(dirnameOf(databasePath), "web"),
    gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
    napcat: {
      enabled: false,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
    },
  };
}

describe("unified server composition", () => {
  it("dispatches Web messages through the shared Runtime", async () => {
    const databasePath = tempDatabasePath();
    const runtime = new KaguyaRuntime({ databasePath });
    await runtime.start();
    const app = await createHttpApplication({
      config: config(databasePath),
      runtime,
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
    await app.close();
    await runtime.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      expect(
        database.messages.listRecent(10).map((message) => message.role),
      ).toEqual(["user"]);
      expect(
        database.llmTraces.listByTrace("webui-request-server-1"),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("serves the Web UI, health, OpenAPI, and SPA fallback on one app", async () => {
    const databasePath = tempDatabasePath();
    const webDistPath = join(dirnameOf(databasePath), "web");
    mkdirSync(webDistPath, { recursive: true });
    writeFileSync(join(webDistPath, "index.html"), "<main>Kaguya UI</main>");
    writeFileSync(join(webDistPath, "app.js"), "globalThis.kaguya = true;");
    const serverConfig = { ...config(databasePath), webDistPath };
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
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ error: { code: "not_found" } });

    await app.close();
    await webUi.close();
  });

  it("keeps API and health routes ahead of Vite middleware in development", async () => {
    const databasePath = tempDatabasePath();
    const serverConfig = { ...config(databasePath), development: true };
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
    const databasePath = tempDatabasePath();
    const configRoot = join(dirnameOf(databasePath), "config");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "index.json"), JSON.stringify({ version: 2 }));

    const stream = new LogStream();
    const rootLogger = createLogger({ service: "kaguya-server-test", stream });
    const createLoggerSpy = vi
      .spyOn(await import("@kaguya/logger"), "createLogger")
      .mockReturnValue(rootLogger);
    const closeLoggerSpy = vi.spyOn(await import("@kaguya/logger"), "closeLogger");

    const error = await startKaguyaServer({
      ...config(databasePath),
      configRoot,
      webDistPath: join(dirnameOf(databasePath), "web"),
    }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "CONFIG_UNSUPPORTED_VERSION" });
    expect(createLoggerSpy).toHaveBeenCalledTimes(1);
    expect(closeLoggerSpy).toHaveBeenCalledWith(rootLogger);
    expect(stream.logs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "server.start.failed", level: "fatal" }),
        expect.objectContaining({ event: "server.stopping", level: "info" }),
        expect.objectContaining({ event: "server.stopped", level: "info" }),
      ]),
    );

    createLoggerSpy.mockRestore();
    closeLoggerSpy.mockRestore();
    await closeLogger(rootLogger);
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
    await manager.acknowledgeConfigurationWarnings(manager.getSelectedProfileId(), [
      "platforms-empty",
      "plugins-empty",
    ]);
    await manager.createProfile("incomplete");

    const resolver = await createRuntimeModelSelectionResolver(root);

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
    await manager.acknowledgeConfigurationWarnings(manager.getSelectedProfileId(), [
      "platforms-empty",
      "plugins-empty",
    ]);
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

    const resolver = await createRuntimeModelSelectionResolver(root);
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
    await manager.acknowledgeConfigurationWarnings(manager.getSelectedProfileId(), [
      "platforms-empty",
      "plugins-empty",
    ]);

    await createRuntimeModelSelectionResolver(root);

    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ supportsStructuredOutputs: true }),
    );
  });

  it("rejects a missing profile store before creating provider clients", async () => {
    const parent = mkdtempSync(join(tmpdir(), "kaguya-missing-profile-"));
    roots.push(parent);

    await expect(
      createRuntimeModelSelectionResolver(join(parent, "missing")),
    ).rejects.toMatchObject({ code: "CONFIG_SETUP_REQUIRED" });
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
    await manager.acknowledgeConfigurationWarnings(manager.getSelectedProfileId(), [
      "platforms-empty",
      "plugins-empty",
    ]);
    const resolver: RuntimeModelSelectionResolver =
      await createRuntimeModelSelectionResolver(root);

    expect(
      llmReplySettingsSchema.safeParse({
        profileId: "profile-override",
        modelTier: "light",
        outbound: { mode: "source", messageKind: "text" },
      }).success,
    ).toBe(false);
    // @ts-expect-error Runtime selections are tier-only and cannot carry a profile override.
    const invalidSelection: Parameters<RuntimeModelSelectionResolver>[0] = { profileId: "profile-override", modelTier: "light" };
    expect(invalidSelection.modelTier).toBe("light");
    expect(resolver({ modelTier: "light" })).toEqual({
      modelId: "default-light",
      model: { modelId: "default-light" },
    });
    expect(chatModel).toHaveBeenCalledWith("default-light");
  });
});

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
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
