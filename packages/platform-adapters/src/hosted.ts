/** Runtime-independent contracts for adapters owned by a process-local host. */
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
