/** Immediate, revision-checked switches for global Memory and adapter plugins. */
import { createHmac, randomBytes } from "node:crypto";
import {
  loadModuleInstanceConfigs,
  writeModuleInstanceConfig,
  type ModuleInstanceConfig,
} from "@kaguya/config";
import { memoryConfigFromModules } from "@kaguya/composition";
import {
  validateNapCatSettings,
  type NapCatSettings,
} from "./napcat-config.js";

export const FEATURE_IDS = [
  "memory.writeback",
  "memory.knowledge",
  "memory.index",
  "memory.cognition",
  "adapter.napcat",
] as const;
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
      activateMemory(configs: readonly ModuleInstanceConfig[]): Promise<void>;
      activateNapCat(configs: readonly ModuleInstanceConfig[]): Promise<void>;
      activeMemory(): readonly string[];
      napCatLifecycle():
        { lifecycle: string; connectivity: string } | undefined;
      committed(configs: readonly ModuleInstanceConfig[]): void;
      recovered(): void;
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
    const raw =
      configs.find((config) => config.definitionId === "memory.writeback")
        ?.enabled ?? false;
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
                ? "failed"
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
          ...(!raw && id.startsWith("memory.") && id !== "memory.writeback"
            ? { blocker: "memory.writeback" }
            : {}),
          ...(this.#degraded ? { blocker: "recovery_failed" } : {}),
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
      const raw = current.find(
        (config) => config.definitionId === "memory.writeback",
      )?.enabled;
      if (
        enabled &&
        id.startsWith("memory.") &&
        id !== "memory.writeback" &&
        !raw
      )
        throw new FeatureManagementError(409, "memory_writeback_required");
      const next = current.map((config) => {
        if (
          config.definitionId === id ||
          (id === "memory.writeback" &&
            !enabled &&
            config.definitionId.startsWith("memory.") &&
            FEATURE_IDS.includes(config.definitionId as FeatureId))
        )
          return { ...config, enabled };
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
    const memoryChanged = changed.some((config) =>
      config.definitionId.startsWith("memory."),
    );
    const napcatChanged = changed.some(
      (config) => config.definitionId === "adapter.napcat",
    );
    let appliedMemory = false;
    let appliedNapCat = false;
    const written: ModuleInstanceConfig[] = [];
    try {
      if (memoryChanged) {
        await this.options.activateMemory(next);
        appliedMemory = true;
      }
      if (napcatChanged) {
        await this.options.activateNapCat(next);
        appliedNapCat = true;
      }
      // Dependents are disabled before raw Memory, so a crash never leaves enabled children with raw off.
      const ordered = [...changed].sort((a, b) =>
        a.definitionId === "memory.writeback" && !a.enabled
          ? 1
          : b.definitionId === "memory.writeback" && !b.enabled
            ? -1
            : 0,
      );
      for (const config of ordered) {
        await writeModuleInstanceConfig(this.options.rootDir, config);
        written.push(
          current.find((item) => item.instanceId === config.instanceId)!,
        );
      }
      this.options.committed(next);
      this.#degraded = false;
    } catch (error) {
      const failures: unknown[] = [];
      for (const config of written.reverse())
        try {
          await writeModuleInstanceConfig(this.options.rootDir, config);
        } catch (failure) {
          failures.push(failure);
        }
      if (appliedNapCat)
        try {
          await this.options.activateNapCat(current);
        } catch (failure) {
          failures.push(failure);
        }
      if (appliedMemory)
        try {
          await this.options.activateMemory(current);
        } catch (failure) {
          failures.push(failure);
        }
      if (!failures.length)
        try {
          this.options.recovered();
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
