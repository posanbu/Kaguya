/**
 * 功能概述：用真实 HTTP 路由、Runtime、正式模块组合和 PGlite 信息账本验证 WebUI 私聊闭环。
 * 主要职责：fixture 仅替换模型供应商 HTTP，保留 Planner、Composer、Web transport 与历史读取；
 * exchange 在同一个显式持久化等待预算内确认回复可读和订阅队列闭合，避免把 202 当成回复完成。
 * 代码库关系：通过 app.ts 与 web-gateway.ts 接收入站，web-chat.ts 从成功投递事实恢复历史；
 * platform-adapters 提供真实 Web 出站，composition 提供与服务端相同的业务 DAG。
 * 输入输出与副作用：所有会话、正文和凭据均为合成数据，模型不会访问外部网络；每个用例独占
 * 内存 PGlite，失败路径也按 HTTP、Runtime、数据库顺序关闭。覆盖会话隔离、后续上下文、
 * 游标增量读取、Runtime/reader 重建恢复，以及已生成但未送达的助手消息不得显示。
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import { closeLogger, createLogger } from "@kaguya/logger";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { createWebOutboundTransport } from "@kaguya/platform-adapters";
import { KaguyaRuntime } from "@kaguya/runtime";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createWebChatHistory } from "./web-chat.js";
import { createWebMessageGateway } from "./web-gateway.js";

const gatewayToken = "synthetic-web-chat-test-token";
const adapterId = "web.ui.main";
// 与真实 Planner/PGlite fixture 保持一致，条件满足立即继续，不固定休眠。
const durableWait = { timeout: 8_000, interval: 20 };
// HTTP 历史独立限流为每分钟 120 次；三轮最长等待总计不超过 96 次轮询。
const historyWait = { timeout: durableWait.timeout, interval: 250 };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
}, 15_000);

type ChatHistory = Awaited<
  ReturnType<ReturnType<typeof createWebChatHistory>["read"]>
>;

function testConfig(): ServerConfig {
  const root = join(tmpdir(), `kaguya-web-chat-${randomUUID()}`);
  return {
    host: "127.0.0.1",
    port: 3000,
    gatewayToken,
    corsOrigins: [],
    trustProxy: false,
    rateLimitMax: 10_000,
    rateLimitWindowMs: 60_000,
    databaseUrl: "postgresql://kaguya@database.invalid:5432/kaguya",
    configRoot: join(root, "config"),
    development: false,
    webDistPath: join(root, "web"),
    logLevel: "silent",
    logFormat: "json",
    inboundAllowlist: [],
    outboundAllowlist: [],
    napcat: {
      enabled: false,
      adapterId: "napcat.qq.main",
      reconnectMs: 3000,
    },
  };
}

async function fixture(options: { registerTransport?: boolean } = {}) {
  const database = await createTestingDatabase();
  const logger = createLogger({
    service: "web-chat-integration-test",
    level: "silent",
  });
  let runtime: KaguyaRuntime | undefined;
  let app: FastifyInstance | undefined;
  cleanups.push(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await runtime?.close();
      } finally {
        try {
          await database.close();
        } finally {
          await closeLogger(logger);
        }
      }
    }
  });

  const composerPrompts: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      model: string;
      messages: unknown[];
    };
    const prompt = JSON.stringify(request.messages);
    let output: unknown;
    if (prompt.includes("归纳这批真人消息")) {
      output = { patterns: [] };
    } else if (prompt.includes("依据冻结回合和已获胜的消息意图")) {
      output = { habitIds: [] };
    } else if (request.model === "web-test-heavy") {
      composerPrompts.push(prompt);
      output = `Web reply ${composerPrompts.length}`;
    } else {
      output = {
        action: "message",
        reason: "respond",
        composition: {
          focusInputIndexes: [0],
          topic: "当前消息",
          replyAct: "回应用户",
        },
      };
    }
    return new Response(
      JSON.stringify({
        id: "synthetic-web-completion",
        model: request.model,
        object: "chat.completion",
        created: 1,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                typeof output === "string" ? output : JSON.stringify(output),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const provider = createOpenAICompatible({
    name: "web-test",
    baseURL: "https://web-chat-provider.invalid/v1",
    apiKey: "synthetic-model-key",
    fetch,
  });
  const startRuntime = async () => {
    runtime = new KaguyaRuntime({
      database,
      ...createMessageComposition(
        ({ modelTier }) => ({
          providerId: "web-test",
          modelId: `web-test-${modelTier}`,
          model: provider.chatModel(`web-test-${modelTier}`),
        }),
        { moduleConfigs: createFirstPartyModuleConfigDefaults("test") },
      ),
    });
    if (options.registerTransport !== false) {
      runtime.registerTransport({
        adapterId,
        platform: "web",
        transport: createWebOutboundTransport(adapterId),
      });
    }
    await runtime.start();
  };
  await startRuntime();
  let reader = createWebChatHistory(database.information);
  const webGateway = createWebMessageGateway({
    adapterId,
    ingress: {
      submit: (message) => runtime!.submit(message),
    },
    logger,
  });
  app = await createHttpApplication({
    config: testConfig(),
    webGateway,
    webChatHistory: () => reader,
  });

  const read = async (
    conversationId: string,
    cursor: ChatHistory["cursor"] = {},
  ): Promise<ChatHistory> => {
    const query = new URLSearchParams({ conversationId });
    if (cursor.inbound) query.set("afterInbound", cursor.inbound);
    if (cursor.outbound) query.set("afterOutbound", cursor.outbound);
    const response = await app!.inject({
      method: "GET",
      url: `/api/v1/messages?${query}`,
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ data: ChatHistory }>().data;
  };
  const send = async (
    conversationId: string,
    text: string,
    requestId: string,
  ) => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "x-request-id": requestId,
      },
      payload: { text, conversationId },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: { status: "accepted", requestId },
    });
  };
  const exchange = async (
    conversationId: string,
    text: string,
    requestId: string,
    expectedTexts: readonly string[],
  ) => {
    await send(conversationId, text, requestId);
    try {
      return await vi.waitFor(async () => {
        const history = await read(conversationId);
        expect(history.messages.map((message) => message.text)).toEqual(
          expectedTexts,
        );
        expect((await database.information.reliable.health()).pending).toBe(0);
        return history;
      }, historyWait);
    } catch (cause) {
      const recent = await database.information.find({
        occurredAfter: "2020-01-01T00:00:00.000Z",
        order: "desc",
        registrationOrder: true,
        limit: 18,
      });
      throw new Error(
        `Web exchange did not complete: ${JSON.stringify({
          health: await database.information.reliable.health(),
          composerCalls: composerPrompts.length,
          recent: recent.map((atom) => ({
            kind: atom.kind,
            payload: atom.payload,
          })),
        })}`,
        { cause },
      );
    }
  };

  return {
    app,
    database,
    composerPrompts,
    read,
    send,
    exchange,
    restart: async () => {
      await runtime!.close();
      await startRuntime();
      reader = createWebChatHistory(database.information);
    },
  };
}

describe("Web private chat through the production information DAG", () => {
  it("returns replies over HTTP, isolates conversations and restores durable history after restart", async () => {
    const f = await fixture();
    const conversationA = randomUUID();
    const conversationB = randomUUID();
    const first = await f.exchange(
      conversationA,
      "会话甲的暗号是蓝色月亮",
      "web-a-first",
      ["会话甲的暗号是蓝色月亮", "Web reply 1"],
    );
    expect(first).toMatchObject({
      conversationId: conversationA,
      messages: [
        { role: "user", requestId: "web-a-first" },
        { role: "assistant" },
      ],
      hasMore: false,
    });
    expect(first.cursor.inbound).toBeTruthy();
    expect(first.cursor.outbound).toBeTruthy();
    expect((await f.read(conversationB)).messages).toEqual([]);

    const other = await f.exchange(
      conversationB,
      "会话乙的暗号是绿色森林",
      "web-b-first",
      ["会话乙的暗号是绿色森林", "Web reply 2"],
    );
    const continued = await f.exchange(
      conversationA,
      "请记住我们上一轮的暗号",
      "web-a-second",
      [
        "会话甲的暗号是蓝色月亮",
        "Web reply 1",
        "请记住我们上一轮的暗号",
        "Web reply 3",
      ],
    );
    expect(f.composerPrompts).toHaveLength(3);
    expect(f.composerPrompts[2]).toContain("蓝色月亮");
    expect(f.composerPrompts[2]).toContain("Web reply 1");
    expect(f.composerPrompts[2]).not.toContain("绿色森林");
    expect((await f.read(conversationB)).messages).toEqual(other.messages);

    const incremental = await f.read(conversationA, first.cursor);
    expect(incremental.messages).toEqual(continued.messages.slice(2));
    expect(incremental.cursor).toEqual(continued.cursor);
    expect((await f.read(conversationA, continued.cursor)).messages).toEqual(
      [],
    );
    expect(new Set(continued.messages.map((message) => message.id)).size).toBe(
      4,
    );
    for (const message of continued.messages) {
      expect(Number.isFinite(Date.parse(message.createdAt))).toBe(true);
    }

    await f.restart();
    await vi.waitFor(async () => {
      expect((await f.database.information.reliable.health()).pending).toBe(0);
    }, durableWait);
    expect(await f.read(conversationA)).toEqual(continued);
    expect(await f.read(conversationB)).toEqual(other);
    expect(f.composerPrompts).toHaveLength(3);
  }, 50_000); // 三轮持久化及一次重启收敛各有 8 秒预算，余量用于 PGlite/HTTP 初始化。

  it("does not expose generated assistant text when delivery failed", async () => {
    const f = await fixture({ registerTransport: false });
    const conversationId = randomUUID();
    await f.send(
      conversationId,
      "这条消息没有可用的出站通道",
      "web-undelivered",
    );
    await vi.waitFor(async () => {
      const atoms = await f.database.information.find({
        occurredAfter: "2020-01-01T00:00:00.000Z",
        order: "asc",
        limit: 1000,
      });
      expect(
        atoms.filter((atom) => atom.kind === "core.message.assistant.text"),
      ).toHaveLength(1);
      expect(
        atoms.filter((atom) => atom.kind === "core.delivery.failed"),
      ).toHaveLength(1);
      expect(
        atoms.filter((atom) => atom.kind === "core.delivery.delivered"),
      ).toHaveLength(0);
      expect((await f.database.information.reliable.health()).pending).toBe(0);
    }, durableWait);
    expect((await f.read(conversationId)).messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "这条消息没有可用的出站通道",
        requestId: "web-undelivered",
      }),
    ]);
  });
});
