import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
  type PlatformDeliveryReceipt,
  type PlatformMessageTarget,
  type PlatformOutboundTransport,
  type PlatformReplySender,
} from "@kaguya/platform-adapters";
import type { OutboundMessageContent } from "@kaguya/schema";
import type { KaguyaLogger } from "@kaguya/logger";
import type { KaguyaRuntime } from "@kaguya/runtime";

import type { NapCatConfig } from "./config.js";

export class WebSocketJsonTransport implements JsonMessageTransport {
  private messageHandler: ((message: unknown) => void) | undefined;
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly socket: WebSocket;

  constructor(url: string, accessToken?: string) {
    this.socket = new WebSocket(withAccessToken(url, accessToken));
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

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.socket.close();
  }

  private notifyClose(error?: Error): void {
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
  readonly sender: PlatformReplySender | PlatformOutboundTransport;
  readonly adapter: NapCatManagedAdapter;
}

export interface NapCatConnectionSupervisorOptions {
  readonly adapterId: string;
  readonly reconnectMs: number;
  readonly createConnection: () => NapCatConnection;
  readonly onConnected?: () => void;
  readonly onDisconnected?: (error?: Error) => void;
  readonly onReconnectScheduled?: (delayMs: number) => void;
  readonly onConnectionError?: (error: unknown) => void;
}

export class NapCatConnectionSupervisor
  implements PlatformReplySender, PlatformOutboundTransport
{
  private connection: NapCatConnection | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly retirements = new Map<NapCatConnection, Promise<void>>();
  private stopping = true;

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

  async sendTextReply(
    target: PlatformMessageTarget,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<PlatformDeliveryReceipt> {
    return this.sendMessage(target, { kind: "text", text }, metadata);
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
    if ("sendMessage" in sender) {
      return sender.sendMessage(target, message, metadata);
    }
    return sender.sendTextReply(target, message.text, metadata);
  }

  private async connect(): Promise<void> {
    if (this.stopping) {
      return;
    }
    let connection: NapCatConnection | undefined;
    try {
      const createdConnection = this.options.createConnection();
      connection = createdConnection;
      this.connection = createdConnection;
      createdConnection.transport.onClose((error) => {
        this.handleDisconnect(createdConnection, error);
      });
      await createdConnection.adapter.start();
      this.options.onConnected?.();
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
  readonly runtime: KaguyaRuntime;
  readonly logger: KaguyaLogger;
}): NapCatConnectionSupervisor {
  let supervisor: NapCatConnectionSupervisor;
  supervisor = new NapCatConnectionSupervisor({
    adapterId: options.config.adapterId,
    reconnectMs: options.config.reconnectMs,
    createConnection: () => {
      const transport = new WebSocketJsonTransport(
        options.config.wsUrl ?? "",
        options.config.accessToken,
      );
      const actionClient = new NapCatActionClient({
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
        onInboundMessage: (message) =>
          options.runtime
            .dispatch({
              kind: "platform",
              message,
            })
            .then(() => undefined),
        onInboundError: (error, context) => {
          options.logger.error(
            {
              event: "napcat.inbound.failed",
              traceId: context.traceId,
              adapterId: context.adapterId,
              err: error,
            },
            "NapCat inbound dispatch failed",
          );
        },
      });
      return { transport, sender: actionClient, adapter };
    },
    onConnected: () => {
      options.logger.info(
        {
          event: "napcat.connection.connected",
          adapterId: options.config.adapterId,
        },
        "NapCat connection established",
      );
    },
    onDisconnected: (error) => {
      options.logger.warn(
        {
          event: "napcat.connection.disconnected",
          adapterId: options.config.adapterId,
          ...(error === undefined ? {} : { err: error }),
        },
        "NapCat connection closed",
      );
    },
    onReconnectScheduled: (delayMs) => {
      options.logger.info(
        {
          event: "napcat.reconnect.scheduled",
          adapterId: options.config.adapterId,
          delayMs,
        },
        "NapCat reconnect scheduled",
      );
    },
    onConnectionError: (error) => {
      options.logger.warn(
        {
          event: "napcat.connection.failed",
          adapterId: options.config.adapterId,
          err: error,
        },
        "NapCat connection failed",
      );
    },
  });
  return supervisor;
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
