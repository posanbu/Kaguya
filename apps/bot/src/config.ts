import { fileURLToPath } from "node:url";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../.data/kaguya-bot.sqlite", import.meta.url),
);

export interface BotConfig {
  readonly databasePath: string;
  readonly napcat: NapCatConfig;
}

export interface NapCatConfig {
  readonly enabled: boolean;
  readonly adapterId: string;
  readonly wsUrl?: string;
  readonly accessToken?: string;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export function readBotConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BotConfig {
  const enabled = environment.KAGUYA_NAPCAT_ENABLED?.trim() === "true";
  const wsUrl = optionalText(environment.KAGUYA_NAPCAT_WS_URL);
  if (enabled && wsUrl === undefined) {
    throw new Error(
      "KAGUYA_NAPCAT_WS_URL is required when KAGUYA_NAPCAT_ENABLED=true",
    );
  }

  const accessToken = optionalText(environment.KAGUYA_NAPCAT_ACCESS_TOKEN);
  const selfId = optionalText(environment.KAGUYA_NAPCAT_SELF_ID);

  return {
    databasePath:
      optionalText(environment.KAGUYA_BOT_DATABASE_PATH) ?? defaultDatabasePath,
    napcat: {
      enabled,
      adapterId: "napcat.qq.main",
      ...(wsUrl === undefined ? {} : { wsUrl }),
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(selfId === undefined ? {} : { selfId }),
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

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
