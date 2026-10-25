/**
 * 功能概述：用真实 HTTP 路由、Runtime、正式模块组合和 PGlite 信息账本验证 WebUI 私聊闭环。
 * 主要职责：fixture 仅替换模型供应商 HTTP，保留 Light、Heavy、Web transport 与历史读取；
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
import { KaguyaRuntime, GatewayAllowlist } from "@kaguya/runtime";
import type { PlatformOutboundTransport } from "@kaguya/platform-adapters";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createWebChatHistory } from "./web-chat.js";
import { createWebMessageGateway } from "./web-gateway.js";

const gatewayToken = "synthetic-web-chat-test-token";
const adapterId = "web.ui.main";
// 与真实 Light/PGlite fixture 保持一致，条件满足立即继续，不固定休眠。
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

async function fixture(
  options: {
    registerTransport?: boolean;
    respond?: (prompt: string, index: number) => unknown | Promise<unknown>;
    transport?: PlatformOutboundTransport;
    qq?: boolean;
    expressions?: boolean;
    pacingMs?: number;
  } = {},
) {
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
      output = options.respond
        ? await options.respond(prompt, composerPrompts.length)
        : {
            action: "message",
            text: `Web reply ${composerPrompts.length}`,
          };
    } else {
      output = {
        action: "message",
        reason: "respond",
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
      outboundAllowlist: new GatewayAllowlist(["qq:group:*", "qq:private:*"]),
      ...createMessageComposition(
        ({ modelTier }) => ({
          providerId: "web-test",
          modelId: `web-test-${modelTier}`,
          model: provider.chatModel(`web-test-${modelTier}`),
        }),
        {
          moduleConfigs: [
            ...createFirstPartyModuleConfigDefaults("test"),
            ...(options.expressions
              ? createFirstPartyModuleConfigDefaults("production").filter(
                  (config) => config.definitionId === "plugin.qq-expression",
                )
              : []),
          ].map((config) =>
            config.definitionId === "agent.heavy" &&
            options.pacingMs !== undefined
              ? {
                  ...config,
                  settings: {
                    pacing: {
                      minMs: options.pacingMs,
                      maxMs: options.pacingMs,
                    },
                  },
                }
              : config.definitionId === "plugin.qq-expression" &&
                  options.expressions
                ? { ...config, enabled: true }
                : config,
          ),
        },
      ),
    });
    if (options.registerTransport !== false) {
      runtime.registerTransport({
        adapterId: options.qq ? "napcat.speech.test" : adapterId,
        platform: options.qq ? "qq" : "web",
        transport: options.transport ?? createWebOutboundTransport(adapterId),
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
          errors: (
            await database.information.find({
              kinds: ["consumer.failed"],
              limit: 10,
            })
          ).map((a) => a.payload),
          recent: recent.map((atom) => ({
            kind: atom.kind,
            id: atom.informationId,
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
    runtime: () => runtime!,
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
  it("keeps continuation delivery records scoped to the current expression", async () => {
    const f = await fixture({
      respond: (_prompt, index) => ({
        action: "message",
        text: `范围测试第${index}条`,
        continuation: index % 2 ? "再说一条" : null,
      }),
    });
    await f.exchange(randomUUID(), "会话甲", "scope-a", [
      "会话甲",
      "范围测试第1条",
      "范围测试第2条",
    ]);
    await f.exchange(randomUUID(), "会话乙", "scope-b", [
      "会话乙",
      "范围测试第3条",
      "范围测试第4条",
    ]);
    const steps = await f.database.information.find({
      kinds: ["agent.heavy.step.requested"],
      registrationOrder: true,
      order: "asc",
      limit: 10,
    });
    expect(steps).toHaveLength(2);
    const continuation = (
      steps[1]!.payload.prompt as {
        variables: { name: string; content: string }[];
      }
    ).variables.find((v) => v.name === "speech_continuation")!;
    expect(
      JSON.parse(continuation.content).delivered.map(
        (item: { message: { text: string } }) => item.message.text,
      ),
    ).toEqual(["范围测试第3条"]);
  });
  it("keeps input arriving during the final part unread for the next turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      respond: async (_prompt, index) => {
        if (index === 2) await gate;
        return {
          action: "message",
          text: `末段测试第${index}条`,
          continuation: index === 1 ? "补完这一点" : null,
        };
      },
    });
    const conversation = randomUUID();
    await f.send(conversation, "说完这一点", "final-start");
    await vi.waitFor(
      () => expect(f.composerPrompts).toHaveLength(2),
      durableWait,
    );
    await f.send(conversation, "现在问一个新问题", "final-interjection");
    release();
    await vi.waitFor(
      async () =>
        expect(
          await f.database.information.find({
            kinds: ["agent.router.turn.completed"],
            limit: 10,
          }),
        ).toHaveLength(2),
      durableWait,
    );
    expect(f.composerPrompts).toHaveLength(3);
    expect(f.composerPrompts[2]).toContain("现在问一个新问题");
    expect(
      (await f.read(conversation)).messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.text),
    ).toEqual(["末段测试第1条", "末段测试第2条", "末段测试第3条"]);
  });

  it("retains delivered content but fails the turn when continuation generation fails", async () => {
    const f = await fixture({
      respond: (_prompt, index) =>
        index === 1
          ? {
              action: "message",
              text: "已经说出的部分",
              continuation: "尚未完成的部分",
            }
          : "invalid-json",
    });
    const conversation = randomUUID();
    await f.send(conversation, "测试模型失败", "model-failure");
    await vi.waitFor(
      async () =>
        expect(
          await f.database.information.find({
            kinds: ["agent.router.turn.failed"],
            limit: 10,
          }),
        ).toHaveLength(1),
      durableWait,
    );
    expect(
      await f.database.information.find({
        kinds: ["agent.router.turn.completed", "agent.router.turn.silent"],
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      (await f.read(conversation)).messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.text),
    ).toEqual(["已经说出的部分"]);
    expect(
      await f.database.information.find({
        kinds: ["agent.heavy.step.observed"],
        limit: 10,
      }),
    ).toHaveLength(0);
  });
  it.each(["group", "private"] as const)(
    "uses the same continuation and authorization path for QQ %s",
    async (kind) => {
      const sent: string[] = [];
      const f = await fixture({
        qq: true,
        expressions: true,
        transport: {
          sendMessage: async (target, message) => {
            sent.push(message.text);
            return {
              ok: true,
              adapterId: "napcat.speech.test",
              platform: "qq",
              target,
              platformMessageId: `sent-${sent.length}`,
            };
          },
        },
        respond: (_prompt, index) => ({
          action: "message",
          text: `QQ 第${index}段`,
          continuation: index === 1 ? "接着说" : null,
        }),
      });
      await f.runtime().submit({
        adapterId: "napcat.speech.test",
        platform: "qq",
        platformMessageId: "qq-speech-input",
        occurredAt: new Date().toISOString(),
        selfId: "bot",
        sender: { userId: "person" },
        text: "你好，接着说两句",
        mentions: [{ kind: "user", id: "bot" }],
        target:
          kind === "group"
            ? { kind, groupId: "group" }
            : { kind, userId: "person" },
        raw: {},
      });
      await vi.waitFor(
        () => expect(sent).toEqual(["QQ 第1段", "QQ 第2段"]),
        durableWait,
      );
      await vi.waitFor(
        async () =>
          expect(
            await f.database.information.find({
              kinds: ["agent.router.turn.completed"],
              limit: 10,
            }),
          ).toHaveLength(1),
        durableWait,
      );
      for (const fact of [
        "agent.heavy.message.draft",
        "agent.heavy.message.prepared",
        "core.message.assistant.text",
        "core.delivery.requested",
      ]) {
        const rows = await f.database.information.find({
          kinds: [fact],
          registrationOrder: true,
          order: "asc",
          limit: 10,
        });
        expect(
          rows.map(
            (row) => (row.payload.speech as { stepIndex: number }).stepIndex,
          ),
        ).toEqual([0, 1]);
      }
    },
  );

  it("restores a pending typing deadline without generating or sending the first part twice", async () => {
    const f = await fixture({
      pacingMs: 1200,
      respond: (_prompt, index) => ({
        action: "message",
        text: `恢复第${index}段`,
        continuation: index === 1 ? "继续恢复" : null,
      }),
    });
    const conversation = randomUUID();
    await f.send(conversation, "重启测试", "restart-speech");
    await vi.waitFor(
      async () =>
        expect(
          await f.database.information.find({
            kinds: ["core.schedule.one-shot.requested"],
            payloadContains: { input: { purpose: "heavy-speech" } },
            limit: 10,
          }),
        ).toHaveLength(1),
      durableWait,
    );
    expect(
      (await f.read(conversation)).messages.filter(
        (m) => m.role === "assistant",
      ),
    ).toHaveLength(0);
    await f.send(conversation, "等待时也能接收这条插话", "typing-interjection");
    await f.restart();
    await vi.waitFor(
      async () =>
        expect(
          (await f.read(conversation)).messages.map((m) => m.text),
        ).toEqual([
          "重启测试",
          "等待时也能接收这条插话",
          "恢复第1段",
          "恢复第2段",
        ]),
      durableWait,
    );
    expect(f.composerPrompts).toHaveLength(2);
    expect(f.composerPrompts[1]).toContain("等待时也能接收这条插话");
  });

  it.each(["failed", "unknown"])(
    "stops continuation after a %s delivery and does not resend on restart",
    async (mode) => {
      let attempts = 0;
      const f = await fixture({
        transport: {
          sendMessage: async (target) => {
            attempts++;
            if (attempts === 2) {
              if (mode === "unknown") throw new Error("Synthetic receipt lost");
              return {
                ok: false,
                adapterId,
                platform: "web",
                target,
                error: "Synthetic failure",
              };
            }
            return {
              ok: true,
              adapterId,
              platform: "web",
              target,
              platformMessageId: `sent-${attempts}`,
            };
          },
        },
        respond: (_prompt, index) => ({
          action: "message",
          text: `失败测试第${index}段`,
          continuation: "还有内容",
        }),
      });
      const conversation = randomUUID();
      await f.send(conversation, "失败测试", "failure-speech");
      await vi.waitFor(
        async () =>
          expect(
            await f.database.information.find({
              kinds: ["agent.router.turn.failed"],
              limit: 10,
            }),
          ).toHaveLength(1),
        durableWait,
      );
      expect(attempts).toBe(2);
      expect(f.composerPrompts).toHaveLength(2);
      expect(
        (await f.read(conversation)).messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.text),
      ).toEqual(["失败测试第1段"]);
      await f.restart();
      expect(attempts).toBe(2);
      expect(f.composerPrompts).toHaveLength(2);
    },
  );

  it("coalesces a replayed receipt while the next generation is in progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      respond: async (_prompt, index) => {
        if (index === 2) await gate;
        return {
          action: "message",
          text: `重复测试第${index}段`,
          continuation: index === 1 ? "继续" : null,
        };
      },
    });
    const conversation = randomUUID();
    await f.send(conversation, "重复测试", "duplicate-speech");
    await vi.waitFor(
      () => expect(f.composerPrompts).toHaveLength(2),
      durableWait,
    );
    const receipt = (
      await f.database.information.find({
        kinds: ["core.delivery.delivered"],
        limit: 1,
      })
    )[0]!;
    await f.database.sql.query(
      "UPDATE information_deliveries SET state = 'pending', available_at = clock_timestamp() WHERE subscription_id = $1 AND information_id = $2",
      ["heavy.default:kaguya.heavy.delivered", receipt.informationId],
    );
    await vi.waitFor(async () => {
      const row = await f.database.sql.query<{
        state: string;
        attempts: number;
      }>(
        "SELECT state, attempts FROM information_deliveries WHERE subscription_id = $1 AND information_id = $2",
        ["heavy.default:kaguya.heavy.delivered", receipt.informationId],
      );
      expect(row.rows[0]).toMatchObject({ state: "acked", attempts: 2 });
    }, durableWait);
    release();
    await vi.waitFor(
      async () =>
        expect(
          (await f.read(conversation)).messages.filter(
            (m) => m.role === "assistant",
          ),
        ).toHaveLength(2),
      durableWait,
    );
    expect(f.composerPrompts).toHaveLength(2);
    expect(
      await f.database.information.find({
        kinds: ["agent.heavy.step.requested"],
        limit: 10,
      }),
    ).toHaveLength(1);
  });
  it("delivers each part before generating the next and closes only the final part", async () => {
    const calls: string[] = [];
    const f = await fixture({
      respond: async (prompt, index) => {
        calls.push(prompt);
        if (index > 1) {
          const delivered = await f.database.information.find({
            kinds: ["core.delivery.delivered"],
            limit: 10,
          });
          expect(delivered).toHaveLength(index - 1);
          expect(
            await f.database.information.find({
              kinds: ["agent.router.turn.completed"],
              limit: 10,
            }),
          ).toHaveLength(0);
        }
        return {
          action: "message",
          text: `第${index}段`,
          continuation: index < 3 ? "把必要的话接着说完" : null,
        };
      },
    });
    const conversation = randomUUID();
    await f.exchange(conversation, "请解释一下", "speech-start", [
      "请解释一下",
      "第1段",
      "第2段",
      "第3段",
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("第1段");
    const replayed = (
      JSON.parse(calls[2]!) as { role: string; content: string }[]
    )
      .filter((m) => m.role === "assistant")
      .map((m) => JSON.parse(m.content).text);
    expect(replayed).toEqual(["第1段", "第2段"]);
    const turns = await f.database.information.find({
      kinds: ["agent.router.turn.completed"],
      limit: 10,
    });
    expect(turns).toHaveLength(1);
    const steps = await f.database.information.find({
      kinds: ["agent.heavy.step.requested"],
      registrationOrder: true,
      order: "asc",
      limit: 10,
    });
    expect(steps.map((a) => a.payload.stepIndex)).toEqual([1, 2]);
    await f.restart();
    expect((await f.read(conversation)).messages.map((m) => m.text)).toEqual([
      "请解释一下",
      "第1段",
      "第2段",
      "第3段",
    ]);
    expect(calls).toHaveLength(3);
  });

  it.each(["普通插话", "更正", "停止"])(
    "applies %s at the next part and advances its observed watermark",
    async (mode) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await fixture({
        respond: async (prompt, index) => {
          if (index === 1) {
            await gate;
            return {
              action: "message",
              text: "先说这一段",
              continuation: "还有后半段没说完",
            };
          }
          expect(index).toBe(2);
          expect(prompt).toContain(`${mode}的新消息`);
          expect(prompt).toContain("还有后半段没说完");
          return mode === "停止"
            ? { action: "silent" }
            : {
                action: "message",
                text: mode === "更正" ? "按更正接着说" : "继续把话说完",
                continuation: null,
              };
        },
      });
      const conversation = randomUUID();
      await f.send(conversation, "说说这个", "speech-start");
      await vi.waitFor(
        () => expect(f.composerPrompts).toHaveLength(1),
        durableWait,
      );
      await f.send(conversation, `${mode}的新消息`, "speech-interjection");
      await vi.waitFor(
        async () =>
          expect((await f.read(conversation)).messages).toHaveLength(2),
        durableWait,
      );
      release();
      await vi.waitFor(async () => {
        expect(
          await f.database.information.find({
            kinds: ["agent.router.turn.completed"],
            limit: 10,
          }),
        ).toHaveLength(1);
        const history = await f.read(conversation);
        expect(
          history.messages
            .filter((m) => m.role === "assistant")
            .map((m) => m.text),
        ).toEqual(
          mode === "停止"
            ? ["先说这一段"]
            : ["先说这一段", mode === "更正" ? "按更正接着说" : "继续把话说完"],
        );
        expect(
          await f.database.information.find({
            kinds: ["agent.heavy.step.observed"],
            limit: 10,
          }),
        ).toHaveLength(1);
      }, durableWait);
      expect(
        await f.database.information.find({
          kinds: ["agent.router.turn.silent"],
          limit: 10,
        }),
      ).toHaveLength(0);
    },
  );
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
    expect(f.composerPrompts[2]).toContain("绿色森林");
    const composedText = (
      JSON.parse(f.composerPrompts[2]!) as { content: string }[]
    )
      .map((message) => message.content)
      .join("\n");
    const currentScope = composedText
      .split("【当前 scope 上下文：近期、历史保底与未读消息】\n")[1]
      ?.split("\n\n")[0];
    expect(currentScope).not.toContain("绿色森林");
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
