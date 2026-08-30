/**
 * 功能概述：本文件验证 `KaguyaRuntime` 在数据库、模块宿主、LLM 执行器与平台传输之间
 * 的整合行为，覆盖消息过滤、持久化、事件驱动回复、关闭时序以及模型选择解析器的契约。
 * 主要职责：已有用例确保平台/Web 消息的标准流水线、错误审计与 shutdown 语义稳定；
 * 本次变更新增回归测试，要求多个回复模块共享同一个运行时解析器，传入的 selection
 * 只能包含 `modelTier`，并且任何持久化消息都不能再出现 `profileId` 覆盖痕迹。
 * 代码库关系：测试直接实例化 `runtime.ts`，并通过 `@kaguya/database` 检查落盘记录；
 * 它依赖 `@kaguya/modules` 默认模块与自定义 activation 的组合来覆盖真实 dispatch 流程，
 * 从而约束服务层 `apps/server` 提供的 resolver 必须符合运行时的最小接口。
 * 输入输出与副作用：每个用例在临时 SQLite 文件中运行完整 Runtime 生命周期，注册内存版
 * transport 或伪造 resolver 来观察调用参数；测试结束会删除临时目录，避免污染工作区。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KaguyaDatabase } from "@kaguya/database";
import {
  createDeferredDeterministicModel,
  createRepeatingDeterministicModel,
} from "@kaguya/llm/testing";
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

  it("keeps only the request receipt on a Web source", async () => {
    const databasePath = path();
    const runtime = new KaguyaRuntime({ databasePath });
    await runtime.start();
    const result = await runtime.dispatch({
      kind: "web",
      requestId: "request-1",
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

  it("shares one tier-only resolver across reply modules", async () => {
    const databasePath = path();
    const selections: unknown[] = [];
    const runtime = new KaguyaRuntime({
      databasePath,
      resolveModelSelection: vi.fn((selection) => {
        selections.push(selection);
        return {
          modelId: `resolved-${selection.modelTier}`,
          model: createRepeatingDeterministicModel({ text: selection.modelTier }),
        };
      }),
      moduleActivations: [
        {
          instanceId: "filter.light",
          definitionId: "demo.filter.always",
          settings: { replyTargetInstanceId: "reply.light" },
        },
        {
          instanceId: "filter.heavy",
          definitionId: "demo.filter.always",
          settings: { replyTargetInstanceId: "reply.heavy" },
        },
        {
          instanceId: "reply.light",
          definitionId: "demo.reply.llm",
          settings: {
            modelTier: "light",
            outbound: { mode: "source", messageKind: "text" },
          },
        },
        {
          instanceId: "reply.heavy",
          definitionId: "demo.reply.llm",
          settings: {
            modelTier: "heavy",
            outbound: { mode: "source", messageKind: "reply" },
          },
        },
      ],
      gatewayAllowlist: new GatewayAllowlist({
        platforms: ["qq"],
        userIds: ["112233"],
        groupIds: ["778899"],
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

    await runtime.dispatch(platformMessage());
    await runtime.close();

    expect(selections).toEqual([
      { modelTier: "light" },
      { modelTier: "heavy" },
    ]);
    const database = KaguyaDatabase.open(databasePath);
    expect(JSON.stringify(database.messages.listRecent(10))).not.toContain(
      "profileId",
    );
    database.close();
  });
});
