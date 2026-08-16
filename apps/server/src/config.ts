import { fileURLToPath } from "node:url";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../.data/kaguya.sqlite", import.meta.url),
);
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
  readonly databasePath: string;
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
  const gatewayToken = requiredEnvironmentValue(
    environment,
    "KAGUYA_GATEWAY_TOKEN",
  );
  if (gatewayToken.length < 16) {
    throw new Error("KAGUYA_GATEWAY_TOKEN must contain at least 16 characters");
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

  return {
    host: optionalText(environment.KAGUYA_HOST) ?? "127.0.0.1",
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
    databasePath:
      optionalText(environment.KAGUYA_DATABASE_PATH) ?? defaultDatabasePath,
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

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = optionalText(environment[name]);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
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
