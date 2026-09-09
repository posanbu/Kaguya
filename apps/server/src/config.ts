/**
 * 功能概述：把 selected Profile 的 runtime/platform 配置转换为 Server 唯一启动配置。
 * 主要职责：环境只定位 Profile Registry 并选择开发模式；host、port、PostgreSQL、
 * Web、限流、日志、allowlist 与 NapCat 全部来自 selected Profile。Gateway Token 每次
 * 进程启动随机生成，不持久化。旧运行环境变量会被按名称拒绝且从不回显值。
 * 代码库关系：server.ts 在创建 HTTP、Runtime 或 adapter 前调用本模块；开发 PostgreSQL
 * CLI 也复用相同 runtime schema，但容器生命周期不进入生产 Server。
 * 输入输出与副作用：除安全随机数外无 I/O；错误只包含稳定字段名，不包含 URL 或凭据。
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  runtimeConfigSchema,
  type RuntimeConfig,
  type UserConfigProfile,
} from "@kaguya/config";

const defaultConfigRoot = fileURLToPath(
  new URL("../../../.data/kaguya-config", import.meta.url),
);

const retiredRuntimeEnvironmentVariables = [
  "KAGUYA_DATABASE_URL",
  "KAGUYA_HOST",
  "KAGUYA_PORT",
  "KAGUYA_GATEWAY_TOKEN",
  "KAGUYA_CORS_ORIGINS",
  "KAGUYA_TRUST_PROXY",
  "KAGUYA_RATE_LIMIT_MAX",
  "KAGUYA_RATE_LIMIT_WINDOW_MS",
  "KAGUYA_WEB_DIST_PATH",
  "KAGUYA_GATEWAY_ALLOWLIST_PLATFORMS",
  "KAGUYA_GATEWAY_ALLOWLIST_USER_IDS",
  "KAGUYA_GATEWAY_ALLOWLIST_GROUP_IDS",
  "KAGUYA_NAPCAT_ENABLED",
  "KAGUYA_NAPCAT_WS_URL",
  "KAGUYA_NAPCAT_ACCESS_TOKEN",
  "KAGUYA_NAPCAT_SELF_ID",
  "KAGUYA_NAPCAT_RECONNECT_MS",
  "KAGUYA_LOG_LEVEL",
  "KAGUYA_LOG_LEVELS",
  "KAGUYA_LOG_FORMAT",
  "KAGUYA_LOG_ASYNC",
  "KAGUYA_LOG_DESTINATION",
  "KAGUYA_API_HOST",
  "KAGUYA_API_PORT",
  "KAGUYA_API_DATABASE_PATH",
  "KAGUYA_BOT_DATABASE_PATH",
  "KAGUYA_LLM_API_KEY",
  "KAGUYA_LLM_BASE_URL",
  "KAGUYA_LLM_MODEL",
] as const;

export interface ServerBootstrapConfig {
  readonly configRoot: string;
  readonly development: boolean;
}

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
  readonly logLevel: RuntimeConfig["logLevel"];
  readonly logFormat: RuntimeConfig["logFormat"];
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
  readonly configurationError?: "configuration_invalid";
  readonly adapterId: string;
  readonly wsUrl?: string;
  readonly accessToken?: string;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export class ServerRuntimeConfigurationError extends Error {
  constructor(message = "Selected Profile runtime configuration is invalid") {
    super(message);
    this.name = "ServerRuntimeConfigurationError";
  }
}

export function readServerBootstrapConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerBootstrapConfig {
  rejectRetiredRuntimeEnvironment(environment);
  return {
    configRoot:
      optionalText(environment.KAGUYA_CONFIG_ROOT) ?? defaultConfigRoot,
    development: environment.NODE_ENV === "development",
  };
}

export function createServerConfig(
  profile: UserConfigProfile,
  bootstrap: ServerBootstrapConfig,
  nextGatewayToken: () => string = () => randomBytes(32).toString("base64url"),
): ServerConfig {
  const result = runtimeConfigSchema.safeParse(profile.runtime);
  if (!result.success) throw new ServerRuntimeConfigurationError();
  const runtime = result.data;
  assertLoopbackHost(runtime.host);
  return {
    host: runtime.host,
    port: runtime.port,
    gatewayToken: nextGatewayToken(),
    corsOrigins: runtime.corsOrigins,
    trustProxy: runtime.trustProxy,
    rateLimitMax: runtime.rateLimitMax,
    rateLimitWindowMs: runtime.rateLimitWindowMs,
    databaseUrl: runtime.databaseUrl,
    configRoot: bootstrap.configRoot,
    development: bootstrap.development,
    webDistPath: runtime.webDistPath,
    logLevel: runtime.logLevel,
    logFormat: runtime.logFormat,
    gatewayAllowlist: runtime.gatewayAllowlist,
    napcat: inspectNapCatConfig(profile),
  };
}

export function assertLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new ServerRuntimeConfigurationError(
      "Selected Profile runtime host must be loopback",
    );
  }
}

export function inspectNapCatConfig(profile: UserConfigProfile): NapCatConfig {
  try {
    return readNapCatConfig(profile);
  } catch {
    return {
      enabled: true,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
      configurationError: "configuration_invalid",
    };
  }
}

function readNapCatConfig(profile: UserConfigProfile): NapCatConfig {
  const configured = profile.platforms.filter(
    ({ enabled, type }) => enabled && type === "napcat",
  );
  if (configured.length === 0) {
    return {
      enabled: false,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
    };
  }
  if (configured.length !== 1) {
    throw new ServerRuntimeConfigurationError(
      "Selected Profile must enable at most one NapCat platform",
    );
  }
  const platform = configured[0]!;
  const adapterId = stringSetting(platform.settings.adapterId);
  const wsUrl = stringSetting(platform.settings.wsUrl);
  const selfId = stringSetting(platform.settings.selfId);
  const reconnectMs = numberSetting(platform.settings.reconnectMs);
  const accessToken = stringSetting(platform.credentials.accessToken);
  if (
    adapterId === undefined ||
    adapterId === "web.ui.main" ||
    wsUrl === undefined ||
    reconnectMs === undefined ||
    !Number.isInteger(reconnectMs) ||
    reconnectMs < 100 ||
    reconnectMs > 3_600_000
  ) {
    throw new ServerRuntimeConfigurationError(
      "Selected Profile NapCat configuration is invalid",
    );
  }
  try {
    const protocol = new URL(wsUrl).protocol;
    if (protocol !== "ws:" && protocol !== "wss:") throw new Error();
  } catch {
    throw new ServerRuntimeConfigurationError(
      "Selected Profile NapCat WebSocket URL is invalid",
    );
  }
  return {
    enabled: true,
    adapterId,
    wsUrl,
    reconnectMs,
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(selfId === undefined ? {} : { selfId }),
  };
}

function rejectRetiredRuntimeEnvironment(environment: NodeJS.ProcessEnv): void {
  const configured = retiredRuntimeEnvironmentVariables.filter(
    (name) => environment[name] !== undefined,
  );
  if (configured.length > 0) {
    throw new ServerRuntimeConfigurationError(
      `${configured.join(", ")} are no longer supported; configure the selected Profile runtime`,
    );
  }
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
