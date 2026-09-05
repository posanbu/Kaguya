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
  FileUserConfigManager,
  inspectUserConfigProfile,
  withRegistryReadiness,
  type ExistingConfigurationReadiness,
  type ReplaceUserConfigProfileInput,
  type UserConfigProfile,
  type UserConfigProfileMetadata,
} from "@kaguya/config";

import {
  loadNapCatSettings,
  saveNapCatSettings,
  type NapCatSettings,
} from "./napcat-config.js";

export type ConfigurationSetupStatus =
  | ExistingConfigurationReadiness
  | (Omit<ExistingConfigurationReadiness, "status"> & {
      readonly status: "restart_required";
    });

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
  getNapCatSettings?: () => Promise<NapCatSettings>;
  saveNapCatSettings?: (settings: NapCatSettings) => Promise<NapCatSettings>;
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
      const selectedReadiness = inspectUserConfigProfile(
        await manager.getProfile(selectedProfileId),
      );
      const readiness = withRegistryReadiness(
        manager.listProfiles(),
        selectedProfileId,
        selectedReadiness,
      );
      if (selectedReadiness.status === "ready" && restartRequired) {
        return {
          ...readiness,
          status: "restart_required" as const,
        };
      }
      return readiness;
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
    getNapCatSettings() {
      return loadNapCatSettings(rootDir);
    },
    async saveNapCatSettings(settings) {
      const saved = await saveNapCatSettings(rootDir, settings);
      restartRequired = true;
      return saved;
    },
  };
}
