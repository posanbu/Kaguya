import { pathToFileURL } from "node:url";

import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
} from "@kaguya/platform-adapters";

import { readBotConfig } from "./config.js";
import { PlatformDispatcher } from "./dispatcher.js";

export class WebSocketJsonTransport implements JsonMessageTransport {
  private messageHandler: ((message: unknown) => void) | undefined;
  private closeHandler: ((error?: Error) => void) | undefined;
  private readonly socket: WebSocket;

  constructor(url: string, accessToken?: string) {
    this.socket = new WebSocket(withAccessToken(url, accessToken));
    this.socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data) {
        return;
      }
      this.messageHandler?.(JSON.parse(data));
    });
    this.socket.addEventListener("close", () => {
      this.closeHandler?.();
    });
    this.socket.addEventListener("error", () => {
      this.closeHandler?.(new Error("NapCat WebSocket error"));
    });
  }

  sendJson(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  onJsonMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.socket.close();
  }
}

export async function startBot(): Promise<void> {
  const config = readBotConfig();
  if (!config.napcat.enabled) {
    const dispatcher = PlatformDispatcher.createForDeterministicModel({
      databasePath: config.databasePath,
    });
    process.once("SIGINT", () => dispatcher.close());
    process.once("SIGTERM", () => dispatcher.close());
    return;
  }

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
  const dispatcher = PlatformDispatcher.createForDeterministicModel({
    databasePath: config.databasePath,
    platformReplySender: actionClient,
  });
  const adapter = new NapCatOneBotAdapter({
    adapterId: config.napcat.adapterId,
    transport,
    now: () => new Date(),
    onInboundMessage: (message) => dispatcher.dispatchInboundMessage(message),
  });
  await adapter.start();

  const close = async () => {
    await adapter.stop();
    dispatcher.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
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

if (process.argv[1] !== undefined) {
  const entrypointUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === entrypointUrl) {
    await startBot();
  }
}
