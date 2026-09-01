import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import { createDeferredDeterministicModel } from "@kaguya/llm/testing";
import type { PlatformOutboundTransport } from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KaguyaRuntime,
  OutboundTransportError,
  OutboundTransportNotFoundError,
  RuntimeUnavailableError,
} from "./runtime.js";
import { GatewayAllowlist } from "./gateway-allowlist.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "kaguya-runtime-"));
  directories.push(directory);
  return join(directory, "kaguya.sqlite");
}

function platformMessage(adapterId = "napcat.qq.main") {
  return {
    kind: "platform" as const,
    message: {
      platform: "qq" as const,
      adapterId,
      selfId: "998877",
      traceId: "napcat:998877:message-1",
      platformMessageId: "message-1",
      occurredAt: "2026-08-14T00:00:00.000Z",
      text: "hello without a mention",
      mentions: [],
      target: { kind: "group" as const, groupId: "778899" },
      sender: { userId: "112233", nickname: "Ada" },
      raw: { mustNotBePersisted: "secret-raw" },
    },
  };
}

function webMessage(requestId = "request-1") {
  return {
    kind: "platform" as const,
    message: {
      platform: "web" as const,
      adapterId: "web.ui.main",
      traceId: `web:${requestId}`,
      platformMessageId: requestId,
      occurredAt: "2026-08-14T00:00:00.000Z",
      text: "hello from web",
      mentions: [],
      target: { kind: "web" as const },
      sender: { userId: "web" },
      raw: {},
    },
  };
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((nested) => errorMessages(nested));
  }
  return error instanceof Error ? [error.message] : [];
}

describe("KaguyaRuntime", () => {
  it("filters a platform message before persistence and reply generation", async () => {
    const databasePath = path();
    const resolveModelSelection = vi.fn(() => {
      throw new Error("Filtered messages must not resolve an LLM");
    });
    const sendMessage = vi.fn<PlatformOutboundTransport["sendMessage"]>(
      async (target) => ({
        ok: true,
        adapterId: "napcat.qq.main",
        platform: "qq",
        target,
      }),
    );
    const runtime = new KaguyaRuntime({
      databasePath,
      resolveModelSelection,
      gatewayAllowlist: new GatewayAllowlist({ groupIds: ["allowed-group"] }),
    });
    runtime.registerTransport({
      adapterId: "napcat.qq.main",
      platform: "qq",
      transport: { sendMessage },
    });
    await runtime.start();

    const result = await runtime.dispatch(platformMessage());
    await runtime.close();

    expect(result).toMatchObject({
      filtered: true,
      interrupted: true,
      completedNodeIds: [],
      deliveries: [],
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveModelSelection).not.toHaveBeenCalled();

    const database = KaguyaDatabase.open(databasePath);
    expect(database.messages.listRecent(10)).toEqual([]);
    database.close();
  });

  it("persists, runs modules, and transports a platform reply", async () => {
    const databasePath = path();
    const sendMessage = vi.fn<PlatformOutboundTransport["sendMessage"]>(
      async (target) => ({
        ok: true,
        adapterId: "napcat.qq.main",
        platform: "qq",
        target,
        platformMessageId: "sent-1",
        raw: { mustNotBePersisted: true },
      }),
    );
    const runtime = new KaguyaRuntime({
      databasePath,
      gatewayAllowlist: new GatewayAllowlist({
        platforms: ["qq"],
        userIds: ["112233"],
        groupIds: ["778899"],
      }),
    });
    runtime.registerTransport({
      adapterId: "napcat.qq.main",
      platform: "qq",
      transport: { sendMessage },
    });
    await runtime.start();

    const result = await runtime.dispatch(platformMessage());
    await runtime.close();

    expect(sendMessage).toHaveBeenCalledWith(
      { kind: "group", groupId: "778899" },
      expect.objectContaining({
        kind: "reply",
        replyToPlatformMessageId: "message-1",
      }),
      expect.objectContaining({ traceId: "napcat:998877:message-1" }),
    );
    expect(result.deliveries).toEqual([
      expect.objectContaining({ ok: true, platformMessageId: "sent-1" }),
    ]);
    expect(result.filtered).toBe(false);

    const database = KaguyaDatabase.open(databasePath);
    const messages = database.messages.listRecent(10);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("sessionId");
    expect(JSON.stringify(messages)).not.toContain("secret-raw");
    expect(
      database.outboundMessages.listByTrace("napcat:998877:message-1"),
    ).toEqual([
      expect.objectContaining({
        status: "delivered",
        destination: { kind: "group", groupId: "778899" },
        metadata: expect.objectContaining({
          causationEventId: expect.any(String),
          rootEventId: expect.any(String),
        }),
      }),
    ]);
    expect(
      JSON.stringify(
        database.outboundMessages.listByTrace("napcat:998877:message-1"),
      ),
    ).not.toContain("mustNotBePersisted");
    database.close();
  });

  it("persists a web platform message and completes the pipeline without outbound", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({ databasePath });
    await runtime.start();
    const result = await runtime.dispatch(webMessage());
    await runtime.close();

    expect(result.filtered).toBe(false);
    expect(result.interrupted).toBe(false);
    expect(result.deliveries).toEqual([]);

    const database = KaguyaDatabase.open(databasePath);
    const [message] = database.messages.listRecent(10);
    expect(message?.role).toBe("user");
    expect(message?.metadata).toMatchObject({
      traceId: "web:request-1",
      moduleMessage: {
        text: "hello from web",
        source: {
          kind: "platform",
          platform: "web",
          adapterId: "web.ui.main",
          platformMessageId: "request-1",
          destination: { kind: "web" },
          sender: { id: "web" },
          mentions: [],
        },
      },
    });
    expect(database.outboundMessages.listByTrace("web:request-1")).toEqual([]);
    expect(database.llmTraces.listByTrace("web:request-1")).toHaveLength(1);
    database.close();
  });

  it("filters a web platform message by the gateway allowlist", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({
      databasePath,
      gatewayAllowlist: new GatewayAllowlist({ platforms: ["qq"] }),
    });
    await runtime.start();

    const result = await runtime.dispatch(webMessage());
    await runtime.close();

    expect(result).toMatchObject({
      filtered: true,
      interrupted: true,
      completedNodeIds: [],
      deliveries: [],
    });

    const database = KaguyaDatabase.open(databasePath);
    expect(database.messages.listRecent(10)).toEqual([]);
    database.close();
  });

  it("keeps the persisted message when a web dispatch fails after ingest", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({
      databasePath,
      resolveModelSelection: () => {
        throw new Error("model resolver exploded");
      },
    });
    await runtime.start();

    const failure = await runtime
      .dispatch(webMessage())
      .catch((error: unknown) => error);
    await runtime.close();

    expect(failure).toBeInstanceOf(AggregateError);
    expect(errorMessages(failure)).toContain("model resolver exploded");

    const database = KaguyaDatabase.open(databasePath);
    expect(
      database.messages.listRecent(10).map((record) => record.role),
    ).toEqual(["user"]);
    database.close();
  });

  it("waits for an in-flight web dispatch before close", async () => {
    const databasePath = path();
    const deferred = createDeferredDeterministicModel({ text: "done" });
    const runtime = new KaguyaRuntime({
      databasePath,
      resolveModelSelection: ({ modelTier }) => ({
        modelId: `deferred-${modelTier}`,
        model: deferred.model,
      }),
    });
    await runtime.start();
    const dispatch = runtime.dispatch(webMessage());
    await deferred.started;
    const close = runtime.close();
    deferred.release();
    await close;
    await dispatch;

    const database = KaguyaDatabase.open(databasePath);
    expect(
      database.messages.listRecent(10).map((record) => record.role),
    ).toEqual(["user"]);
    expect(database.llmTraces.listByTrace("web:request-1")).toHaveLength(1);
    database.close();
  });

  it("rejects dispatch while the runtime is unavailable", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({ databasePath });
    await expect(runtime.dispatch(webMessage())).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );

    await runtime.start();
    await runtime.dispatch(webMessage());
    await runtime.close();
    await expect(runtime.dispatch(webMessage("request-2"))).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );

    const database = KaguyaDatabase.open(databasePath);
    expect(
      database.messages.listRecent(10).map((record) => record.role),
    ).toEqual(["user"]);
    database.close();
  });

  it("audits an unknown transport and reports a clear failure", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({ databasePath });
    await runtime.start();
    await expect(
      runtime.dispatch(platformMessage("missing")),
    ).rejects.toBeInstanceOf(AggregateError);
    await runtime.close();

    const database = KaguyaDatabase.open(databasePath);
    const records = database.outboundMessages.listByTrace(
      "napcat:998877:message-1",
    );
    expect(records).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("not registered"),
      }),
    ]);
    database.close();
    expect(new OutboundTransportNotFoundError("a", "qq").message).toContain(
      "not registered",
    );
  });

  it("audits a thrown transport failure without persisting its details", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({ databasePath });
    runtime.registerTransport({
      adapterId: "napcat.qq.main",
      platform: "qq",
      transport: {
        sendMessage: () =>
          Promise.reject(new Error("provider-token-must-not-be-persisted")),
      },
    });
    await runtime.start();

    await expect(runtime.dispatch(platformMessage())).rejects.toBeInstanceOf(
      AggregateError,
    );
    await runtime.close();

    const database = KaguyaDatabase.open(databasePath);
    const records = database.outboundMessages.listByTrace(
      "napcat:998877:message-1",
    );
    expect(records).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Platform transport failed",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(
      "provider-token-must-not-be-persisted",
    );
    database.close();
    expect(
      new OutboundTransportError("adapter", "qq", new Error()).message,
    ).toContain("Outbound transport failed");
  });

  it("waits for an in-flight module LLM call before close", async () => {
    const deferred = createDeferredDeterministicModel({ text: "done" });
    const runtime = new KaguyaRuntime({
      databasePath: path(),
      resolveModelSelection: ({ modelTier }) => ({
        modelId: `deferred-${modelTier}`,
        model: deferred.model,
      }),
    });
    runtime.registerTransport({
      adapterId: "napcat.qq.main",
      platform: "qq",
      transport: {
        sendMessage: async (target) => ({
          ok: true,
          adapterId: "napcat.qq.main",
          platform: "qq",
          target,
        }),
      },
    });
    await runtime.start();
    const dispatch = runtime.dispatch(platformMessage());
    await deferred.started;
    const close = runtime.close();
    await expect(runtime.dispatch(platformMessage())).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
    deferred.release();
    await dispatch;
    await close;
  });
});
