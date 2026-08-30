/**
 * 功能概述：本模块实现 `packages/config` 的文件型 Profile Registry 管理器，
 * 负责以 `index.json` + `profiles/profile_<id>.json` 的双层结构持久化配置，
 * 并提供显式 bootstrap、Profile 生命周期、就绪态解析与失败回滚能力。
 * 主要职责：`open`/`inspect` 负责在不回退到旧版默认语义的前提下读取现有仓库；
 * 其中 `inspect` 必须保持严格只读，只能通过 `lstat` 与 `O_NOFOLLOW` 打开的
 * 文件句柄检查现存 root/index/profile，而不能执行 mkdir/chmod 等目录准备写操作；
 * `bootstrap` 仅在根目录缺失或为空时创建保留 `default` Profile 与 v3 index，
 * 且按“先写 Profile、后发布 index”的顺序落盘；`createProfile` 只创建空 Profile；
 * `replaceProfile` 以完整替换方式写入 Profile 并在 index 写失败时回滚旧内容；
 * `selectProfile` 只更新选中元数据；`deleteProfile` 保护保留 `default` 与当前选中项；
 * `resolveProfileById` 强制调用方显式提供 ID 并在返回前执行 readiness 校验。
 * 代码库关系：本文件消费 `model.ts` 中的 v3 schema、`readiness.ts` 的 readiness
 * 判定与 registry 组合帮助器，以及 `secure-files.ts` 的敏感目录/原子写工具；
 * 它被 `packages/config/src/index.ts` 稳定导出，并由服务启动、WebUI 与测试用例直接依赖。
 * 输入输出与副作用：所有公开写操作都会串行进入 mutation queue，实际修改磁盘中的
 * `index.json` 和对应 Profile 文件；路径必须始终位于受管根目录内，legacy v1/v2 index
 * 会在任何目录准备或写入前被拒绝，bootstrap/index 更新失败时只回滚本次尝试创建或替换的
 * Profile 文件，不删除调用方已拥有的根目录；若 bootstrap 的清理删除本身失败，会显式抛出
 * `CONFIG_IO_ERROR` 并保留清理失败 cause，而不是静默吞掉该错误。
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ConfigError } from "./errors.js";
import {
  emptyUserConfigProfileSettings,
  profileIdSchema,
  type ProfileId,
  type ReplaceUserConfigProfileInput,
  type UserConfigIndex,
  type UserConfigProfile,
  type UserConfigProfileMetadata,
  userConfigIndexSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";
import {
  assertPathInside,
  ensureSensitiveDirectory,
  readSensitiveJson,
  removeSensitiveFile,
  writeSensitiveJson,
} from "./secure-files.js";
import {
  configurationSetupGuidance,
  ConfigIncompleteError,
  ConfigReviewRequiredError,
  ConfigSetupRequiredError,
  deriveConfigurationWarnings,
  inspectUserConfigProfile,
  type ConfigurationReadiness,
  type ProfileReadiness,
  withRegistryReadiness,
} from "./readiness.js";

export interface FileUserConfigManagerOptions {
  rootDir: string;
}

export class FileUserConfigManager {
  readonly #rootDir: string;
  readonly #profilesDir: string;
  readonly #indexPath: string;
  #index: UserConfigIndex;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(rootDir: string, index: UserConfigIndex) {
    this.#rootDir = rootDir;
    this.#profilesDir = join(rootDir, "profiles");
    this.#indexPath = join(rootDir, "index.json");
    this.#index = index;
  }

  static async open(
    options: FileUserConfigManagerOptions,
  ): Promise<FileUserConfigManager> {
    const rootDir = resolve(requireConfigurationRoot(options));
    const profilesDir = join(rootDir, "profiles");
    const indexPath = join(rootDir, "index.json");

    assertPathInside(rootDir, rootDir);
    assertPathInside(rootDir, indexPath);
    try {
      await access(indexPath);
    } catch (error) {
      if (isMissingPath(error)) {
        throw new ConfigSetupRequiredError(configurationSetupGuidance);
      }
      throw error;
    }

    const index = parsePersistedIndex(
      await readSensitiveJson(indexPath),
      indexPath,
    );
    await ensureOpenDirectories(rootDir, profilesDir);

    const manager = new FileUserConfigManager(rootDir, index);
    await manager.#validateReferencedProfiles();
    return manager;
  }

  static async inspect(
    options: FileUserConfigManagerOptions,
  ): Promise<ConfigurationReadiness> {
    const rootDir = resolve(requireConfigurationRoot(options));
    const profilesDir = join(rootDir, "profiles");
    const indexPath = join(rootDir, "index.json");

    assertPathInside(rootDir, rootDir);
    assertPathInside(rootDir, indexPath);
    try {
      await access(indexPath);
    } catch (error) {
      if (isMissingPath(error)) {
        return {
          status: "setup_required",
          guidance: configurationSetupGuidance,
        };
      }
      throw error;
    }

    const index = parsePersistedIndex(
      await readManagedJsonReadOnly(indexPath),
      indexPath,
    );
    await validateManagedDirectoryReadOnly(rootDir);
    await validateManagedDirectoryReadOnly(profilesDir);
    const selectedProfile = await readProfileReadOnly(
      rootDir,
      profilesDir,
      index.selectedProfileId,
    );
    await validateReferencedProfilesReadOnly(rootDir, profilesDir, index);
    return withRegistryReadiness(
      index.profiles,
      index.selectedProfileId,
      inspectUserConfigProfile(selectedProfile),
    );
  }

  static async bootstrap(
    options: FileUserConfigManagerOptions,
  ): Promise<FileUserConfigManager> {
    const rootDir = resolve(requireConfigurationRoot(options));
    const profilesDir = join(rootDir, "profiles");
    const indexPath = join(rootDir, "index.json");

    assertPathInside(rootDir, rootDir);
    assertPathInside(rootDir, profilesDir);
    assertPathInside(rootDir, indexPath);
    await assertBootstrapableRoot(rootDir, indexPath);

    await ensureSensitiveDirectory(rootDir);
    await ensureSensitiveDirectory(profilesDir);

    const createdAt = new Date().toISOString();
    const profile: UserConfigProfile = {
      version: 1,
      id: "default",
      name: "default",
      ...emptyUserConfigProfileSettings(),
    };
    const index: UserConfigIndex = {
      version: 3,
      selectedProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "default",
          createdAt,
          updatedAt: createdAt,
        },
      ],
    };
    const profilePath = join(profilesDir, "profile_default.json");
    assertPathInside(rootDir, profilePath);
    await writeSensitiveJson(profilePath, profile);
    try {
      await writeSensitiveJson(indexPath, index);
    } catch (error) {
      try {
        await removeSensitiveFile(profilePath);
      } catch (cleanupError) {
        throw new ConfigError(
          "CONFIG_IO_ERROR",
          `Failed to remove bootstrapped profile after index write failure: ${profilePath}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }

    return new FileUserConfigManager(rootDir, index);
  }

  listProfiles(): readonly UserConfigProfileMetadata[] {
    return structuredClone(this.#index.profiles);
  }

  getSelectedProfileId(): ProfileId {
    return this.#index.selectedProfileId;
  }

  async getProfile(profileId: ProfileId): Promise<UserConfigProfile> {
    await this.#afterPendingWrites();
    return structuredClone(await this.#readProfile(profileId));
  }

  async inspectProfile(profileId: ProfileId): Promise<ProfileReadiness> {
    await this.#afterPendingWrites();
    return structuredClone(
      inspectUserConfigProfile(await this.#readProfile(profileId)),
    );
  }

  async createProfile(name: string): Promise<UserConfigProfile> {
    return this.#enqueue(() => this.#createProfile(name));
  }

  async replaceProfile(
    profileId: ProfileId,
    replacement: ReplaceUserConfigProfileInput,
  ): Promise<UserConfigProfile> {
    return this.#enqueue(() =>
      this.#replaceProfileById(profileId, replacement),
    );
  }

  async acknowledgeConfigurationWarnings(
    profileId: ProfileId,
    warningIds: readonly string[],
  ): Promise<void> {
    return this.#enqueue(() =>
      this.#acknowledgeConfigurationWarnings(profileId, warningIds),
    );
  }

  async selectProfile(profileId: ProfileId): Promise<void> {
    return this.#enqueue(() => this.#selectProfile(profileId));
  }

  async deleteProfile(profileId: ProfileId): Promise<void> {
    return this.#enqueue(() => this.#deleteProfile(profileId));
  }

  async resolveProfileById(profileId: ProfileId): Promise<UserConfigProfile> {
    await this.#afterPendingWrites();
    const profile = await this.#readProfile(profileId);
    const readiness = inspectUserConfigProfile(profile);
    if (readiness.status === "invalid") {
      throw new ConfigIncompleteError(readiness.issues);
    }
    if (readiness.status === "review_required") {
      throw new ConfigReviewRequiredError(readiness.warnings);
    }
    return structuredClone(profile);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #afterPendingWrites(): Promise<void> {
    await this.#writeTail;
  }

  #requireMetadata(profileId: ProfileId): UserConfigProfileMetadata {
    let isValidProfileId = false;
    try {
      isValidProfileId =
        typeof profileId === "string" &&
        profileIdSchema.safeParse(profileId).success;
    } catch {
      // Normalize runtime type mismatches and proxy traps without retaining them.
    }
    if (!isValidProfileId) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration profile ID is invalid",
      );
    }

    const metadata = this.#index.profiles.find(({ id }) => id === profileId);
    if (metadata === undefined) {
      throw new ConfigError(
        "CONFIG_PROFILE_NOT_FOUND",
        `Configuration profile was not found: ${profileId}`,
      );
    }
    return metadata;
  }

  #profilePath(profileId: ProfileId): string {
    const path = join(this.#profilesDir, `profile_${profileId}.json`);
    assertPathInside(this.#rootDir, path);
    return path;
  }

  async #readProfile(profileId: ProfileId): Promise<UserConfigProfile> {
    this.#requireMetadata(profileId);
    const path = this.#profilePath(profileId);
    const profile = parsePersistedProfile(await readSensitiveJson(path), path);
    if (profile.id !== profileId) {
      throw new ConfigError(
        "CONFIG_CORRUPT_STORE",
        `Configuration profile ID does not match its filename: ${path}`,
      );
    }
    return profile;
  }

  async #writeIndex(index: UserConfigIndex): Promise<void> {
    const parsed = userConfigIndexSchema.safeParse(index);
    if (!parsed.success) {
      throw new ConfigError(
        "CONFIG_IO_ERROR",
        "Refused to persist an invalid configuration index",
      );
    }
    assertPathInside(this.#rootDir, this.#indexPath);
    await writeSensitiveJson(this.#indexPath, parsed.data);
  }

  async #validateReferencedProfiles(): Promise<void> {
    for (const metadata of this.#index.profiles) {
      let profile: UserConfigProfile;
      try {
        profile = await this.#readProfile(metadata.id);
      } catch (error) {
        if (isMissingPath(error)) {
          throw new ConfigError(
            "CONFIG_CORRUPT_STORE",
            "Configuration index references a missing profile",
          );
        }
        throw error;
      }
      if (profile.name !== metadata.name) {
        const path = this.#profilePath(metadata.id);
        throw new ConfigError(
          "CONFIG_CORRUPT_STORE",
          `Configuration profile name does not match the index: ${path}`,
        );
      }
    }
  }

  async #createProfile(name: string): Promise<UserConfigProfile> {
    const normalizedName = normalizeProfileName(name);
    if (normalizedName === "default") {
      throw new ConfigError(
        "CONFIG_PROFILE_NAME_CONFLICT",
        "Configuration profile name already exists: default",
      );
    }
    if (
      this.#index.profiles.some(
        ({ name: current }) => current === normalizedName,
      )
    ) {
      throw new ConfigError(
        "CONFIG_PROFILE_NAME_CONFLICT",
        `Configuration profile name already exists: ${normalizedName}`,
      );
    }

    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const profile: UserConfigProfile = {
      version: 1,
      id,
      name: normalizedName,
      ...emptyUserConfigProfileSettings(),
    };
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      profiles: [
        ...structuredClone(this.#index.profiles),
        {
          id,
          name: normalizedName,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
    const path = this.#profilePath(id);
    await writeSensitiveJson(path, profile);
    try {
      await this.#writeIndex(nextIndex);
    } catch (error) {
      await removeSensitiveFile(path);
      throw error;
    }
    this.#index = nextIndex;
    return structuredClone(profile);
  }

  async #replaceProfileById(
    profileId: ProfileId,
    replacement: ReplaceUserConfigProfileInput,
  ): Promise<UserConfigProfile> {
    const parsedReplacement = parseReplacementInput(replacement);
    const metadata = this.#requireMetadata(profileId);
    const oldProfile = await this.#readProfile(profileId);
    const name =
      profileId === "default"
        ? "default"
        : normalizeProfileName(parsedReplacement.name);
    if (
      this.#index.profiles.some(
        ({ id, name: current }) => id !== profileId && current === name,
      )
    ) {
      throw new ConfigError(
        "CONFIG_PROFILE_NAME_CONFLICT",
        `Configuration profile name already exists: ${name}`,
      );
    }

    const profileWithoutReview: UserConfigProfile = {
      version: 1,
      id: profileId,
      name,
      ...parsedReplacement.settings,
    };
    const profile: UserConfigProfile = {
      ...profileWithoutReview,
      ...buildReplacementReview(
        profileWithoutReview,
        parsedReplacement.acknowledgedWarnings,
      ),
    };
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      profiles: this.#index.profiles.map((current) =>
        current.id === profileId
          ? {
              ...current,
              name,
              createdAt: metadata.createdAt,
              updatedAt: new Date().toISOString(),
            }
          : structuredClone(current),
      ),
    };
    await this.#replacePersistedProfile(
      profileId,
      oldProfile,
      profile,
      nextIndex,
    );
    return structuredClone(profile);
  }

  async #acknowledgeConfigurationWarnings(
    profileId: ProfileId,
    warningIds: readonly string[],
  ): Promise<void> {
    const acknowledgements = parseCurrentWarningAcknowledgements(warningIds);
    const oldProfile = await this.#readProfile(profileId);
    const currentWarningIds = new Set(
      deriveConfigurationWarnings(oldProfile).map((warning) => warning.id),
    );
    if (
      acknowledgements.some(
        (acknowledgement) => !currentWarningIds.has(acknowledgement),
      )
    ) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration acknowledgement is invalid",
      );
    }
    const profile: UserConfigProfile = {
      ...oldProfile,
      review: { acknowledgedWarnings: [...acknowledgements].sort() },
    };
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      profiles: this.#index.profiles.map((current) =>
        current.id === profileId
          ? { ...current, updatedAt: new Date().toISOString() }
          : structuredClone(current),
      ),
    };
    await this.#replacePersistedProfile(
      profileId,
      oldProfile,
      profile,
      nextIndex,
    );
  }

  async #replacePersistedProfile(
    profileId: ProfileId,
    oldProfile: UserConfigProfile,
    profile: UserConfigProfile,
    nextIndex: UserConfigIndex,
  ): Promise<void> {
    const path = this.#profilePath(profileId);
    await writeSensitiveJson(path, profile);
    try {
      await this.#writeIndex(nextIndex);
    } catch (indexError) {
      try {
        await writeSensitiveJson(path, oldProfile);
      } catch (rollbackError) {
        throw new ConfigError(
          "CONFIG_IO_ERROR",
          `Failed to restore configuration profile after index write failure: ${path}`,
          { cause: rollbackError },
        );
      }
      throw indexError;
    }
    this.#index = nextIndex;
  }

  async #selectProfile(profileId: ProfileId): Promise<void> {
    this.#requireMetadata(profileId);
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      selectedProfileId: profileId,
    };
    await this.#writeIndex(nextIndex);
    this.#index = nextIndex;
  }

  async #deleteProfile(profileId: ProfileId): Promise<void> {
    this.#requireMetadata(profileId);
    if (profileId === "default") {
      throw new ConfigError(
        "CONFIG_DEFAULT_PROFILE_PROTECTED",
        `The default configuration profile cannot be deleted: ${profileId}`,
      );
    }
    if (profileId === this.#index.selectedProfileId) {
      throw new ConfigError(
        "CONFIG_PROFILE_IN_USE",
        `The selected configuration profile cannot be deleted: ${profileId}`,
      );
    }

    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      profiles: this.#index.profiles
        .filter(({ id }) => id !== profileId)
        .map((metadata) => structuredClone(metadata)),
    };
    await this.#writeIndex(nextIndex);
    this.#index = nextIndex;
    await removeSensitiveFile(this.#profilePath(profileId));
  }
}

function isMissingPath(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error || "cause" in error)
  ) {
    return false;
  }
  if ("code" in error && error.code === "ENOENT") {
    return true;
  }
  return (
    "cause" in error &&
    error.cause !== undefined &&
    error.cause !== error &&
    isMissingPath(error.cause)
  );
}

function parsePersistedIndex(value: unknown, path: string): UserConfigIndex {
  const version = persistedVersion(value);
  if (version === 1 || version === 2) {
    throw new ConfigError(
      "CONFIG_UNSUPPORTED_VERSION",
      "Configuration index version 1 or 2 is unsupported; back up the configuration and reinitialize it.",
    );
  }
  const parsed = userConfigIndexSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration index failed validation: ${path}`,
    );
  }
  return parsed.data;
}

function persistedVersion(value: unknown): unknown {
  try {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    return Reflect.get(value, "version");
  } catch {
    return undefined;
  }
}

function parsePersistedProfile(
  value: unknown,
  path: string,
): UserConfigProfile {
  const parsed = userConfigProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration profile failed validation: ${path}`,
    );
  }
  return parsed.data;
}

function parseSettings(value: unknown) {
  try {
    const parsed = userConfigProfileSettingsSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Normalize hostile getters and proxy traps without retaining their errors.
  }
  throw new ConfigError(
    "CONFIG_INVALID_INPUT",
    "Configuration profile input failed validation",
  );
}

function buildReplacementReview(
  profile: UserConfigProfile,
  acknowledgedWarnings: readonly string[],
): { review?: { acknowledgedWarnings: string[] } } {
  if (acknowledgedWarnings.length === 0) {
    return {};
  }
  const validWarningIds = new Set(
    deriveConfigurationWarnings(profile).map((warning) => warning.id),
  );
  if (
    acknowledgedWarnings.some((warningId) => !validWarningIds.has(warningId))
  ) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration acknowledgement is invalid",
    );
  }
  return {
    review: {
      acknowledgedWarnings: [...acknowledgedWarnings].sort(),
    },
  };
}

function parseCurrentWarningAcknowledgements(
  value: unknown,
): readonly string[] {
  try {
    if (!Array.isArray(value)) {
      throw new Error();
    }
    const acknowledgements: string[] = [];
    const seen = new Set<string>();
    for (const acknowledgement of value) {
      if (
        typeof acknowledgement !== "string" ||
        acknowledgement.length === 0 ||
        seen.has(acknowledgement)
      ) {
        throw new Error();
      }
      seen.add(acknowledgement);
      acknowledgements.push(acknowledgement);
    }
    return acknowledgements;
  } catch {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration acknowledgement is invalid",
    );
  }
}

function parseReplacementInput(value: unknown): {
  name: string;
  acknowledgedWarnings: readonly string[];
  settings: ReturnType<typeof parseSettings>;
} {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration profile input failed validation",
      );
    }
    const replacement = value as {
      readonly acknowledgedWarnings?: unknown;
      readonly ai?: unknown;
      readonly name?: unknown;
      readonly platforms?: unknown;
      readonly plugins?: unknown;
    };
    return {
      acknowledgedWarnings: parseCurrentWarningAcknowledgements(
        replacement.acknowledgedWarnings,
      ),
      name: normalizeProfileName(replacement.name),
      settings: parseSettings({
        ai: replacement.ai,
        platforms: replacement.platforms,
        plugins: replacement.plugins,
      }),
    };
  } catch {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile input failed validation",
    );
  }
}

function normalizeProfileName(name: unknown): string {
  if (typeof name !== "string") {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile name must not be empty",
    );
  }
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile name must not be empty",
    );
  }
  return normalized;
}

function requireConfigurationRoot(options: unknown): string {
  let rootDir: unknown;
  try {
    if (options === null || typeof options !== "object") {
      throw new Error();
    }
    rootDir = (options as { readonly rootDir?: unknown }).rootDir;
  } catch {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration root is invalid",
    );
  }
  if (
    typeof rootDir !== "string" ||
    rootDir.trim().length === 0 ||
    rootDir.includes("\0")
  ) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration root is invalid",
    );
  }
  return rootDir;
}

async function ensureOpenDirectories(
  rootDir: string,
  profilesDir: string,
): Promise<void> {
  assertPathInside(rootDir, rootDir);
  assertPathInside(rootDir, profilesDir);
  await ensureSensitiveDirectory(rootDir);
  await ensureSensitiveDirectory(profilesDir);
}

async function validateManagedDirectoryReadOnly(path: string): Promise<void> {
  const stats = await readOnlyLstat(path);
  if (!stats.isDirectory()) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path has an unexpected type: ${path}`,
    );
  }
}

async function validateManagedFileReadOnly(path: string): Promise<void> {
  const stats = await readOnlyLstat(path);
  if (!stats.isFile()) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path has an unexpected type: ${path}`,
    );
  }
}

async function readOnlyLstat(path: string) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path must not be a symbolic link: ${path}`,
    );
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  ) {
    throw new ConfigError(
      "CONFIG_PERMISSION_ERROR",
      `Managed path is not owned by the current user: ${path}`,
    );
  }
  return stats;
}

async function readManagedJsonReadOnly(path: string): Promise<unknown> {
  await validateManagedFileReadOnly(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError(
        "CONFIG_CORRUPT_STORE",
        `Configuration JSON is invalid: ${path}`,
      );
    }
    throw normalizeReadOnlyError("read managed JSON", path, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readProfileReadOnly(
  rootDir: string,
  profilesDir: string,
  profileId: ProfileId,
): Promise<UserConfigProfile> {
  const profilePath = join(profilesDir, `profile_${profileId}.json`);
  assertPathInside(rootDir, profilePath);
  const profile = parsePersistedProfile(
    await readManagedJsonReadOnly(profilePath),
    profilePath,
  );
  if (profile.id !== profileId) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration profile ID does not match its filename: ${profilePath}`,
    );
  }
  return profile;
}

async function validateReferencedProfilesReadOnly(
  rootDir: string,
  profilesDir: string,
  index: UserConfigIndex,
): Promise<void> {
  for (const metadata of index.profiles) {
    let profile: UserConfigProfile;
    try {
      profile = await readProfileReadOnly(rootDir, profilesDir, metadata.id);
    } catch (error) {
      if (isMissingPath(error)) {
        throw new ConfigError(
          "CONFIG_CORRUPT_STORE",
          "Configuration index references a missing profile",
        );
      }
      throw error;
    }
    if (profile.name !== metadata.name) {
      const profilePath = join(profilesDir, `profile_${metadata.id}.json`);
      assertPathInside(rootDir, profilePath);
      throw new ConfigError(
        "CONFIG_CORRUPT_STORE",
        `Configuration profile name does not match the index: ${profilePath}`,
      );
    }
  }
}

async function assertBootstrapableRoot(
  rootDir: string,
  indexPath: string,
): Promise<void> {
  try {
    const rootStats = await lstat(rootDir);
    if (!rootStats.isDirectory()) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration root must be absent or an empty directory before bootstrap",
      );
    }

    const entries = await readdir(rootDir);
    if (entries.length === 0) {
      return;
    }
    if (entries.includes("index.json")) {
      await throwAlreadyBootstrapped(indexPath);
    }
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration root must be absent or an empty directory before bootstrap",
    );
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
}

async function throwAlreadyBootstrapped(indexPath: string): Promise<never> {
  const index = await readSensitiveJson(indexPath);
  const version = persistedVersion(index);
  if (version === 1 || version === 2) {
    throw new ConfigError(
      "CONFIG_UNSUPPORTED_VERSION",
      "Configuration index version 1 or 2 is unsupported; back up the configuration and reinitialize it.",
    );
  }
  throw new ConfigError(
    "CONFIG_INVALID_INPUT",
    "Configuration store is already initialized",
  );
}

function normalizeReadOnlyError(
  action: string,
  path: string,
  error: unknown,
): ConfigError {
  const permissionDenied =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM");
  return new ConfigError(
    permissionDenied ? "CONFIG_PERMISSION_ERROR" : "CONFIG_IO_ERROR",
    `Failed to ${action}: ${path}`,
    { cause: error },
  );
}
