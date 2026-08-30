/**
 * 功能概述：本文件为 `apps/server` 提供异步 `ConfigurationManagement` 门面，
 * 负责在服务层把 `@kaguya/config` 的显式 Profile Registry 生命周期包装成
 * HTTP 与启动流程可复用的管理接口，并单独维护“当前进程是否需要重启才能应用
 * selected Profile 变更”的本地状态。
 * 主要职责：`createConfigurationManagement` 在启动时先只读 `inspect` 仓库，
 * 缺失时执行一次 `bootstrap`，其余情况打开现有 Registry；返回对象的 `inspect`
 * 暴露 selected Profile 的持久化 readiness，并在 selected Profile 已 ready 且
 * 当前进程存在待重启变更时投影为 `restart_required`；`listProfiles`/`getProfile`
 * 公开 Registry 读取；`createProfile`/`replaceProfile`/`selectProfile`/`deleteProfile`
 * 分别映射到底层 manager 方法，并返回包含 `profile` 与 `restartRequired` 的
 * `ProfileMutationResult`，避免再次退回旧的一次性 setup 聚合写入。
 * 代码库关系：本文件直接依赖 `@kaguya/config` 的 `FileUserConfigManager`、
 * readiness 类型和 Profile schema 类型，被 `server.ts` 在启动前创建并传给
 * HTTP 应用；Task 5 的 Profile 路由将继续消费这里的细粒度方法，而不是重新发明
 * 另一层配置编排逻辑。临时 `/api/v1/setup` bridge 通过本文件区分真正的输入错误与
 * “第二次 readiness 检查时 setup 已不再需要”的竞态冲突。
 * 输入输出与副作用：创建门面时可能在缺失仓库的根目录写入 v3 `default` Profile；
 * 后续公开 mutation 都会落盘到配置目录，但不会启动、重载或停止 Runtime/NapCat。
 * 重启标记只存在于当前进程实例内，重新创建门面后会重新按磁盘状态计算 readiness。
 */
import {
  ConfigError,
  FileUserConfigManager,
  inspectUserConfigProfile,
  withRegistryReadiness,
  type ExistingConfigurationReadiness,
  type ReplaceUserConfigProfileInput,
  type UserConfigProfile,
  type UserConfigProfileMetadata,
} from "@kaguya/config";

export type ConfigurationSetupStatus =
  | ExistingConfigurationReadiness
  | { readonly status: "restart_required" };

export interface ProfileRegistryMetadata {
  readonly selectedProfileId: string;
  readonly profiles: readonly UserConfigProfileMetadata[];
}

export interface ProfileMutationResult {
  readonly profile: UserConfigProfile;
  readonly restartRequired: boolean;
}

export interface ConfigurationManagement {
  inspect(): Promise<ConfigurationSetupStatus>;
  listProfiles(): Promise<ProfileRegistryMetadata>;
  getProfile(profileId: string): Promise<UserConfigProfile>;
  createProfile(name: string): Promise<ProfileMutationResult>;
  replaceProfile(
    profileId: string,
    replacement: ReplaceUserConfigProfileInput,
  ): Promise<ProfileMutationResult>;
  selectProfile(profileId: string): Promise<ProfileMutationResult>;
  deleteProfile(profileId: string): Promise<ProfileMutationResult>;
}

export interface InitialConfigurationInput {
  readonly profileName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly lightModel: string;
  readonly heavyModel: string;
  readonly acknowledgeOptional: boolean;
}

export async function createConfigurationManagement(
  rootDir: string,
): Promise<ConfigurationManagement> {
  const readiness = await FileUserConfigManager.inspect({ rootDir });
  const manager =
    readiness.status === "setup_required"
      ? await FileUserConfigManager.bootstrap({ rootDir })
      : await FileUserConfigManager.open({ rootDir });
  let restartRequired = false;

  return {
    async inspect() {
      const selectedProfileId = manager.getSelectedProfileId();
      const readiness = inspectUserConfigProfile(
        await manager.getProfile(selectedProfileId),
      );
      if (readiness.status === "ready" && restartRequired) {
        return { status: "restart_required" as const };
      }
      return withRegistryReadiness(
        manager.listProfiles(),
        selectedProfileId,
        readiness,
      );
    },
    async listProfiles() {
      return {
        selectedProfileId: manager.getSelectedProfileId(),
        profiles: manager.listProfiles(),
      };
    },
    async getProfile(profileId) {
      return manager.getProfile(profileId);
    },
    async createProfile(name) {
      const profile = await manager.createProfile(name);
      return { profile, restartRequired };
    },
    async replaceProfile(profileId, replacement) {
      const profile = await manager.replaceProfile(profileId, replacement);
      restartRequired =
        restartRequired || manager.getSelectedProfileId() === profileId;
      return { profile, restartRequired };
    },
    async selectProfile(profileId) {
      const selectionChanged = manager.getSelectedProfileId() !== profileId;
      await manager.selectProfile(profileId);
      const profile = await manager.getProfile(profileId);
      restartRequired = restartRequired || selectionChanged;
      return { profile, restartRequired };
    },
    async deleteProfile(profileId) {
      const profile = await manager.getProfile(profileId);
      await manager.deleteProfile(profileId);
      return { profile, restartRequired };
    },
  };
}

const initialProviderId = "default-provider";

export async function initializeConfigurationProfile(
  management: ConfigurationManagement,
  input: InitialConfigurationInput,
): Promise<ProfileMutationResult> {
  if (input.lightModel.trim() === input.heavyModel.trim()) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Light and heavy models must be different",
    );
  }
  if (!input.acknowledgeOptional) {
    throw new ConfigError(
      "CONFIG_REVIEW_REQUIRED",
      "Optional configuration must be reviewed",
    );
  }

  const status = await management.inspect();
  if (status.status === "ready" || status.status === "restart_required") {
    throw new ConfigurationSetupNotRequiredError();
  }

  return management.replaceProfile(
    status.selectedProfileId,
    initialProfileReplacement(
      input.profileName,
      input.lightModel,
      input.heavyModel,
      input.baseUrl,
      input.apiKey,
    ),
  );
}

export class ConfigurationSetupNotRequiredError extends ConfigError {
  constructor() {
    super(
      "CONFIG_INVALID_INPUT",
      "Configuration setup is not required",
    );
  }
}

function initialProfileReplacement(
  profileName: string,
  lightModel: string,
  heavyModel: string,
  baseUrl: string,
  apiKey: string,
): ReplaceUserConfigProfileInput {
  return {
    name: profileName,
    acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
    ai: {
      defaultProviderId: initialProviderId,
      modelTiers: {
        light: {
          providerId: initialProviderId,
          modelId: lightModel,
        },
        heavy: {
          providerId: initialProviderId,
          modelId: heavyModel,
        },
      },
      providers: [
        {
          id: initialProviderId,
          type: "openai-compatible",
          enabled: true,
          baseUrl,
          apiKey,
          models: [lightModel, heavyModel],
          settings: {},
        },
      ],
    },
    platforms: [],
    plugins: [],
  };
}

export function isConfigurationInputError(error: unknown): boolean {
  return (
    error instanceof ConfigError &&
    (error.code === "CONFIG_INVALID_INPUT" ||
      error.code === "CONFIG_INCOMPLETE" ||
      error.code === "CONFIG_REVIEW_REQUIRED")
  );
}

export function isConfigurationSetupNotRequiredError(
  error: unknown,
): error is ConfigurationSetupNotRequiredError {
  return error instanceof ConfigurationSetupNotRequiredError;
}
