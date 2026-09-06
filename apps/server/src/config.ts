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

export function readConfigRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return optionalText(environment.KAGUYA_CONFIG_ROOT) ?? defaultConfigRoot;
}

export function defaultServerConfig(configRoot = defaultConfigRoot): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    gatewayToken: "invalid-unconfigured-gateway-token",
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    databasePath: defaultDatabasePath,
    configRoot,
    development: false,
    webDistPath: defaultWebDistPath,
    gatewayAllowlist: { platforms: [], userIds: [], groupIds: [] },
    napcat: {
      enabled: false,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
    },
  };
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
