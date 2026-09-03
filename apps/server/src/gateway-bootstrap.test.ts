/**
 * 功能概述：验证 Issue #44 的首次配置 HTTP 闭环：bootstrap 凭据只能写入首次
 * 配置，成功后返回一次正式 Gateway Token，并立即撤销 bootstrap 权限。
 * 主要职责：通过真实 `ConfigurationManagement`、Fastify 注入和凭据文件，覆盖
 * setup 写入、Token 轮换、普通管理权限以及 `/api/v1/setup` 无密钥响应。
 * 代码库关系：连接 `app.ts`、`setup.ts`、`gateway-auth.ts` 与
 * `gateway-credentials.ts`，使用 `packages/config` 的真实 Profile Registry。
 * 输入输出与副作用：所有配置和数据库路径均为临时目录；响应只断言正式 Token
 * 出现在首次成功响应中，不把 Token 写入日志或普通 readiness 响应。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createBootstrapGatewayAuthenticator } from "./gateway-auth.js";
import { loadPersistentGatewayCredential } from "./gateway-credentials.js";
import { createConfigurationManagement } from "./setup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("first-run gateway bootstrap", () => {
  it("returns a persistent token once and expires bootstrap authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-bootstrap-"));
    roots.push(root);
    const management = await createConfigurationManagement(join(root, "config"));
    const auth = await createBootstrapGatewayAuthenticator(join(root, "config"));
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 3000,
      gatewayToken: "unused-test-token-12345",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      databasePath: join(root, "kaguya.sqlite"),
      configRoot: join(root, "config"),
      development: false,
      webDistPath: join(root, "web"),
      gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
      napcat: { enabled: false, adapterId: "napcat.qq.main", reconnectMs: 3000 },
    };
    const app = await createHttpApplication({ config, setup: management, gatewayAuth: auth });

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { authorization: `Bearer ${auth.bootstrapToken}` },
      payload: {
        profileName: "default",
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        lightModel: "light-model",
        heavyModel: "heavy-model",
      },
    });

    expect(setup.statusCode).toBe(200);
    const persistentToken = setup.json().data.gatewayToken as string;
    expect(persistentToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);

    const readiness = await app.inject({ method: "GET", url: "/api/v1/setup" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.body).not.toContain("gatewayToken");
    expect(await auth.authorize(auth.bootstrapToken!, "setup")).toBe(false);
    expect(await auth.authorize(persistentToken, "management")).toBe(true);
    expect(await loadPersistentGatewayCredential(join(root, "config"))).not.toBeNull();
    await app.close();
  });
});
