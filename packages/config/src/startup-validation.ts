import { ConfigError } from "./errors.js";
import { FileUserConfigManager } from "./manager.js";
import {
  inspectUserConfigProfile,
  type ConfigurationIssue,
} from "./readiness.js";
import {
  runtimeConfigSchema,
  type UserConfigProfile,
  type RuntimeConfig,
} from "./model.js";

export interface StartupConfigurationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly hint?: string;
}

export interface ValidatedStartupConfiguration {
  readonly configRoot: string;
  readonly selectedProfileId: UserConfigProfile["id"];
  readonly profile: UserConfigProfile;
  readonly runtime: RuntimeConfig;
}

export class StartupConfigurationError extends Error {
  readonly code: string;
  readonly issues: readonly StartupConfigurationIssue[];
  readonly configRoot: string;
  readonly profileId: string | undefined;
  override readonly cause: unknown;

  constructor(
    configRoot: string,
    issues: readonly StartupConfigurationIssue[],
    options: { profileId?: string; cause?: unknown } = {},
  ) {
    super("Startup configuration validation failed", {
      cause: options.cause,
    });
    this.name = "StartupConfigurationError";
    this.code = issues[0]?.code ?? "CONFIGURATION_INVALID";
    this.configRoot = configRoot;
    this.issues = issues.map((issue) => ({ ...issue }));
    this.profileId = options.profileId;
    this.cause = options.cause;
  }
}

export async function validateStartupConfiguration(options: {
  readonly rootDir: string;
}): Promise<ValidatedStartupConfiguration> {
  let manager: FileUserConfigManager;
  try {
    manager = await FileUserConfigManager.open({ rootDir: options.rootDir });
  } catch (error) {
    throw new StartupConfigurationError(
      options.rootDir,
      [configurationErrorIssue(error)],
      { cause: error },
    );
  }

  const profileId = manager.getSelectedProfileId();
  let profile: UserConfigProfile;
  try {
    profile = await manager.getProfile(profileId);
  } catch (error) {
    throw new StartupConfigurationError(
      options.rootDir,
      [configurationErrorIssue(error, "profile")],
      { profileId, cause: error },
    );
  }

  const issues: StartupConfigurationIssue[] = [];
  const readiness = inspectUserConfigProfile(profile);
  if (readiness.status === "invalid") {
    issues.push(...readiness.issues.map(readinessIssue));
  } else if (readiness.status === "review_required") {
    issues.push(
      ...readiness.warnings
        .filter(
          (warning) =>
            warning.id !== "platforms-empty" && warning.id !== "plugins-empty",
        )
        .map((warning) => ({
          code: "PROFILE_INVALID",
          path: warning.path,
          message: warning.message,
          hint: "补齐 selected Profile 的 provider 凭据后重新启动服务。",
        })),
    );
  }

  const runtimeResult = runtimeConfigSchema.safeParse(profile.runtime);
  if (!runtimeResult.success) {
    issues.push(
      ...runtimeResult.error.issues.map((issue) => ({
        code: "RUNTIME_INVALID",
        path: formatPath([
          "runtime",
          ...issue.path.map((key) =>
            typeof key === "symbol" ? String(key) : key,
          ),
        ]),
        message: issue.message,
        hint: "在 selected Profile 的 runtime 字段中修正该值。",
      })),
    );
  }

  validatePlatforms(profile, issues);
  if (issues.length > 0 || !runtimeResult.success) {
    throw new StartupConfigurationError(options.rootDir, issues, {
      profileId,
    });
  }

  return {
    configRoot: options.rootDir,
    selectedProfileId: profileId,
    profile,
    runtime: runtimeResult.data,
  };
}

function validatePlatforms(
  profile: UserConfigProfile,
  issues: StartupConfigurationIssue[],
): void {
  const enabledExternalPlatforms = profile.platforms.filter(
    (platform) => platform.enabled && platform.type !== "web",
  );
  if (enabledExternalPlatforms.length === 0) {
    issues.push({
      code: "PLATFORM_REQUIRED",
      path: "platforms",
      message: "至少需要一个已启用的非 Web 平台适配器。",
      hint: "添加并启用 NapCat 或其他外部平台适配器。",
    });
  }

  for (const [index, platform] of profile.platforms.entries()) {
    if (!platform.enabled || platform.type !== "napcat") {
      continue;
    }
    const settings = platform.settings;
    const credentials = platform.credentials;
    const adapterId = stringValue(settings.adapterId);
    const wsUrl = stringValue(settings.wsUrl);
    const reconnectMs = numberValue(settings.reconnectMs);
    if (adapterId === undefined) {
      issues.push(
        platformIssue(index, "adapterId", "NapCat adapterId 不能为空。"),
      );
    }
    if (wsUrl === undefined) {
      issues.push(platformIssue(index, "wsUrl", "NapCat wsUrl 不能为空。"));
    } else {
      try {
        const parsed = new URL(wsUrl);
        if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
          throw new Error();
        }
      } catch {
        issues.push(
          platformIssue(index, "wsUrl", "NapCat wsUrl 必须是 ws 或 wss 地址。"),
        );
      }
    }
    if (
      reconnectMs === undefined ||
      !Number.isInteger(reconnectMs) ||
      reconnectMs < 100 ||
      reconnectMs > 3_600_000
    ) {
      issues.push(
        platformIssue(
          index,
          "reconnectMs",
          "NapCat reconnectMs 必须在 100 到 3600000 之间。",
        ),
      );
    }
    const accessToken = credentials.accessToken;
    if (accessToken !== undefined && typeof accessToken !== "string") {
      issues.push(
        platformIssue(
          index,
          "credentials.accessToken",
          "NapCat accessToken 必须是字符串。",
        ),
      );
    }
  }
}

function platformIssue(
  index: number,
  field: string,
  message: string,
): StartupConfigurationIssue {
  return {
    code: "PLATFORM_INVALID",
    path: `platforms.${index}.${field}`,
    message,
    hint: "检查对应平台条目的 settings 和 credentials。",
  };
}

function readinessIssue(issue: ConfigurationIssue): StartupConfigurationIssue {
  return {
    code: "PROFILE_INVALID",
    path: issue.path,
    message: issue.message,
    hint: "修正 selected Profile 后重新启动服务。",
  };
}

function configurationErrorIssue(
  error: unknown,
  path = "configuration",
): StartupConfigurationIssue {
  if (error instanceof ConfigError) {
    return {
      code: error.code,
      path,
      message: error.message,
      hint: "检查配置目录、index.json 和 selected Profile。",
    };
  }
  return {
    code: "CONFIGURATION_READ_FAILED",
    path,
    message: "无法读取启动配置。",
    hint: "检查配置目录权限和文件内容。",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? "runtime" : path.join(".");
}
