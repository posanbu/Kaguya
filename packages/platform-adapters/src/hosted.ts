/**
 * 功能概述：定义进程宿主拥有的 adapter 生命周期、连接状态与可选只读目录。
 * 主要职责：HostedAdapter 将 start/stop、transport 和 targetDirectory 交给 AdapterHost；状态类型描述可用性。
 * 代码库关系：Server 管理连接，Runtime 仅消费正规化出口；目录不代表授权。
 * 输入输出与副作用：纯类型契约；不可用目录由实现拒绝查询。
 */
import type { TargetDirectory } from "./targets.js";
import type { PlatformName, PlatformOutboundTransport } from "./types.js";

export type AdapterLifecycle =
  "disabled" | "starting" | "running" | "stopping" | "stopped" | "failed";
export type AdapterConnectivity =
  "not_applicable" | "connecting" | "connected" | "retrying" | "disconnected";
export type AdapterIngress = "ready" | "runtime_unavailable" | "stopping";
export type RuntimeUnavailableReason =
  "configuration_not_ready" | "database_unavailable" | "runtime_start_failed";
export type AdapterErrorType =
  | "configuration_invalid"
  | "connection_failed"
  | "start_failed"
  | "stop_failed";
export interface AdapterConnectionStatus {
  readonly connectivity: AdapterConnectivity;
  readonly attempt?: number;
  readonly nextRetryAt?: string;
  readonly errorType?: AdapterErrorType;
}
export interface HostedAdapter {
  readonly adapterId: string;
  readonly type: string;
  readonly platform: PlatformName;
  readonly enabled: boolean;
  readonly configurationError?: "configuration_invalid";
  readonly targetDirectory?: TargetDirectory;
  readonly outboundTransport?: PlatformOutboundTransport;
  start(reportStatus: (status: AdapterConnectionStatus) => void): Promise<void>;
  stop(): Promise<void>;
}
export interface AdapterSnapshot extends AdapterConnectionStatus {
  readonly adapterId: string;
  readonly type: string;
  readonly platform: PlatformName;
  readonly enabled: boolean;
  readonly lifecycle: AdapterLifecycle;
  readonly ingress: AdapterIngress;
  readonly updatedAt: string;
}
export interface AdapterHostStatus {
  readonly adapterHostState: AdapterLifecycle;
  readonly runtime: {
    readonly ingress: AdapterIngress;
    readonly reason?: RuntimeUnavailableReason;
  };
  readonly adapters: readonly AdapterSnapshot[];
}
export class AdapterIngressUnavailableError extends Error {
  readonly code = "runtime_unavailable";
  constructor(readonly reason: RuntimeUnavailableReason | "stopping") {
    super("Runtime ingress is unavailable");
    this.name = "AdapterIngressUnavailableError";
  }
}
