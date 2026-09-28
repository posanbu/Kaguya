/** Revision-checked desired state for restart-bound Memory and NapCat plugins. */
import { createHmac, randomBytes } from "node:crypto";
import {
  loadModuleInstanceConfigs,
  writeCordisModuleEnabled,
  writeModuleInstanceConfig,
  type ModuleInstanceConfig,
} from "@kaguya/config";
import { memoryConfigFromModules } from "@kaguya/composition";
import {
  validateNapCatSettings,
  type NapCatSettings,
} from "./napcat-config.js";

export const FEATURE_IDS = ["memory.raw", "adapter.napcat"] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

export interface FeatureStatus {
  readonly id: FeatureId;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly lifecycle: string;
  readonly blocker?: string;
}
export interface FeatureView {
  readonly revision: string;
  readonly features: readonly FeatureStatus[];
}
export class FeatureManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class FeatureManagement {
  readonly #key = randomBytes(32);
  #degraded = false;
  constructor(
    private readonly options: {
      rootDir: string;
      defaults: readonly ModuleInstanceConfig[];
      exclusive<T>(operation: () => Promise<T>): Promise<T>;
      activeMemory(): readonly string[];
      napCatLifecycle():
        { lifecycle: string; connectivity: string } | undefined;
      committed(configs: readonly ModuleInstanceConfig[]): void;
    },
  ) {}

  private async load(): Promise<readonly ModuleInstanceConfig[]> {
    return loadModuleInstanceConfigs({
      rootDir: this.options.rootDir,
      defaults: this.options.defaults,
      initialize: false,
    });
  }
  private revision(configs: readonly ModuleInstanceConfig[]): string {
    return createHmac("sha256", this.#key)
      .update(JSON.stringify(configs))
      .digest("hex");
  }
  private view(configs: readonly ModuleInstanceConfig[]): FeatureView {
    const running = new Set(this.options.activeMemory());
    const napcat = this.options.napCatLifecycle();
    return {
      revision: this.revision(configs),
      features: FEATURE_IDS.map((id) => {
        const enabled =
          configs.find((config) => config.definitionId === id)?.enabled ??
          false;
        const lifecycle =
          id === "adapter.napcat"
            ? (napcat?.lifecycle ?? "stopped")
            : running.has(id)
              ? "running"
              : enabled
                ? "pending_restart"
                : "disabled";
        const active =
          id === "adapter.napcat" ? lifecycle === "running" : running.has(id);
        return {
          id,
          enabled,
          active,
          lifecycle:
            id === "adapter.napcat" &&
            lifecycle === "running" &&
            napcat?.connectivity === "retrying"
              ? "retrying"
              : lifecycle,
          ...(this.#degraded
            ? { blocker: "recovery_failed" }
            : enabled !== active
              ? { blocker: "restart_required" }
              : {}),
        };
      }),
    };
  }
  async get(): Promise<FeatureView> {
    return this.view(await this.load());
  }
  async toggle(
    id: string,
    enabled: boolean,
    revision: string,
  ): Promise<FeatureView> {
    if (!FEATURE_IDS.includes(id as FeatureId))
      throw new FeatureManagementError(404, "feature_not_found");
    return this.options.exclusive(async () => {
      const current = await this.load();
      if (revision !== this.revision(current))
        throw new FeatureManagementError(409, "feature_configuration_changed");
      const next = current.map((config) => {
        if (config.definitionId === id) return { ...config, enabled };
        return config;
      });
      await this.replaceUnlocked(current, next);
      return this.view(await this.load());
    });
  }
  async updateNapCat(
    settings: NapCatSettings,
    revision: string,
  ): Promise<FeatureView> {
    return this.options.exclusive(async () => {
      const current = await this.load();
      if (revision !== this.revision(current))
        throw new FeatureManagementError(409, "feature_configuration_changed");
      const parsed = validateNapCatSettings(settings);
      const next = current.map((config) => {
        if (config.definitionId !== "adapter.napcat") return config;
        const { enabled, ...rest } = parsed;
        return { ...config, enabled, settings: rest };
      });
      await this.replaceUnlocked(current, next);
      return this.view(await this.load());
    });
  }

  /** Caller already holds the shared configuration lock. */
  async replaceUnlocked(
    current: readonly ModuleInstanceConfig[],
    next: readonly ModuleInstanceConfig[],
  ): Promise<void> {
    if (current.length !== next.length)
      throw new FeatureManagementError(400, "feature_configuration_invalid");
    const changed = next.filter(
      (config, index) =>
        JSON.stringify(config) !== JSON.stringify(current[index]),
    );
    if (!changed.length) return;
    if (
      next.find((config) => config.definitionId === "adapter.web")?.enabled !==
      true
    )
      throw new FeatureManagementError(400, "web_plugin_required");
    try {
      memoryConfigFromModules(next);
    } catch {
      throw new FeatureManagementError(400, "memory_configuration_invalid");
    }
    const napcat = next.find(
      (config) => config.definitionId === "adapter.napcat",
    );
    try {
      if (napcat)
        validateNapCatSettings({ enabled: napcat.enabled, ...napcat.settings });
    } catch {
      throw new FeatureManagementError(400, "napcat_configuration_invalid");
    }
    const writtenSettings: ModuleInstanceConfig[] = [];
    const writtenSwitches: ModuleInstanceConfig[] = [];
    try {
      for (const config of changed) {
        const previous = current.find(
          (item) => item.instanceId === config.instanceId,
        )!;
        if (
          JSON.stringify(config.settings) !== JSON.stringify(previous.settings)
        ) {
          await writeModuleInstanceConfig(this.options.rootDir, config);
          writtenSettings.push(previous);
        }
        if (config.enabled !== previous.enabled) {
          await writeCordisModuleEnabled(
            this.options.rootDir,
            this.options.defaults,
            config.instanceId,
            config.enabled,
          );
          writtenSwitches.push(previous);
        }
      }
      this.options.committed(next);
      this.#degraded = false;
    } catch (error) {
      const failures: unknown[] = [];
      for (const config of writtenSwitches.reverse())
        try {
          await writeCordisModuleEnabled(
            this.options.rootDir,
            this.options.defaults,
            config.instanceId,
            config.enabled,
          );
        } catch (failure) {
          failures.push(failure);
        }
      for (const config of writtenSettings.reverse())
        try {
          await writeModuleInstanceConfig(this.options.rootDir, config);
        } catch (failure) {
          failures.push(failure);
        }
      this.#degraded = failures.length > 0 || error instanceof AggregateError;
      if (this.#degraded)
        throw new FeatureManagementError(503, "feature_recovery_failed");
      if (error instanceof FeatureManagementError) throw error;
      throw new FeatureManagementError(503, "feature_activation_failed");
    }
  }
}
