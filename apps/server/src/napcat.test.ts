import type {
  JsonMessageTransport,
  PlatformDeliveryReceipt,
  PlatformReplySender,
} from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NapCatConnectionSupervisor,
  WebSocketJsonTransport,
} from "./napcat.js";

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;

  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  FakeWebSocket.latest = undefined;
});

describe("WebSocketJsonTransport", () => {
  it("ignores malformed JSON WebSocket messages", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const transport = new WebSocketJsonTransport("ws://127.0.0.1:3001");
    const received: unknown[] = [];
    transport.onJsonMessage((message) => received.push(message));

    expect(() => {
      FakeWebSocket.latest?.emit("message", { data: "{not-json" });
    }).not.toThrow();
    expect(received).toEqual([]);
  });

  it("does not swallow errors thrown by a JSON message handler", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const transport = new WebSocketJsonTransport("ws://127.0.0.1:3001");
    const handlerError = new Error("dispatch failed");
    transport.onJsonMessage(() => {
      throw handlerError;
    });

    expect(() => {
      FakeWebSocket.latest?.emit("message", { data: '{"message_id":"12345"}' });
    }).toThrow(handlerError);
  });

  it("bridges JSON messages through a token-authenticated WebSocket", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const transport = new WebSocketJsonTransport(
      "ws://127.0.0.1:3001/socket?existing=value",
      "secret-token",
    );
    const received: unknown[] = [];
    let closeError: Error | undefined;
    transport.onJsonMessage((message) => received.push(message));
    transport.onClose((error) => {
      closeError = error;
    });

    transport.sendJson({ action: "send_msg" });
    FakeWebSocket.latest?.emit("message", { data: '{"message_id":"12345"}' });
    FakeWebSocket.latest?.emit("error");
    transport.close();

    expect(FakeWebSocket.latest?.url).toBe(
      "ws://127.0.0.1:3001/socket?existing=value&access_token=secret-token",
    );
    expect(FakeWebSocket.latest?.sent).toEqual(['{"action":"send_msg"}']);
    expect(received).toEqual([{ message_id: "12345" }]);
    expect(closeError?.message).toBe("NapCat WebSocket error");
    expect(FakeWebSocket.latest?.closed).toBe(true);
  });
});

class SupervisorTransport implements JsonMessageTransport {
  private readonly closeHandlers = new Set<(error?: Error) => void>();

  sendJson(): void {}

  onJsonMessage(): void {}

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {}

  disconnect(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

describe("NapCatConnectionSupervisor", () => {
  it("recreates the full connection after the configured delay and cancels reconnect on stop", async () => {
    vi.useFakeTimers();
    const connections: Array<{
      transport: SupervisorTransport;
      sender: PlatformReplySender;
      adapter: {
        starts: number;
        stops: number;
        start(): Promise<void>;
        stop(): Promise<void>;
      };
    }> = [];
    const supervisor = new NapCatConnectionSupervisor({
      adapterId: "napcat.qq.main",
      reconnectMs: 250,
      createConnection: () => {
        const connectionNumber = connections.length + 1;
        const transport = new SupervisorTransport();
        const sender: PlatformReplySender = {
          async sendTextReply(target): Promise<PlatformDeliveryReceipt> {
            return {
              ok: true,
              adapterId: "napcat.qq.main",
              platform: "qq",
              target,
              platformMessageId: `connection-${connectionNumber}`,
            };
          },
        };
        const adapter = {
          starts: 0,
          stops: 0,
          async start() {
            this.starts += 1;
          },
          async stop() {
            this.stops += 1;
          },
        };
        const connection = { transport, sender, adapter };
        connections.push(connection);
        return connection;
      },
    });

    try {
      await supervisor.start();
      expect(connections).toHaveLength(1);
      expect(connections[0]?.adapter.starts).toBe(1);

      connections[0]?.transport.disconnect(new Error("socket closed"));
      await vi.advanceTimersByTimeAsync(249);
      expect(connections).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toHaveLength(2);
      expect(connections[0]?.adapter.stops).toBe(1);
      expect(connections[1]?.adapter.starts).toBe(1);
      await expect(
        supervisor.sendTextReply({ kind: "private", userId: "112233" }, "hi"),
      ).resolves.toMatchObject({ platformMessageId: "connection-2" });

      await supervisor.stop();
      connections[1]?.transport.disconnect();
      await vi.advanceTimersByTimeAsync(250);
      expect(connections).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
