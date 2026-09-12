/**
 * 功能概述：协调配置快照的显式热应用，不持有 HTTP、数据库或平台实现。
 * 主要职责：ConfigurationApplication 用进程私有 HMAC 标识完整 Profile/模块快照；status 区分
 * 已选中与已生效版本，apply 在配置写锁内校验 revision、预检、停止旧实例并启动新实例。
 * 代码库关系：server.ts 注入 read/validate/stop/start；configuration-management 提供共享写锁；
 * app.ts 把安全 DTO 暴露给 WebUI。restartFields 只返回 runtime 的固定字段名，不返回字段值。
 * 输入输出与副作用：同一时刻仅一个 apply；失败尝试重建旧快照，关闭失败或回滚失败保持降级；
 * beginShutdown 阻止新应用并等待正在进行的切换。错误正文、凭据与未加密摘要不会出现在 DTO 中。
 */
import { createHmac, randomBytes } from "node:crypto";
import type { ModuleInstanceConfig, UserConfigProfile } from "@kaguya/config";

export interface ConfigurationSnapshot {
  readonly profile: UserConfigProfile;
  readonly moduleConfigs: readonly ModuleInstanceConfig[];
}
export interface ConfigurationApplicationStatus {
  readonly state: "ready" | "pending" | "applying" | "degraded";
  readonly selectedProfileId: string;
  readonly selectedRevision: string;
  readonly appliedProfileId: string | null;
  readonly appliedRevision: string | null;
}
export interface ConfigurationApplyInput {
  readonly selectedProfileId: string;
  readonly revision: string;
}
export interface ConfigurationApplyResult {
  readonly status: "applied" | "restart_required" | "failed";
  readonly application: ConfigurationApplicationStatus;
  readonly restartFields?: readonly string[];
  readonly errorCode?:
    | "invalid_configuration"
    | "apply_failed"
    | "rollback_failed"
    | "shutdown_failed";
}
export interface ConfigurationApplicationService {
  status(): Promise<ConfigurationApplicationStatus>;
  apply(input: ConfigurationApplyInput): Promise<ConfigurationApplyResult>;
}
export class ConfigurationApplyConflict extends Error {
  constructor(
    readonly code:
      "configuration_changed" | "configuration_applying" | "server_stopping",
  ) {
    super(code);
  }
}
/** Cleanup failure means starting another instance could leave two live owners. */
export class ConfigurationCleanupError extends Error {
  constructor() {
    super("Configuration resource cleanup failed");
  }
}
interface Options {
  readonly initial: ConfigurationSnapshot;
  readonly initiallyReady: boolean;
  readonly read: () => Promise<ConfigurationSnapshot>;
  readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly validate: (snapshot: ConfigurationSnapshot) => void;
  readonly stop: () => Promise<void>;
  readonly start: (snapshot: ConfigurationSnapshot) => Promise<void>;
  readonly applied: () => void;
}
export class ConfigurationApplication implements ConfigurationApplicationService {
  readonly #key = randomBytes(32);
  readonly #initial: ConfigurationSnapshot;
  #selected: ConfigurationSnapshot;
  #active: ConfigurationSnapshot | undefined;
  #busy = false;
  #stopping = false;
  #unsafe = false;
  #operation: Promise<ConfigurationApplyResult> | undefined;
  constructor(private readonly options: Options) {
    this.#initial = structuredClone(options.initial);
    this.#selected = this.#initial;
    this.#active = options.initiallyReady ? this.#initial : undefined;
  }
  private revision(snapshot: ConfigurationSnapshot): string {
    return createHmac("sha256", this.#key)
      .update(canonical(snapshot))
      .digest("hex");
  }
  private snapshotStatus(): ConfigurationApplicationStatus {
    const selectedRevision = this.revision(this.#selected);
    const appliedRevision = this.#active ? this.revision(this.#active) : null;
    return {
      state: this.#busy
        ? "applying"
        : !this.#active
          ? "degraded"
          : selectedRevision === appliedRevision
            ? "ready"
            : "pending",
      selectedProfileId: this.#selected.profile.id,
      selectedRevision,
      appliedProfileId: this.#active?.profile.id ?? null,
      appliedRevision,
    };
  }
  /** Caller already holds the shared write lock (mutation response or status). */
  async captureStatus(): Promise<ConfigurationApplicationStatus> {
    this.#selected = structuredClone(await this.options.read());
    return this.snapshotStatus();
  }
  async status(): Promise<ConfigurationApplicationStatus> {
    if (this.#busy) return this.snapshotStatus();
    return this.options.exclusive(() => this.captureStatus());
  }
  apply(input: ConfigurationApplyInput): Promise<ConfigurationApplyResult> {
    if (this.#stopping)
      return Promise.reject(new ConfigurationApplyConflict("server_stopping"));
    if (this.#busy)
      return Promise.reject(
        new ConfigurationApplyConflict("configuration_applying"),
      );
    this.#busy = true;
    this.#operation = this.options.exclusive(async () => {
      try {
        const result = await this.applyLocked(input);
        this.#busy = false;
        return { ...result, application: this.snapshotStatus() };
      } finally {
        this.#busy = false;
      }
    });
    return this.#operation;
  }
  async beginShutdown(): Promise<void> {
    this.#stopping = true;
    await this.#operation?.catch(() => undefined);
  }
  private result(
    status: ConfigurationApplyResult["status"],
    extra: Omit<ConfigurationApplyResult, "status" | "application"> = {},
  ): ConfigurationApplyResult {
    return { status, ...extra, application: this.snapshotStatus() };
  }
  private async applyLocked(
    input: ConfigurationApplyInput,
  ): Promise<ConfigurationApplyResult> {
    if (this.#stopping) throw new ConfigurationApplyConflict("server_stopping");
    if (this.#unsafe)
      return this.result("failed", { errorCode: "shutdown_failed" });
    let next: ConfigurationSnapshot;
    try {
      next = structuredClone(await this.options.read());
    } catch {
      return this.result("failed", { errorCode: "invalid_configuration" });
    }
    this.#selected = next;
    if (
      next.profile.id !== input.selectedProfileId ||
      this.revision(next) !== input.revision
    ) {
      throw new ConfigurationApplyConflict("configuration_changed");
    }
    const fields = restartFields(this.#initial, next);
    if (fields.length)
      return this.result("restart_required", { restartFields: fields });
    try {
      this.options.validate(next);
    } catch {
      return this.result("failed", { errorCode: "invalid_configuration" });
    }
    if (this.#active && this.revision(this.#active) === input.revision) {
      this.options.applied();
      return this.result("applied");
    }
    const previous = this.#active;
    this.#active = undefined;
    try {
      await this.options.stop();
    } catch {
      this.#unsafe = true;
      return this.result("failed", { errorCode: "shutdown_failed" });
    }
    try {
      await this.options.start(next);
      this.#active = next;
      this.options.applied();
      return this.result("applied");
    } catch (error) {
      if (error instanceof ConfigurationCleanupError) {
        this.#unsafe = true;
        return this.result("failed", { errorCode: "shutdown_failed" });
      }
      if (previous) {
        try {
          await this.options.start(previous);
          this.#active = previous;
        } catch (rollbackError) {
          this.#unsafe = rollbackError instanceof ConfigurationCleanupError;
          return this.result("failed", { errorCode: "rollback_failed" });
        }
      }
      return this.result("failed", { errorCode: "apply_failed" });
    }
  }
}
function restartFields(
  previous: ConfigurationSnapshot,
  next: ConfigurationSnapshot,
): string[] {
  const keys = [
    "host",
    "port",
    "databaseMode",
    "databaseUrl",
    "webDistPath",
    "corsOrigins",
    "trustProxy",
    "rateLimitMax",
    "rateLimitWindowMs",
    "logLevel",
    "logFormat",
  ] as const;
  return keys
    .filter(
      (key) =>
        canonical(previous.profile.runtime?.[key]) !==
        canonical(next.profile.runtime?.[key]),
    )
    .map((key) => `runtime.${key}`);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
