import { Writable } from "node:stream";

import { closeLogger, createLogger } from "@kaguya/logger";
import type {
  KaguyaRuntime,
  RuntimeInboundMessage,
} from "@kaguya/runtime";
import { afterEach, afterAll, describe, expect, it, vi } from "vitest";

import { createWebMessageGateway } from "./web-gateway.js";

const stream = new LogStream();
const rootLogger = createLogger({
  service: "kaguya-web-gateway-test",
  stream,
});

afterEach(() => {
  stream.clear();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeLogger(rootLogger);
});

describe("createWebMessageGateway", () => {
  it("dispatches a normalized web platform message through the runtime", () => {
    const dispatch = vi.fn(async () => ({}));
    const gateway = gatewayWith(dispatch);

    gateway.ingest({ text: "hello from web", requestId: "request-1" });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "platform",
      message: {
        platform: "web",
        adapterId: "web.ui.main",
        traceId: "web:request-1",
        platformMessageId: "request-1",
        occurredAt: expect.any(String),
        text: "hello from web",
        mentions: [],
        target: { kind: "web" },
        sender: { userId: "web" },
        raw: { text: "hello from web", requestId: "request-1" },
      },
    });
  });

  it("logs a dispatch rejection instead of throwing", async () => {
    const dispatch = vi.fn(() =>
      Promise.reject(new Error("dispatch exploded")),
    );
    const gateway = gatewayWith(dispatch);

    expect(() =>
      gateway.ingest({ text: "hello", requestId: "request-2" }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(stream.logs()).toContainEqual(
        expect.objectContaining({
          event: "web.inbound.failed",
          traceId: "web:request-2",
          adapterId: "web.ui.main",
        }),
      );
    });
  });

  it("rejects invalid input before touching the runtime", () => {
    const dispatch = vi.fn(async () => ({}));
    const gateway = gatewayWith(dispatch);

    expect(() =>
      gateway.ingest({ text: "   ", requestId: "request-3" }),
    ).toThrow("Web inbound message is invalid");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function gatewayWith(
  dispatch: (message: RuntimeInboundMessage) => Promise<unknown>,
) {
  return createWebMessageGateway({
    adapterId: "web.ui.main",
    runtime: { dispatch } as unknown as KaguyaRuntime,
    logger: rootLogger,
  });
}

class LogStream extends Writable {
  readonly #chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.#chunks.push(chunk.toString());
    callback();
  }

  clear(): void {
    this.#chunks.splice(0);
  }

  logs(): Record<string, unknown>[] {
    return this.#chunks
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
