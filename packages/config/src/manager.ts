import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ConfigError } from "./errors.js";
import {
  emptyUserConfigProfileSettings,
  profileIdSchema,
  type UpdateUserConfigProfileInput,
  type UserConfigIndex,
  type UserConfigProfile,
  type UserConfigProfileMetadata,
  type UserConfigProfileSettings,
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
} from "./readiness.js";

export interface FileUserConfigManagerOptions {
  rootDir: string;
}

export interface FileUserConfigInitializeOptions extends FileUserConfigManagerOptions {
  readonly name: string;
  readonly settings: UserConfigProfileSettings;
  readonly acknowledgedWarnings?: readonly string[];
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
    let index: UserConfigIndex;
    try {
      assertPathInside(rootDir, indexPath);
      await access(indexPath);
    } catch (error) {
      if (isMissingPath(error)) {
        throw new ConfigSetupRequiredError(configurationSetupGuidance);
      }
      throw error;
    }
    await ensureSensitiveDirectory(rootDir);
    assertPathInside(rootDir, profilesDir);
    await ensureSensitiveDirectory(profilesDir);
    assertPathInside(rootDir, indexPath);
    index = parsePersistedIndex(await readSensitiveJson(indexPath), indexPath);

    const manager = new FileUserConfigManager(rootDir, index);
    await manager.#validateReferencedProfiles();
    return manager;
  }

  static async inspect(
    options: FileUserConfigManagerOptions,
  ): Promise<ConfigurationReadiness> {
    const rootDir = resolve(requireConfigurationRoot(options));
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

    const manager = await FileUserConfigManager.open({ rootDir });
    return inspectUserConfigProfile(
      await manager.getProfile(manager.getDefaultProfileId()),
    );
  }

  static async initialize(
    options: FileUserConfigInitializeOptions,
  ): Promise<FileUserConfigManager> {
    const input = parseInitializeInput(options);
    const rootDir = resolve(input.rootDir);
    const profilesDir = join(rootDir, "profiles");
    const indexPath = join(rootDir, "index.json");
    const id = randomUUID();
    const profile: UserConfigProfile = {
      version: 1,
      id,
      name: input.name,
      ...input.settings,
      ...(input.acknowledgedWarnings.length === 0
        ? {}
        : { review: { acknowledgedWarnings: input.acknowledgedWarnings } }),
    };
    const warningIds = new Set(
      deriveConfigurationWarnings(profile).map((warning) => warning.id),
    );
    if (
      input.acknowledgedWarnings.some(
        (acknowledgement) => !warningIds.has(acknowledgement),
      )
    ) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration acknowledgement is invalid",
      );
    }

    const readiness = inspectUserConfigProfile(profile);
    if (readiness.status === "invalid") {
      throw new ConfigIncompleteError(readiness.issues);
    }
    if (readiness.status === "review_required") {
      throw new ConfigReviewRequiredError(readiness.warnings);
    }

    assertPathInside(rootDir, rootDir);
    assertPathInside(rootDir, indexPath);
    await assertStoreIsUninitialized(indexPath);
    await ensureSensitiveDirectory(rootDir);
    assertPathInside(rootDir, profilesDir);
    await ensureSensitiveDirectory(profilesDir);
    assertPathInside(rootDir, indexPath);
    await assertStoreIsUninitialized(indexPath);

    const timestamp = new Date().toISOString();
    const index: UserConfigIndex = {
      version: 1,
      defaultProfileId: id,
      profiles: [
        { id, name: input.name, createdAt: timestamp, updatedAt: timestamp },
      ],
      sessionBindings: copyBindings({}),
    };
    const profilePath = join(profilesDir, `profile_${id}.json`);
    assertPathInside(rootDir, profilePath);
    await writeSensitiveJson(profilePath, profile);
    try {
      assertPathInside(rootDir, indexPath);
      await assertStoreIsUninitialized(indexPath);
      await writeSensitiveJson(indexPath, index);
    } catch (error) {
      assertPathInside(rootDir, profilePath);
      await removeSensitiveFile(profilePath);
      throw error;
    }
    return new FileUserConfigManager(rootDir, index);
  }

  listProfiles(): readonly UserConfigProfileMetadata[] {
    return structuredClone(this.#index.profiles);
  }

  async getProfile(profileId: string): Promise<UserConfigProfile> {
    await this.#afterPendingWrites();
    return structuredClone(await this.#readProfile(profileId));
  }

  async inspectProfile(profileId: string): Promise<ProfileReadiness> {
    await this.#afterPendingWrites();
    return structuredClone(
      inspectUserConfigProfile(await this.#readProfile(profileId)),
    );
  }

  async createProfile(
    name: string,
    initial?: UserConfigProfileSettings,
  ): Promise<UserConfigProfile> {
    return this.#enqueue(() =>
      this.#createProfile(
        name,
        initial === undefined ? emptyUserConfigProfileSettings() : initial,
      ),
    );
  }

  async updateProfile(
    profileId: string,
    update: UpdateUserConfigProfileInput,
  ): Promise<UserConfigProfile> {
    return this.#enqueue(() => this.#updateProfile(profileId, update));
  }

  async acknowledgeConfigurationWarnings(
    profileId: string,
    warningIds: readonly string[],
  ): Promise<void> {
    return this.#enqueue(() =>
      this.#acknowledgeConfigurationWarnings(profileId, warningIds),
    );
  }

  getDefaultProfileId(): string {
    return this.#index.defaultProfileId;
  }

  async setDefaultProfile(profileId: string): Promise<void> {
    return this.#enqueue(() => this.#setDefaultProfile(profileId));
  }

  async deleteProfile(profileId: string): Promise<void> {
    return this.#enqueue(() => this.#deleteProfile(profileId));
  }

  async bindSession(sessionId: string, profileId: string): Promise<void> {
    const requiredSessionId = requireSessionId(sessionId);
    return this.#enqueue(async () => {
      this.#requireMetadata(profileId);
      const sessionBindings = copyBindings(this.#index.sessionBindings);
      sessionBindings[requiredSessionId] = profileId;
      const nextIndex: UserConfigIndex = {
        ...structuredClone(this.#index),
        sessionBindings,
      };
      await this.#writeIndex(nextIndex);
      this.#index = nextIndex;
    });
  }

  async unbindSession(sessionId: string): Promise<void> {
    const requiredSessionId = requireSessionId(sessionId);
    return this.#enqueue(async () => {
      const sessionBindings = copyBindings(this.#index.sessionBindings);
      if (!Object.hasOwn(sessionBindings, requiredSessionId)) {
        return;
      }
      delete sessionBindings[requiredSessionId];
      const nextIndex: UserConfigIndex = {
        ...structuredClone(this.#index),
        sessionBindings,
      };
      await this.#writeIndex(nextIndex);
      this.#index = nextIndex;
    });
  }

  async resolveProfile(sessionId: string): Promise<UserConfigProfile> {
    const requiredSessionId = requireSessionId(sessionId);
    await this.#afterPendingWrites();
    const profileId = Object.hasOwn(
      this.#index.sessionBindings,
      requiredSessionId,
    )
      ? this.#index.sessionBindings[requiredSessionId]!
      : this.#index.defaultProfileId;
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

  #requireMetadata(profileId: string): UserConfigProfileMetadata {
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

  #profilePath(profileId: string): string {
    const path = join(this.#profilesDir, `profile_${profileId}.json`);
    assertPathInside(this.#rootDir, path);
    return path;
  }

  async #readProfile(profileId: string): Promise<UserConfigProfile> {
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

  async #createProfile(
    name: string,
    initial: UserConfigProfileSettings,
  ): Promise<UserConfigProfile> {
    const normalizedName = normalizeProfileName(name);
    const settings = parseSettings(initial);
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
      ...settings,
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
      assertPathInside(this.#rootDir, path);
      await removeSensitiveFile(path);
      throw error;
    }
    this.#index = nextIndex;
    return structuredClone(profile);
  }

  async #updateProfile(
    profileId: string,
    update: UpdateUserConfigProfileInput,
  ): Promise<UserConfigProfile> {
    const parsedUpdate = parseUpdateInput(update);
    const metadata = this.#requireMetadata(profileId);
    const oldProfile = await this.#readProfile(profileId);
    const name =
      parsedUpdate.name === undefined
        ? metadata.name
        : normalizeProfileName(parsedUpdate.name);
    if (profileId === this.#index.defaultProfileId && name !== metadata.name) {
      throw new ConfigError(
        "CONFIG_DEFAULT_PROFILE_PROTECTED",
        `The default configuration profile cannot be renamed: ${profileId}`,
      );
    }
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
    const profile: UserConfigProfile = {
      version: 1,
      id: profileId,
      name,
      ...parsedUpdate.settings,
    };
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      profiles: this.#index.profiles.map((current) =>
        current.id === profileId
          ? { ...current, name, updatedAt: new Date().toISOString() }
          : structuredClone(current),
      ),
    };
    await this.#replaceProfile(profileId, oldProfile, profile, nextIndex);
    return structuredClone(profile);
  }

  async #acknowledgeConfigurationWarnings(
    profileId: string,
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
    await this.#replaceProfile(profileId, oldProfile, profile, nextIndex);
  }

  async #replaceProfile(
    profileId: string,
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
        assertPathInside(this.#rootDir, path);
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

  async #setDefaultProfile(profileId: string): Promise<void> {
    this.#requireMetadata(profileId);
    const nextIndex: UserConfigIndex = {
      ...structuredClone(this.#index),
      defaultProfileId: profileId,
    };
    await this.#writeIndex(nextIndex);
    this.#index = nextIndex;
  }

  async #deleteProfile(profileId: string): Promise<void> {
    this.#requireMetadata(profileId);
    if (profileId === this.#index.defaultProfileId) {
      throw new ConfigError(
        "CONFIG_DEFAULT_PROFILE_PROTECTED",
        `The default configuration profile cannot be deleted: ${profileId}`,
      );
    }
    if (Object.values(this.#index.sessionBindings).includes(profileId)) {
      throw new ConfigError(
        "CONFIG_PROFILE_IN_USE",
        `Configuration profile is selected by a session: ${profileId}`,
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
  const parsed = userConfigIndexSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "CONFIG_CORRUPT_STORE",
      `Configuration index failed validation: ${path}`,
    );
  }
  return parsed.data;
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

function parseSettings(value: unknown): UserConfigProfileSettings {
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

function parseInitializeInput(value: unknown): {
  rootDir: string;
  name: string;
  settings: UserConfigProfileSettings;
  acknowledgedWarnings: string[];
} {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    const options = value as {
      readonly acknowledgedWarnings?: unknown;
      readonly name?: unknown;
      readonly rootDir?: unknown;
      readonly settings?: unknown;
    };
    return {
      rootDir: requireConfigurationRoot(options),
      name: normalizeProfileName(options.name),
      settings: parseSettings(options.settings),
      acknowledgedWarnings: parseAcknowledgedWarnings(
        options.acknowledgedWarnings,
      ),
    };
  } catch {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration profile input failed validation",
    );
  }
}

function parseAcknowledgedWarnings(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  try {
    if (!Array.isArray(value)) {
      throw new Error();
    }
    const acknowledgements: string[] = [];
    const seen = new Set<string>();
    for (const acknowledgement of value) {
      if (typeof acknowledgement !== "string") {
        throw new Error();
      }
      const normalized = acknowledgement.trim();
      if (normalized.length === 0 || seen.has(normalized)) {
        throw new Error();
      }
      seen.add(normalized);
      acknowledgements.push(normalized);
    }
    return acknowledgements;
  } catch {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration acknowledgement is invalid",
    );
  }
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

function parseUpdateInput(value: unknown): {
  name: unknown;
  settings: UserConfigProfileSettings;
} {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigError(
        "CONFIG_INVALID_INPUT",
        "Configuration profile input failed validation",
      );
    }
    const update = value as {
      readonly ai?: unknown;
      readonly name?: unknown;
      readonly platforms?: unknown;
      readonly plugins?: unknown;
    };
    return {
      name: update.name,
      settings: parseSettings({
        ai: update.ai,
        platforms: update.platforms,
        plugins: update.plugins,
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

function requireSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string") {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Session ID must not be empty",
    );
  }
  if (sessionId.trim().length === 0) {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Session ID must not be empty",
    );
  }
  return sessionId;
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

function copyBindings(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const target = Object.create(null) as Record<string, string>;
  for (const [sessionId, profileId] of Object.entries(source)) {
    target[sessionId] = profileId;
  }
  return target;
}

async function assertStoreIsUninitialized(indexPath: string): Promise<void> {
  try {
    await access(indexPath);
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
  throw new ConfigError(
    "CONFIG_INVALID_INPUT",
    "Configuration store is already initialized",
  );
}
