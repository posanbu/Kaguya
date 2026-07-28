import { afterEach, describe, expect, it } from "vitest";

import { WebSocketJsonTransport } from "./server.js";

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
