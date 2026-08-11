import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  closeLogger,
  createLogger,
  createModuleLogger,
  getLogContext,
  readLoggerOptions,
  runWithLogContext,
} from "./index.js";

describe("Kaguya logger", () => {
  it("writes structured JSON with service and module bindings", () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      module: "engine:event-bus",
      stream,
    });

    logger.info({ event: "event.published", count: 2 }, "published");

    expect(stream.logs()).toEqual([
      expect.objectContaining({
        level: "info",
        service: "kaguya-test",
        module: "engine:event-bus",
        event: "event.published",
        count: 2,
        msg: "published",
      }),
    ]);
  });

  it("isolates concurrent async trace contexts and merges nested context", async () => {
    const stream = new MemoryStream();
    const logger = createLogger({ service: "kaguya-test", stream });

    await Promise.all([
      runWithLogContext(
        { traceId: "trace-a", sessionId: "session-a" },
        async () => {
          await Promise.resolve();
          runWithLogContext({ nodeId: "node-a" }, () => {
            logger.info({ event: "node.completed", traceId: "spoofed" });
          });
        },
      ),
      runWithLogContext(
        { traceId: "trace-b", sessionId: "session-b" },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          logger.info({ event: "message.received" });
        },
      ),
    ]);

    const byTrace = Object.fromEntries(
      stream.logs().map((entry) => [entry.traceId, entry]),
    );
    expect(byTrace["trace-a"]).toMatchObject({
      traceId: "trace-a",
      sessionId: "session-a",
      nodeId: "node-a",
    });
    expect(byTrace["trace-b"]).toMatchObject({
      traceId: "trace-b",
      sessionId: "session-b",
    });
    expect(getLogContext()).toBeUndefined();
  });

  it("applies the longest matching namespace log level", () => {
    const stream = new MemoryStream();
    const root = createLogger({
      service: "kaguya-test",
      level: "warn",
      namespaceLevels: {
        engine: "info",
        "engine:workflow": "debug",
      },
      stream,
    });
    const workflow = createModuleLogger(root, "engine:workflow:message");
    const eventBus = createModuleLogger(root, "engine:event-bus");

    workflow.debug({ event: "workflow.debug" });
    eventBus.debug({ event: "event-bus.debug" });
    eventBus.info({ event: "event-bus.info" });

    expect(stream.logs().map((entry) => entry.event)).toEqual([
      "workflow.debug",
      "event-bus.info",
    ]);
  });

  it("redacts secrets and content and safely serializes errors and requests", () => {
    const stream = new MemoryStream();
    const logger = createLogger({ service: "kaguya-test", stream });
    const providerError = Object.assign(new Error("provider-secret-response"), {
      code: "PROVIDER_FAILURE",
      statusCode: 502,
      cause: new Error("api-key-value"),
    });

    logger.error({
      event: "provider.failed",
      apiKey: "api-key-value",
      access_token: "platform-token-value",
      credentials: { password: "credential-value" },
      raw: { targetId: "platform-target-value" },
      delivery: { target: { kind: "private", userId: "direct-target-value" } },
      wsUrl: "ws://localhost:3001?access_token=socket-secret",
      config: { token: "token-value", userPrompt: "private prompt" },
      err: providerError,
      req: {
        id: "request-1",
        method: "POST",
        url: "/api/v1/messages?token=query-secret",
        headers: { authorization: "Bearer gateway-secret" },
      },
    });
    logger.error(new Error("direct-error-secret"));

    const logs = stream.logs();
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("api-key-value");
    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("platform-token-value");
    expect(serialized).not.toContain("credential-value");
    expect(serialized).not.toContain("platform-target-value");
    expect(serialized).not.toContain("direct-target-value");
    expect(serialized).not.toContain("socket-secret");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("provider-secret-response");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("gateway-secret");
    expect(serialized).not.toContain("direct-error-secret");
    expect(logs[0]).toMatchObject({
      err: {
        type: "Error",
        code: "PROVIDER_FAILURE",
        statusCode: 502,
      },
      req: {
        requestId: "request-1",
        method: "POST",
        path: "/api/v1/messages",
      },
    });
  });

  it("parses environment defaults and namespace overrides", () => {
    expect(
      readLoggerOptions("kaguya-api", {
        KAGUYA_LOG_LEVEL: "warn",
        KAGUYA_LOG_LEVELS: "api=info, engine:workflow=debug",
        KAGUYA_LOG_ASYNC: "true",
        KAGUYA_LOG_DESTINATION: "./logs/api.jsonl",
      }),
    ).toEqual({
      service: "kaguya-api",
      level: "warn",
      namespaceLevels: {
        api: "info",
        "engine:workflow": "debug",
      },
      async: true,
      format: "json",
      destination: "./logs/api.jsonl",
    });
    expect(readLoggerOptions("kaguya-api", {})).toEqual({
      service: "kaguya-api",
      level: "info",
      namespaceLevels: {},
      async: false,
      format: "json",
      destination: 1,
    });
    expect(
      readLoggerOptions("kaguya", { NODE_ENV: "development" }),
    ).toMatchObject({ format: "pretty", destination: 1, async: false });
    expect(
      readLoggerOptions("kaguya", {
        NODE_ENV: "development",
        KAGUYA_LOG_FORMAT: "json",
      }),
    ).toMatchObject({ format: "json" });
  });

  it("rejects malformed logger configuration and context", () => {
    expect(() =>
      readLoggerOptions("kaguya-api", { KAGUYA_LOG_LEVEL: "verbose" }),
    ).toThrow("valid Pino log level");
    expect(() =>
      readLoggerOptions("kaguya-api", {
        KAGUYA_LOG_LEVELS: "engine:workflow",
      }),
    ).toThrow("namespace=level");
    expect(() =>
      readLoggerOptions("kaguya", {
        NODE_ENV: "development",
        KAGUYA_LOG_ASYNC: "true",
      }),
    ).toThrow("pretty logging cannot be asynchronous");
    expect(() =>
      readLoggerOptions("kaguya", {
        KAGUYA_LOG_FORMAT: "pretty",
        KAGUYA_LOG_DESTINATION: "./logs/pretty.log",
      }),
    ).toThrow("pretty logging only supports stdout or stderr");
    expect(() =>
      readLoggerOptions("kaguya", { KAGUYA_LOG_FORMAT: "text" }),
    ).toThrow("json or pretty");
    expect(() => runWithLogContext({ traceId: "" }, () => undefined)).toThrow(
      "traceId must be a non-empty string",
    );
    expect(() =>
      runWithLogContext(
        { unknownId: "value" } as unknown as Parameters<
          typeof runWithLogContext
        >[0],
        () => undefined,
      ),
    ).toThrow("unknownId is not a supported log context field");
  });

  it("preserves write order with the asynchronous worker transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaguya-logger-"));
    const destination = join(directory, "events.jsonl");
    try {
      const logger = createLogger({
        service: "kaguya-test",
        async: true,
        destination,
      });
      logger.info({ sequence: 1, event: "first" });
      logger.info({ sequence: 2, event: "second" });
      await closeLogger(logger);

      const records = (await readFile(destination, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class MemoryStream extends Writable {
  readonly #chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.#chunks.push(chunk.toString());
    callback();
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
