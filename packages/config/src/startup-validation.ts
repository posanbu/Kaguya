import { ConfigError } from "./errors.js";
import { FileUserConfigManager } from "./manager.js";
import {
  inspectUserConfigProfile,
  type ConfigurationIssue,
} from "./readiness.js";
import {
  runtimeConfigSchema,
  type RuntimeConfig,
  type UserConfigProfile,
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
    super("Startup configuration validation failed", { cause: options.cause });
    this.name = "StartupConfigurationError";
    this.code = issues[0]?.code ?? "CONFIGURATION_INVALID";
    this.configRoot = configRoot;
    this.profileId = options.profileId;
    this.issues = issues.map((issue) => ({ ...issue }));
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
      configurationErrorIssues(error),
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
      configurationErrorIssues(error, "profile"),
      { profileId, cause: error },
    );
  }

  const issues: StartupConfigurationIssue[] = [];
  const readiness = inspectUserConfigProfile(profile);
  if (readiness.status === "invalid") {
    issues.push(...readiness.issues.map(readinessIssue));
  } else if (readiness.status === "review_required") {
    issues.push(
      ...readiness.warnings.map((warning) => ({
        code: "PROFILE_INVALID",
        path: warning.path,
        message: warning.message,
        hint: "请修正 selected Profile 后重新启动服务。",
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
        hint: "请在 selected Profile 的 runtime 字段中修正该值。",
      })),
    );
  }

  if (issues.length > 0 || !runtimeResult.success) {
    throw new StartupConfigurationError(options.rootDir, issues, { profileId });
  }

  return {
    configRoot: options.rootDir,
    selectedProfileId: profileId,
    profile,
    runtime: runtimeResult.data,
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

function configurationErrorIssues(
  error: unknown,
  path = "configuration",
): readonly StartupConfigurationIssue[] {
  if (error instanceof ConfigError) {
    if (error.validationIssues !== undefined) {
      return error.validationIssues.map((issue) => ({ ...issue }));
    }
    return [
      {
        code: error.code,
        path,
        message: error.message,
        hint: "检查配置目录、index.json 和 selected Profile。",
      },
    ];
  }
  return [
    {
      code: "CONFIGURATION_READ_FAILED",
      path,
      message: "无法读取启动配置。",
      hint: "检查配置目录权限和文件内容。",
    },
  ];
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
