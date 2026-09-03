/**
 * 功能概述：验证 Server 侧 NapCat WebSocket transport、连接重建与窄
 * `InformationIngress` 组合，防止平台连接获得完整 Runtime 或业务模块。
 * 主要职责：覆盖 JSON 解析、access token URL、transport 异常透传、
 * supervisor 重连/退役/停止，以及真实 OneBot frame 到 `ingress.submit` 的连接。
 * 代码库关系：直接驱动 `napcat.ts`，并经由 platform-adapters 的
 * `NapCatOneBotAdapter` 正规化入站消息；Server 启动时只注入 ingress 与 logger。
 * 输入输出与副作用：用内存 FakeWebSocket/transport 触发连接事件和计时器；
 * 测试结束会恢复全局 WebSocket 并停止 supervisor。
 */
import { closeLogger, createLogger } from "@kaguya/logger";
import type {
  InformationIngress,
  JsonMessageTransport,
  PlatformInboundMessage,
  PlatformDeliveryReceipt,
  PlatformOutboundTransport,
} from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNapCatSupervisor,
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

it("submits NapCat frames through the ingress without a Runtime dependency", async () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const submitted: PlatformInboundMessage[] = [];
  const ingress: InformationIngress = {
    submit: async (message) => {
      submitted.push(message);
      return { rootInformationId: "information-1", deliveries: [] };
    },
  };
  const logger = createLogger({
    service: "napcat-composition-test",
    level: "silent",
  });
  const supervisor = createNapCatSupervisor({
    config: {
      enabled: true,
      adapterId: "napcat.qq.main",
      wsUrl: "ws://127.0.0.1:3001",
      selfId: "998877",
      reconnectMs: 250,
    },
    ingress,
    logger,
  });

  await supervisor.start();
  FakeWebSocket.latest?.emit("message", {
    data: JSON.stringify({
      post_type: "message",
      message_type: "private",
      self_id: 998877,
      message_id: 12345,
      user_id: 112233,
      message: "hello",
    }),
  });
  await vi.waitFor(() => expect(submitted).toHaveLength(1));

  expect(submitted[0]).toMatchObject({
    adapterId: "napcat.qq.main",
    platformMessageId: "12345",
    text: "hello",
  });
  expect(submitted[0]).not.toHaveProperty("traceId");
  await supervisor.stop();
  await closeLogger(logger);
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
      sender: PlatformOutboundTransport;
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
        const sender: PlatformOutboundTransport = {
          async sendMessage(target): Promise<PlatformDeliveryReceipt> {
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
        supervisor.sendMessage(
          { kind: "private", userId: "112233" },
          { kind: "text", text: "hi" },
        ),
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
