/**
 * 功能概述：管理平台适配器生命周期、状态快照和统一入站白名单边界。
 * 主要职责：register/registerTransports 装配启动前出口；finalizeRuntime 单次绑定 Runtime；
 * pauseIngress/resumeIngress 在热应用发布新宿主前阻止入站，beginStopping 永久关闭旧宿主入口。
 * 代码库关系：Server 通过动态门面转发 HTTP/Web 请求，NapCat 回调始终绑定所属宿主。
 * 输入输出与副作用：启动/停止连接，拒绝切换中的消息；暂停不关闭出口，允许旧任务完成投递。
 */
import { createModuleLogger, type KaguyaLogger } from "@kaguya/logger";
import {
  AdapterIngressUnavailableError,
  normalizeWebInboundMessage,
  type HostedAdapter,
  type AdapterSnapshot,
  type AdapterHostStatus,
  type AdapterConnectionStatus,
  type InformationIngress,
  type PlatformInboundMessage,
  type RuntimeUnavailableReason,
} from "@kaguya/platform-adapters";
import { GatewayAllowlist } from "@kaguya/runtime";
import type { GatewayAllowlistConfig } from "./config.js";
import type { WebMessageGateway } from "./web-gateway.js";

type RuntimeTarget = InformationIngress & {
  registerTransport(registration: {
    adapterId: string;
    platform: HostedAdapter["platform"];
    transport: NonNullable<HostedAdapter["outboundTransport"]>;
  }): void;
};
export class AdapterHost {
  private readonly adapters = new Map<string, HostedAdapter>();
  private readonly snapshots = new Map<string, AdapterSnapshot>();
  private readonly allowlist: GatewayAllowlist;
  private state: AdapterHostStatus["adapterHostState"] = "stopped";
  private runtime: InformationIngress | undefined;
  private reason: RuntimeUnavailableReason = "configuration_not_ready";
  private finalized = false;
  private stopping = false;
  private paused = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  constructor(
    private readonly logger: KaguyaLogger,
    allowlist: GatewayAllowlistConfig,
    private readonly now = () => new Date(),
  ) {
    this.allowlist = new GatewayAllowlist(allowlist);
  }
  register(adapter: HostedAdapter): void {
    if (
      this.startPromise ||
      this.stopping ||
      this.adapters.has(adapter.adapterId)
    )
      throw new Error("Adapter registration is closed or duplicated");
    this.adapters.set(adapter.adapterId, adapter);
    this.snapshots.set(adapter.adapterId, {
      adapterId: adapter.adapterId,
      type: adapter.type,
      platform: adapter.platform,
      enabled: adapter.enabled,
      lifecycle: !adapter.enabled
        ? "disabled"
        : adapter.configurationError
          ? "failed"
          : "stopped",
      connectivity:
        adapter.platform === "web" ? "not_applicable" : "disconnected",
      ingress: this.ingressState(),
      updatedAt: this.now().toISOString(),
      ...(adapter.configurationError
        ? { errorType: adapter.configurationError }
        : {}),
    });
  }
  /** Runtime keeps its pre-start transport registration contract; binding is finalized only after start succeeds. */
  registerTransports(runtime: RuntimeTarget): void {
    for (const adapter of this.adapters.values()) {
      if (
        adapter.enabled &&
        !adapter.configurationError &&
        adapter.outboundTransport
      )
        runtime.registerTransport({
          adapterId: adapter.adapterId,
          platform: adapter.platform,
          transport: adapter.outboundTransport,
        });
    }
  }
  finalizeRuntime(
    runtime: InformationIngress | undefined,
    reason: RuntimeUnavailableReason = "configuration_not_ready",
  ): void {
    if (this.finalized || this.stopping)
      throw new Error("Runtime binding is immutable");
    this.finalized = true;
    this.runtime = runtime;
    this.reason = reason;
    this.updateIngress();
  }
  status(): AdapterHostStatus {
    return {
      adapterHostState: this.state,
      runtime: {
        ingress: this.ingressState(),
        ...(!this.runtime && !this.stopping ? { reason: this.reason } : {}),
      },
      adapters: [...this.snapshots.values()]
        .sort((a, b) =>
          a.adapterId < b.adapterId ? -1 : a.adapterId > b.adapterId ? 1 : 0,
        )
        .map((s) => ({ ...s })),
    };
  }
  start(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.startPromise ??= this.startAdapters();
    return this.startPromise;
  }
  private async startAdapters(): Promise<void> {
    this.state = "starting";
    await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        if (!adapter.enabled || adapter.configurationError) {
          this.logState(
            adapter.adapterId,
            !adapter.enabled ? "disabled" : "failed",
            !adapter.enabled ? "info" : "warn",
          );
          return;
        }
        this.patch(adapter.adapterId, { lifecycle: "starting" });
        this.logState(adapter.adapterId, "starting", "info");
        try {
          await adapter.start((status) => {
            if (
              this.stopping ||
              this.snapshots.get(adapter.adapterId)?.lifecycle === "failed"
            )
              return;
            this.connectionStatus(adapter.adapterId, status);
          });
          if (!this.stopping)
            this.patch(adapter.adapterId, { lifecycle: "running" });
        } catch {
          this.patch(adapter.adapterId, {
            lifecycle: "failed",
            errorType: "start_failed",
          });
          this.logState(adapter.adapterId, "failed", "warn", {
            phase: "adapter_start",
          });
          try {
            await adapter.stop();
          } catch {
            /* Other adapters must still start. */
          }
        }
      }),
    );
    if (!this.stopping) this.state = "running";
  }
  pauseIngress(): void {
    this.paused = true;
    this.updateIngress();
  }
  resumeIngress(): void {
    if (this.stopping) throw new Error("Stopped adapter ingress cannot resume");
    this.paused = false;
    this.updateIngress();
  }
  beginStopping(): void {
    this.stopping = true;
    this.state = "stopping";
    this.updateIngress();
  }
  stop(): Promise<void> {
    this.stopPromise ??= this.stopAdapters();
    return this.stopPromise;
  }
  private async stopAdapters(): Promise<void> {
    this.beginStopping();
    await this.startPromise;
    const results = await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        if (!adapter.enabled || adapter.configurationError) return;
        this.patch(adapter.adapterId, { lifecycle: "stopping" });
        this.logState(adapter.adapterId, "stopping", "debug");
        try {
          await adapter.stop();
          this.patch(adapter.adapterId, {
            lifecycle: "stopped",
            connectivity:
              adapter.platform === "web" ? "not_applicable" : "disconnected",
          });
          this.logState(adapter.adapterId, "stopped", "info");
        } catch {
          this.patch(adapter.adapterId, {
            lifecycle: "failed",
            errorType: "stop_failed",
          });
          this.logState(adapter.adapterId, "failed", "warn");
          throw new Error("Adapter stop failed");
        }
      }),
    );
    this.state = "stopped";
    if (results.some((r) => r.status === "rejected"))
      throw new Error("Adapter shutdown failed");
  }
  private ingressState(): AdapterSnapshot["ingress"] {
    return this.stopping || this.paused
      ? "stopping"
      : this.runtime
        ? "ready"
        : "runtime_unavailable";
  }
  private updateIngress(): void {
    for (const id of this.snapshots.keys()) this.patch(id, {});
  }
  private patch(id: string, patch: Partial<AdapterSnapshot>): void {
    const previous = this.snapshots.get(id)!;
    const clean =
      patch.lifecycle === "stopped" ||
      patch.lifecycle === "stopping" ||
      patch.lifecycle === "failed"
        ? (({ attempt: _a, nextRetryAt: _n, errorType: _e, ...base }) => base)(
            previous,
          )
        : previous;
    this.snapshots.set(id, {
      ...clean,
      ...patch,
      ingress: this.ingressState(),
      updatedAt: this.now().toISOString(),
    });
  }
  private connectionStatus(id: string, status: AdapterConnectionStatus): void {
    const previous = this.snapshots.get(id)!;
    const { attempt: _a, nextRetryAt: _n, errorType: _e, ...base } = previous;
    this.snapshots.set(id, {
      ...base,
      connectivity: status.connectivity,
      ...(status.attempt === undefined ? {} : { attempt: status.attempt }),
      ...(status.nextRetryAt === undefined
        ? {}
        : { nextRetryAt: status.nextRetryAt }),
      ...(status.errorType === undefined
        ? {}
        : { errorType: status.errorType }),
      ingress: this.ingressState(),
      updatedAt: this.now().toISOString(),
    });
    const event =
      status.connectivity === "retrying"
        ? "reconnect.scheduled"
        : status.connectivity;
    this.logState(
      id,
      event,
      status.connectivity === "connecting" || status.connectivity === "retrying"
        ? "debug"
        : "info",
    );
    if (status.errorType) this.logState(id, "failed", "warn");
  }
  private logState(
    id: string,
    event: string,
    level: "info" | "debug" | "warn",
    extra: Record<string, unknown> = {},
  ): void {
    const snapshot = this.snapshots.get(id)!;
    createModuleLogger(this.logger, `adapter:${snapshot.type}`)[level](
      { event: `${snapshot.type}.connection.${event}`, ...snapshot, ...extra },
      "Adapter state updated",
    );
  }
  private logInbound(
    message: PlatformInboundMessage,
    stage: string,
    extra: Record<string, unknown> = {},
  ): void {
    const type = this.adapters.get(message.adapterId)?.type ?? message.platform;
    const logger = createModuleLogger(this.logger, `adapter:${type}`);
    logger[stage === "failed" ? "warn" : "info"](
      {
        event: `${type}.inbound.${stage}`,
        adapterId: message.adapterId,
        platform: message.platform,
        platformMessageId: message.platformMessageId,
        selfId: message.selfId,
        senderId: message.sender.userId,
        targetKind: message.target.kind,
        messageText: message.text,
        target: message.target,
        occurredAt: message.occurredAt,
        ...extra,
      },
      "Adapter inbound message",
    );
  }
  /** Called once after normalization. Web bypasses the platform allowlist. */
  acceptInbound(message: PlatformInboundMessage): boolean {
    const allowed =
      message.platform === "web" || this.allowlist.allows(message);
    if (!allowed) this.logInbound(message, "filtered");
    return allowed;
  }
  private assertReady(message: PlatformInboundMessage): InformationIngress {
    if (!this.stopping && !this.paused && this.runtime) return this.runtime;
    const reason = this.stopping || this.paused ? "stopping" : this.reason;
    this.logInbound(message, "failed", {
      errorType: "runtime_unavailable",
      reason,
    });
    throw new AdapterIngressUnavailableError(reason);
  }
  readonly ingress: InformationIngress = {
    submit: async (message) => {
      const runtime = this.assertReady(message);
      try {
        const receipt = await runtime.submit(message);
        this.logInbound(message, "submitted", {
          rootInformationId: receipt.rootInformationId,
        });
        return receipt;
      } catch {
        this.logInbound(message, "failed", { errorType: "submission_failed" });
        throw new Error("Adapter submission failed");
      }
    },
  };
  readonly webGateway: WebMessageGateway = {
    ingest: (input) => {
      const message = normalizeWebInboundMessage(input, {
        adapterId: "web.ui.main",
      });
      if (!message) throw new Error("Web inbound message is invalid");
      this.acceptInbound(message);
      this.assertReady(message);
      void this.ingress.submit(message).catch(() => {});
    },
  };
}
