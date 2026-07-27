export interface ApiGatewayConfig {
  host: string;
  port: number;
  gatewayToken: string;
  corsOrigins: readonly string[];
  trustProxy: false | string[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

export function readApiGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiGatewayConfig {
  const gatewayToken = requiredEnvironmentValue(
    environment,
    "KAGUYA_GATEWAY_TOKEN",
  );
  if (gatewayToken.length < 16) {
    throw new Error("KAGUYA_GATEWAY_TOKEN must contain at least 16 characters");
  }

  return {
    host: environment.KAGUYA_API_HOST?.trim() || "127.0.0.1",
    port: integerEnvironmentValue(
      environment,
      "KAGUYA_API_PORT",
      3000,
      1,
      65_535,
    ),
    gatewayToken,
    corsOrigins: commaSeparatedValues(
      environment.KAGUYA_CORS_ORIGINS ??
        "http://localhost:5173,http://127.0.0.1:5173",
    ),
    trustProxy: optionalListEnvironmentValue(environment, "KAGUYA_TRUST_PROXY"),
    rateLimitMax: integerEnvironmentValue(
      environment,
      "KAGUYA_RATE_LIMIT_MAX",
      30,
      1,
      10_000,
    ),
    rateLimitWindowMs: integerEnvironmentValue(
      environment,
      "KAGUYA_RATE_LIMIT_WINDOW_MS",
      60_000,
      1_000,
      3_600_000,
    ),
  };
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
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
  environment: NodeJS.ProcessEnv,
  name: string,
): false | string[] {
  const values = commaSeparatedValues(environment[name] ?? "");
  return values.length === 0 ? false : values;
}

function integerEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
