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

  it("keeps the HTTP sessionId only as an opaque Web source", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({ databasePath });
    await runtime.start();
    const result = await runtime.dispatch({
      kind: "web",
      requestId: "request-1",
      sessionId: "caller-controlled-source",
      text: "hello from web",
    });
    await runtime.close();

    expect(result.deliveries).toEqual([]);
    const database = KaguyaDatabase.open(databasePath);
    expect(database.messages.listRecent(10)[0]?.metadata).toMatchObject({
      moduleMessage: {
        source: {
          kind: "web",
          requestId: "request-1",
          sourceId: "caller-controlled-source",
        },
      },
    });
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
