/** WebSocket transport and reconnect supervisor. AdapterHost owns inbound policy and diagnostics; connected requires socket open. */
import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type InformationIngress,
  type AdapterConnectionStatus,
  type JsonMessageTransport,
  type PlatformDeliveryReceipt,
  type PlatformInboundMessage,
  type PlatformMessageTarget,
  type PlatformOutboundTransport,
} from "@kaguya/platform-adapters";
import type { OutboundMessageContent } from "@kaguya/schema";
import type { KaguyaLogger } from "@kaguya/logger";

import type { NapCatConfig } from "./config.js";

export class WebSocketJsonTransport implements JsonMessageTransport {
  private messageHandler: ((message: unknown) => void) | undefined;
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly socket: WebSocket;
  private readonly openHandlers = new Set<() => void>();
  private closed = false;

  constructor(url: string, accessToken?: string) {
    this.socket = new WebSocket(withAccessToken(url, accessToken));
    this.socket.addEventListener("open", () => {
      if (!this.closed) for (const handler of this.openHandlers) handler();
    });
    this.socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.messageHandler?.(message);
    });
    this.socket.addEventListener("close", () => this.notifyClose());
    this.socket.addEventListener("error", () => {
      this.notifyClose(new Error("NapCat WebSocket error"));
    });
  }

  sendJson(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  onJsonMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandlers.add(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.socket.close();
  }

  private notifyClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

export interface NapCatManagedAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface NapCatConnection {
  readonly transport: JsonMessageTransport;
  readonly sender: PlatformOutboundTransport;
  readonly adapter: NapCatManagedAdapter;
}

export interface NapCatConnectionSupervisorOptions {
  readonly adapterId: string;
  readonly reconnectMs: number;
  readonly createConnection: () => NapCatConnection;
  readonly onConnecting?: (attempt: number) => void;
  readonly onConnected?: () => void;
  readonly onDisconnected?: (error?: Error) => void;
  readonly onReconnectScheduled?: (delayMs: number) => void;
  readonly onConnectionError?: (error: unknown) => void;
}

export class NapCatConnectionSupervisor implements PlatformOutboundTransport {
  private connection: NapCatConnection | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly retirements = new Map<NapCatConnection, Promise<void>>();
  private stopping = true;
  private attempt = 0;

  constructor(private readonly options: NapCatConnectionSupervisorOptions) {}

  async start(): Promise<void> {
    if (!this.stopping) {
      return;
    }
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) {
      void this.retire(connection);
    }
    await Promise.allSettled([...this.retirements.values()]);
  }

  async sendMessage(
    target: PlatformMessageTarget,
    message: OutboundMessageContent,
    metadata?: Record<string, unknown>,
  ): Promise<PlatformDeliveryReceipt> {
    const sender = this.connection?.sender;
    if (sender === undefined) {
      return {
        ok: false,
        adapterId: this.options.adapterId,
        platform: "qq",
        target,
        error: "NapCat connection unavailable",
      };
    }
    return sender.sendMessage(target, message, metadata);
  }

  private async connect(): Promise<void> {
    if (this.stopping) {
      return;
    }
    let connection: NapCatConnection | undefined;
    this.options.onConnecting?.(++this.attempt);
    try {
      const createdConnection = this.options.createConnection();
      connection = createdConnection;
      this.connection = createdConnection;
      createdConnection.transport.onClose((error) => {
        this.handleDisconnect(createdConnection, error);
      });
      createdConnection.transport.onOpen?.(() => {
        if (!this.stopping && this.connection === createdConnection)
          this.options.onConnected?.();
      });
      await createdConnection.adapter.start();
      if (this.stopping || this.connection !== createdConnection) {
        if (this.connection === createdConnection) {
          this.connection = undefined;
        }
        void this.retire(createdConnection);
      }
    } catch (error) {
      if (connection !== undefined && this.connection === connection) {
        this.connection = undefined;
        void this.retire(connection);
      }
      this.reportConnectionError(error);
      this.scheduleReconnect();
    }
  }

  private handleDisconnect(connection: NapCatConnection, error?: Error): void {
    if (this.stopping || this.connection !== connection) {
      return;
    }
    this.connection = undefined;
    void this.retire(connection);
    this.options.onDisconnected?.(error);
    if (error !== undefined) {
      this.reportConnectionError(error);
    }
    this.scheduleReconnect();
  }

  private retire(connection: NapCatConnection): Promise<void> {
    const existing = this.retirements.get(connection);
    if (existing !== undefined) {
      return existing;
    }
    const retirement = connection.adapter
      .stop()
      .catch((error: unknown) => this.reportConnectionError(error))
      .finally(() => this.retirements.delete(connection));
    this.retirements.set(connection, retirement);
    return retirement;
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== undefined) {
      return;
    }
    this.options.onReconnectScheduled?.(this.options.reconnectMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.options.reconnectMs);
  }

  private reportConnectionError(error: unknown): void {
    try {
      this.options.onConnectionError?.(error);
    } catch {
      // Diagnostics must not interrupt reconnect or shutdown.
    }
  }
}

export function createNapCatSupervisor(options: {
  readonly config: NapCatConfig;
  readonly ingress: InformationIngress;
  readonly logger: KaguyaLogger;
  readonly allowsInbound?: (message: PlatformInboundMessage) => boolean;
  readonly reportStatus?: (status: AdapterConnectionStatus) => void;
}): NapCatConnectionSupervisor {
  let attempt = 0;
  return new NapCatConnectionSupervisor({
    adapterId: options.config.adapterId,
    reconnectMs: options.config.reconnectMs,
    createConnection: () => {
      const transport = new WebSocketJsonTransport(
        options.config.wsUrl ?? "",
        options.config.accessToken,
      );
      const sender = new NapCatActionClient({
        adapterId: options.config.adapterId,
        transport,
        nextEcho: createEchoFactory(),
        timeoutMs: 30_000,
      });
      const adapter = new NapCatOneBotAdapter({
        adapterId: options.config.adapterId,
        ...(options.config.selfId === undefined
          ? {}
          : { expectedSelfId: options.config.selfId }),
        transport,
        now: () => new Date(),
        ingress: options.ingress,
        ...(options.allowsInbound
          ? { allowsInbound: options.allowsInbound }
          : {}),
      });
      return { transport, sender, adapter };
    },
    onConnecting: (value) => {
      attempt = value;
      options.reportStatus?.({ connectivity: "connecting", attempt });
    },
    onConnected: () =>
      options.reportStatus?.({ connectivity: "connected", attempt }),
    onDisconnected: () =>
      options.reportStatus?.({ connectivity: "disconnected", attempt }),
    onReconnectScheduled: (delayMs) =>
      options.reportStatus?.({
        connectivity: "retrying",
        attempt,
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      }),
    onConnectionError: () =>
      options.reportStatus?.({
        connectivity: "disconnected",
        attempt,
        errorType: "connection_failed",
      }),
  });
}

function withAccessToken(url: string, accessToken?: string): string {
  if (accessToken === undefined) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set("access_token", accessToken);
  return parsed.toString();
}

function createEchoFactory(): () => string {
  let sequence = 0;
  return () => `napcat-${Date.now()}-${++sequence}`;
}
