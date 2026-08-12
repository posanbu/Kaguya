import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { KaguyaRuntime } from "@kaguya/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { registerWebUi } from "./web.js";

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
    development: false,
    webDistPath: join(dirnameOf(databasePath), "web"),
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
        sessionId: "web-session-server",
        text: "Hello from the browser",
      },
    });

    expect(response.statusCode).toBe(202);
    await app.close();
    await runtime.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      expect(
        database.messages
          .listRecent("web-session-server", 10)
          .map((message) => message.role)
          .sort(),
      ).toEqual(["assistant", "user"]);
      expect(
        database.llmTraces.listByTrace("webui-request-server-1"),
      ).toHaveLength(2);
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
});

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
