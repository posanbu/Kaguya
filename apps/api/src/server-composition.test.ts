import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { afterEach, describe, expect, it } from "vitest";

import { createApiGateway } from "./app.js";
import type { ApiGatewayConfig } from "./config.js";
import { createConfiguredMessageIngress } from "./server.js";

const gatewayToken = "test-gateway-token-12345";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "kaguya-api-composition-"));
  roots.push(root);
  return join(root, "kaguya.sqlite");
}

function config(databasePath: string): ApiGatewayConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    gatewayToken,
    corsOrigins: ["http://localhost:5173"],
    trustProxy: false,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    databasePath,
  };
}

describe("API server composition", () => {
  it("injects a local core ingress that persists Web UI messages", async () => {
    const databasePath = tempDatabasePath();
    const ingress = createConfiguredMessageIngress(config(databasePath));
    const app = await createApiGateway({
      config: config(databasePath),
      messageIngress: ingress,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "x-request-id": "request-api-1",
      },
      payload: {
        sessionId: "web-session-api",
        text: "Hello from the browser",
      },
    });

    expect(response.statusCode).toBe(202);
    await app.close();
    ingress.close();

    const database = KaguyaDatabase.open(databasePath);
    try {
      const messages = database.messages.listRecent("web-session-api", 10);
      expect(messages.map((message) => message.role).sort()).toEqual([
        "assistant",
        "user",
      ]);
      expect(
        database.llmTraces.listByTrace("webui-request-api-1"),
      ).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
