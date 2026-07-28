import { pathToFileURL } from "node:url";

import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
  type PlatformDeliveryReceipt,
  type PlatformMessageTarget,
  type PlatformReplySender,
} from "@kaguya/platform-adapters";
import {
  closeLogger,
  createLogger,
  createModuleLogger,
  readLoggerOptions,
  type KaguyaLogger,
} from "@kaguya/logger";

import { readBotConfig } from "./config.js";
import { PlatformDispatcher } from "./dispatcher.js";

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
    this.socket.addEventListener("close", () => {
      this.notifyClose();
    });
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
  readonly sender: PlatformReplySender;
  readonly adapter: NapCatManagedAdapter;
}

export interface NapCatConnectionSupervisorOptions {
  readonly adapterId: string;
  readonly reconnectMs: number;
  readonly createConnection: () => NapCatConnection;
  readonly onConnectionError?: (error: unknown) => void;
}

export class NapCatConnectionSupervisor implements PlatformReplySender {
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
    return sender.sendTextReply(target, text, metadata);
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
      .catch((error: unknown) => {
        this.reportConnectionError(error);
      })
      .finally(() => {
        this.retirements.delete(connection);
      });
    this.retirements.set(connection, retirement);
    return retirement;
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== undefined) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.options.reconnectMs);
  }

  private reportConnectionError(error: unknown): void {
    try {
      this.options.onConnectionError?.(error);
    } catch {
      // Runtime diagnostics must not interrupt reconnect or shutdown.
    }
  }
}

export async function startBot(): Promise<void> {
  const config = readBotConfig();
  const rootLogger = createLogger(readLoggerOptions("kaguya-bot"));
  const logger = createModuleLogger(rootLogger, "bot");

  if (!config.napcat.enabled) {
    const dispatcher = PlatformDispatcher.createForDeterministicModel({
      databasePath: config.databasePath,
      logger,
    });
    let closePromise: Promise<void> | undefined;
    const close = () => {
      closePromise ??= (async () => {
        dispatcher.close();
        await closeLogger(rootLogger);
      })();
      return closePromise;
    };
    registerShutdownHandlers(close, logger);
    return;
  }

  let dispatcher: PlatformDispatcher;
  const supervisor = new NapCatConnectionSupervisor({
    adapterId: config.napcat.adapterId,
    reconnectMs: config.napcat.reconnectMs,
    createConnection: () => {
      const transport = new WebSocketJsonTransport(
        config.napcat.wsUrl ?? "",
        config.napcat.accessToken,
      );
      const actionClient = new NapCatActionClient({
        adapterId: config.napcat.adapterId,
        transport,
        nextEcho: createEchoFactory(),
        timeoutMs: 30_000,
      });
      const adapter = new NapCatOneBotAdapter({
        adapterId: config.napcat.adapterId,
        ...(config.napcat.selfId === undefined
          ? {}
          : { expectedSelfId: config.napcat.selfId }),
        transport,
        now: () => new Date(),
        onInboundMessage: (message) =>
          dispatcher.dispatchInboundMessage(message),
        onInboundError: (error, context) => {
          logger.error(
            {
              event: "platform.inbound.dispatch.failed",
              traceId: context.traceId,
              adapterId: context.adapterId,
              err: error,
            },
            "Inbound platform dispatch failed",
          );
        },
      });
      return { transport, sender: actionClient, adapter };
    },
    onConnectionError: (error) => {
      logger.warn(
        { event: "platform.connection.failed", err: error },
        "NapCat connection failed",
      );
    },
  });
  dispatcher = PlatformDispatcher.createForDeterministicModel({
    databasePath: config.databasePath,
    logger,
    platformReplySender: supervisor,
  });
  await supervisor.start();

  let closePromise: Promise<void> | undefined;
  const close = async () => {
    closePromise ??= (async () => {
      await supervisor.stop();
      dispatcher.close();
      await closeLogger(rootLogger);
    })();
    await closePromise;
  };
  registerShutdownHandlers(close, logger);
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

function registerShutdownHandlers(
  close: () => Promise<void>,
  logger: KaguyaLogger,
): void {
  const shutdown = () => {
    void close().catch((error: unknown) => {
      process.exitCode = 1;
      logger.fatal(
        { event: "bot.shutdown.failed", err: error },
        "Bot shutdown failed",
      );
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await startBot();
  }
}
