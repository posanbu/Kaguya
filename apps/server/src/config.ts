/**
 * 功能概述：把进程环境解析为统一 `ServerConfig`，并把必需的
 * PostgreSQL information ledger URL 作为启动前置条件，彻底移除 SQLite path 默认。
 * 主要职责：`readServerConfig` 校验/生成 gateway token，解析 host、port、
 * CORS、proxy、限流、config/web 路径、allowlist 与 NapCat，并要求非空
 * `KAGUYA_DATABASE_URL`；helper 负责文本、列表和整数边界的一致处理。
 * 代码库关系：`server.ts` 消费 `databaseUrl` 并创建 `KaguyaDatabase`；
 * `app.ts`、`web.ts` 和 NapCat supervisor 复用同一份其余配置。
 * 输入输出与副作用：除了使用安全随机数生成缺失的 token 外无 I/O；
 * 错误只命名非法/旧配置项，绝不回显 URL、token 或其他环境变量值。
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const defaultWebDistPath = fileURLToPath(
  new URL("../../web/dist", import.meta.url),
);
const defaultConfigRoot = fileURLToPath(
  new URL("../../../.data/kaguya-config", import.meta.url),
);
const legacyEnvironmentVariables = [
  "KAGUYA_API_HOST",
  "KAGUYA_API_PORT",
  "KAGUYA_API_DATABASE_PATH",
  "KAGUYA_BOT_DATABASE_PATH",
  "KAGUYA_LLM_API_KEY",
  "KAGUYA_LLM_BASE_URL",
  "KAGUYA_LLM_MODEL",
] as const;

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly gatewayToken: string;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: false | string[];
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly databaseUrl: string;
  readonly configRoot: string;
  readonly development: boolean;
  readonly webDistPath: string;
  readonly gatewayAllowlist: GatewayAllowlistConfig;
  readonly napcat: NapCatConfig;
}

export interface GatewayAllowlistConfig {
  readonly platforms: readonly string[];
  readonly userIds: readonly string[];
  readonly groupIds: readonly string[];
}

export interface NapCatConfig {
  readonly enabled: boolean;
  readonly adapterId: string;
  readonly wsUrl?: string;
  readonly accessToken?: string;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export function readServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  rejectLegacyEnvironment(environment);
  const gatewayToken = randomBytes(32).toString("base64url");
  const databaseUrl = optionalText(environment.KAGUYA_DATABASE_URL);
  if (databaseUrl === undefined) {
    throw new Error("KAGUYA_DATABASE_URL is required");
  }

  const napcatEnabled = environment.KAGUYA_NAPCAT_ENABLED?.trim() === "true";
  const napcatWsUrl = optionalText(environment.KAGUYA_NAPCAT_WS_URL);
  const napcatAccessToken = optionalText(
    environment.KAGUYA_NAPCAT_ACCESS_TOKEN,
  );
  const napcatSelfId = optionalText(environment.KAGUYA_NAPCAT_SELF_ID);
  if (napcatEnabled && napcatWsUrl === undefined) {
    throw new Error(
      "KAGUYA_NAPCAT_WS_URL is required when KAGUYA_NAPCAT_ENABLED=true",
    );
  }

  const host = optionalText(environment.KAGUYA_HOST) ?? "127.0.0.1";
  assertLoopbackHost(host);
  return {
    host,
    port: integerEnvironmentValue(
      environment.KAGUYA_PORT,
      3000,
      1,
      65_535,
      "KAGUYA_PORT",
    ),
    gatewayToken,
    corsOrigins: commaSeparatedValues(environment.KAGUYA_CORS_ORIGINS ?? ""),
    trustProxy: optionalListEnvironmentValue(environment.KAGUYA_TRUST_PROXY),
    rateLimitMax: integerEnvironmentValue(
      environment.KAGUYA_RATE_LIMIT_MAX,
      30,
      1,
      10_000,
      "KAGUYA_RATE_LIMIT_MAX",
    ),
    rateLimitWindowMs: integerEnvironmentValue(
      environment.KAGUYA_RATE_LIMIT_WINDOW_MS,
      60_000,
      1_000,
      3_600_000,
      "KAGUYA_RATE_LIMIT_WINDOW_MS",
    ),
    databaseUrl,
    configRoot:
      optionalText(environment.KAGUYA_CONFIG_ROOT) ?? defaultConfigRoot,
    development: environment.NODE_ENV === "development",
    webDistPath:
      optionalText(environment.KAGUYA_WEB_DIST_PATH) ?? defaultWebDistPath,
    gatewayAllowlist: {
      platforms: commaSeparatedValues(
        environment.KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS ?? "",
      ),
      userIds: commaSeparatedValues(
        environment.KAGUYA_GATEWAY_ALLOWLIST_USER_IDS ?? "",
      ),
      groupIds: commaSeparatedValues(
        environment.KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS ?? "",
      ),
    },
    napcat: {
      enabled: napcatEnabled,
      adapterId: "napcat.qq.main",
      ...(napcatWsUrl === undefined ? {} : { wsUrl: napcatWsUrl }),
      ...(napcatAccessToken === undefined
        ? {}
        : { accessToken: napcatAccessToken }),
      ...(napcatSelfId === undefined ? {} : { selfId: napcatSelfId }),
      reconnectMs: integerEnvironmentValue(
        environment.KAGUYA_NAPCAT_RECONNECT_MS,
        3000,
        100,
        3_600_000,
        "KAGUYA_NAPCAT_RECONNECT_MS",
      ),
    },
  };
}

export function assertLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("KAGUYA_HOST must be 127.0.0.1, localhost, or ::1");
  }
}

function rejectLegacyEnvironment(environment: NodeJS.ProcessEnv): void {
  const configured = legacyEnvironmentVariables.filter(
    (name) => environment[name] !== undefined,
  );
  if (configured.length > 0) {
    throw new Error(
      `${configured.join(", ")} are no longer supported; use KAGUYA_CONFIG_ROOT and profile configuration`,
    );
  }
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function commaSeparatedValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function optionalListEnvironmentValue(
  value: string | undefined,
): false | string[] {
  const values = commaSeparatedValues(value ?? "");
  return values.length === 0 ? false : values;
}

function integerEnvironmentValue(
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const normalized = optionalText(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
