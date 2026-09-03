/**
 * 功能概述：在 Server 侧组合 NapCat WebSocket JSON transport、OneBot adapter、
 * action client 与可重连 supervisor，入站端只接收窄 `InformationIngress`，出站只实现
 * `PlatformOutboundTransport.sendMessage`。
 * 主要职责：`WebSocketJsonTransport` 处理 token URL、JSON frame 与 close/error；
 * `NapCatConnectionSupervisor` 创建、退役和重建整条连接，同时实现 Runtime 的出站 transport；
 * `createNapCatSupervisor` 在正规化 frame 后先执行 Server 注入的 allowlist 谓词，再交给
 * ingress，并为连接/提交失败记录安全上下文。
 * 代码库关系：复用 `@kaguya/platform-adapters` 的 NapCat adapter/action client；
 * `server.ts` 传入统一 ingress，并将返回的 supervisor 注册为 Runtime 出站 transport。
 * 输入输出与副作用：会建立 WebSocket、写出 JSON、设置重连/超时计时器并在
 * stop 时排空退役；日志不保留消息正文、access token 或 Core trace identity。
 */
import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type InformationIngress,
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
  readonly sender: PlatformOutboundTransport;
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

export class NapCatConnectionSupervisor implements PlatformOutboundTransport {
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
  readonly ingress: InformationIngress;
  readonly logger: KaguyaLogger;
  readonly allowsInbound?: (message: PlatformInboundMessage) => boolean;
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
        ingress: options.ingress,
        ...(options.allowsInbound === undefined
          ? {}
          : { allowsInbound: options.allowsInbound }),
        onInboundError: (error, context) => {
          options.logger.error(
            {
              event: "napcat.inbound.failed",
              platformMessageId: context.platformMessageId,
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
