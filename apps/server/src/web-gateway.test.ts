/**
 * 功能概述：验证 Web 消息网关只依赖 `InformationIngress`，将 HTTP
 * 输入正规化后异步提交，不获得完整 Runtime 能力也不制造 Core 身份。
 * 主要职责：覆盖正常 submit、异步拒绝日志和无效输入短路；断言
 * 外部 request ID 保留为 `platformMessageId`，提交值不含 `traceId`/`informationId`。
 * 代码库关系：直接测试 `web-gateway.ts`，其输入由 platform-adapters 正规化；
 * `app.ts` 在 HTTP 202 路径调用此窄网关。
 * 输入输出与副作用：内存 ingress double 记录提交，Pino 流收集脱敏错误日志；
 * 正常 ingest 保持非阻塞，失败不同步抛回 HTTP 调用方。
 */
import { Writable } from "node:stream";

import { closeLogger, createLogger } from "@kaguya/logger";
import type {
  InboundReceipt,
  InformationIngress,
  PlatformInboundMessage,
} from "@kaguya/platform-adapters";
import { afterEach, afterAll, describe, expect, it, vi } from "vitest";

import { createWebMessageGateway } from "./web-gateway.js";

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
  it("submits normalized content through the ingress only", async () => {
    const submitted: PlatformInboundMessage[] = [];
    const gateway = gatewayWith(async (input) => {
      submitted.push(input);
      return receipt;
    });

    gateway.ingest({ text: "hello from web", requestId: "request-1" });

    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toEqual({
      platform: "web",
      adapterId: "web.ui.main",
      platformMessageId: "request-1",
      occurredAt: expect.any(String),
      text: "hello from web",
      mentions: [],
      target: { kind: "web" },
      sender: { userId: "web" },
      raw: { text: "hello from web", requestId: "request-1" },
    });
    expect(submitted[0]).not.toHaveProperty("traceId");
    expect(submitted[0]).not.toHaveProperty("informationId");
  });

  it("logs a submission rejection without manufacturing trace context", async () => {
    const submit = vi.fn(() => Promise.reject(new Error("dispatch exploded")));
    const gateway = gatewayWith(submit);

    expect(() =>
      gateway.ingest({ text: "hello", requestId: "request-2" }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(stream.logs()).toContainEqual(
        expect.objectContaining({
          event: "web.inbound.failed",
          platformMessageId: "request-2",
          adapterId: "web.ui.main",
        }),
      );
    });
    expect(JSON.stringify(stream.logs())).not.toContain("traceId");
  });

  it("rejects invalid input before touching the ingress", () => {
    const submit = vi.fn(async () => receipt);
    const gateway = gatewayWith(submit);

    expect(() =>
      gateway.ingest({ text: "   ", requestId: "request-3" }),
    ).toThrow("Web inbound message is invalid");
    expect(submit).not.toHaveBeenCalled();
  });
});

const receipt: InboundReceipt = {
  rootInformationId: "information-1",
  deliveries: [],
};

function gatewayWith(submit: InformationIngress["submit"]) {
  return createWebMessageGateway({
    adapterId: "web.ui.main",
    ingress: { submit },
    logger: rootLogger,
  });
}
