import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { FileUserConfigManager } from "@kaguya/config";
import { KaguyaRuntime } from "@kaguya/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createRuntimeModelSelectionResolver } from "./server.js";
import { registerWebUi } from "./web.js";

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
      messageIngress: runtime,
      sessionMessages: runtime,
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
        sessionId: "composition-session",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: { status: "accepted", sessionId: "composition-session" },
    });
    await app.close();
    await runtime.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      expect(
        database.messages.listRecent(10).map((message) => message.role),
      ).toEqual(["assistant", "user"]);
      expect(
        database.messages
          .listBySession("composition-session", 10)
          .map((message) => message.role),
      ).toEqual(["user", "assistant"]);
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

  it("creates a heavy/light resolver from frozen profile configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-profile-resolver-"));
    roots.push(root);
    const manager = await FileUserConfigManager.initialize({
      rootDir: root,
      name: "test",
      settings: {
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
              settings: {},
            },
          ],
        },
        platforms: [],
        plugins: [],
      },
      acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
    });
    const incomplete = await manager.createProfile("incomplete");

    const resolver = await createRuntimeModelSelectionResolver(root);

    expect(resolver({ modelTier: "heavy" })).toEqual({
      modelId: "heavy-model",
      model: { modelId: "heavy-model" },
    });
    expect(chatModel).toHaveBeenCalledWith("heavy-model");
    expect(() =>
      resolver({ profileId: incomplete.id, modelTier: "heavy" }),
    ).toThrow("Configuration is incomplete");
  });

  it("passes structured-output support from profile provider settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-profile-resolver-"));
    roots.push(root);
    await FileUserConfigManager.initialize({
      rootDir: root,
      name: "test",
      settings: {
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
      },
      acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
    });

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
});

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
