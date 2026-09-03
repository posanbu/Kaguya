/**
 * 功能概述：验证统一 Server 环境变量的解析与拒绝边界，其中
 * PostgreSQL information ledger URL 是强制启动配置，SQLite path 不再受支持。
 * 主要职责：覆盖 host/port/CORS/proxy/限流/NapCat/allowlist 解析、
 * 网关 token 生成、必填 `KAGUYA_DATABASE_URL` 与旧环境变量的脱敏拒绝。
 * 代码库关系：直接测试 `config.ts`；`server.ts` 消费 `ServerConfig.databaseUrl`
 * 建立 information database，HTTP 应用只消费其余服务配置。
 * 输入输出与副作用：每个用例传入隔离的 `ProcessEnv` 对象，不读写真实环境；
 * 任何错误消息均不得包含配置值或凭据。
 */
import { describe, expect, it } from "vitest";

import { readServerConfig } from "./config.js";

const databaseUrl = "postgresql://kaguya:secret@db.example:5432/kaguya";

describe("readServerConfig", () => {
  it("parses unified server and NapCat configuration", () => {
    const config = readServerConfig({
      NODE_ENV: "development",
      KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
      KAGUYA_HOST: "0.0.0.0",
      KAGUYA_PORT: "4100",
      KAGUYA_CORS_ORIGINS: "https://ui.example, https://ui.example",
      KAGUYA_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8",
      KAGUYA_RATE_LIMIT_MAX: "20",
      KAGUYA_RATE_LIMIT_WINDOW_MS: "10000",
      KAGUYA_DATABASE_URL: databaseUrl,
      KAGUYA_CONFIG_ROOT: "/tmp/kaguya-config-test",
      KAGUYA_NAPCAT_ENABLED: "true",
      KAGUYA_NAPCAT_WS_URL: "ws://127.0.0.1:3001",
      KAGUYA_NAPCAT_RECONNECT_MS: "500",
      KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS: "qq, qq",
      KAGUYA_GATEWAY_ALLOWLIST_USER_IDS: "user-1, user-2",
      KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS: "group-1",
    });

    expect(config).toMatchObject({
      gatewayTokenSource: "environment",
      config: {
        host: "0.0.0.0",
        port: 4100,
        gatewayToken: "a-secure-gateway-token",
        corsOrigins: ["https://ui.example"],
        trustProxy: ["127.0.0.1", "10.0.0.0/8"],
        rateLimitMax: 20,
        rateLimitWindowMs: 10_000,
        databaseUrl,
        configRoot: "/tmp/kaguya-config-test",
        development: true,
        gatewayAllowlist: {
          platforms: ["qq"],
          userIds: ["user-1", "user-2"],
          groupIds: ["group-1"],
        },
        napcat: {
          enabled: true,
          adapterId: "napcat.qq.main",
          wsUrl: "ws://127.0.0.1:3001",
          reconnectMs: 500,
        },
      },
    });
  });

  it("requires the PostgreSQL information ledger URL", () => {
    expect(() =>
      readServerConfig({
        KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
      }),
    ).toThrow("KAGUYA_DATABASE_URL is required");
    expect(() =>
      readServerConfig({
        KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
        KAGUYA_DATABASE_URL: "   ",
      }),
    ).toThrow("KAGUYA_DATABASE_URL is required");
  });

  it("rejects legacy split-service variables", () => {
    for (const name of [
      "KAGUYA_API_HOST",
      "KAGUYA_API_PORT",
      "KAGUYA_API_DATABASE_PATH",
      "KAGUYA_BOT_DATABASE_PATH",
      "KAGUYA_DATABASE_PATH",
    ]) {
      expect(() =>
        readServerConfig({
          KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
          KAGUYA_DATABASE_URL: databaseUrl,
          [name]: "legacy-value",
        }),
      ).toThrow("no longer supported");
    }
  });

  it("generates a random token when KAGUYA_GATEWAY_TOKEN is unset", () => {
    const resolved = readServerConfig({ KAGUYA_DATABASE_URL: databaseUrl });

    expect(resolved.gatewayTokenSource).toBe("generated");
    expect(resolved.config.gatewayToken).toMatch(/^[A-Za-z0-9_-]{16,}$/u);
    expect(
      readServerConfig({ KAGUYA_DATABASE_URL: databaseUrl }).config
        .gatewayToken,
    ).not.toBe(resolved.config.gatewayToken);
  });

  it("requires a non-trivial token and a URL for enabled NapCat", () => {
    expect(() =>
      readServerConfig({
        KAGUYA_GATEWAY_TOKEN: "short",
        KAGUYA_DATABASE_URL: databaseUrl,
      }),
    ).toThrow("at least 16 characters");
    expect(() =>
      readServerConfig({
        KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
        KAGUYA_DATABASE_URL: databaseUrl,
        KAGUYA_NAPCAT_ENABLED: "true",
      }),
    ).toThrow("KAGUYA_NAPCAT_WS_URL is required");
  });

  it("rejects legacy LLM environment configuration without exposing values", () => {
    for (const name of [
      "KAGUYA_LLM_API_KEY",
      "KAGUYA_LLM_BASE_URL",
      "KAGUYA_LLM_MODEL",
    ]) {
      expect(() =>
        readServerConfig({
          KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
          KAGUYA_DATABASE_URL: databaseUrl,
          [name]: "must-not-appear",
        }),
      ).toThrow("KAGUYA_CONFIG_ROOT");
      try {
        readServerConfig({
          KAGUYA_GATEWAY_TOKEN: "a-secure-gateway-token",
          KAGUYA_DATABASE_URL: databaseUrl,
          [name]: "must-not-appear",
        });
      } catch (error) {
        expect(String(error)).not.toContain("must-not-appear");
      }
    }
  });
});
