/**
 * 功能概述：通过真实 Runtime/PGlite 与 DeepSeek-compatible HTTP mock 验证两层发言决策。
 * fixture 装配正式 Catalog、light Planner 和 heavy Composer；settle 等待 durable 订阅闭合，
 * restart 保留数据库并重建宿主，advance 推进持久 heartbeat 时钟。仅 mock provider HTTP，
 * 覆盖动作分支、严格对象输出、失败关闭、直接信号、共享等待预算和并发入站去重。
 * 所有消息和密钥均为合成测试数据；清理按 Runtime、数据库顺序关闭，不访问外部服务。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import {
  KaguyaRuntime,
  ModelTaskClient,
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const speak = { action: "speak", reasonCode: "direct-response" };
const silent = { action: "silent", reasonCode: "no-value" };
const wait = { action: "wait", reasonCode: "awaiting-context", waitSeconds: 5 };

async function fixture(outputs: unknown[]) {
  const database = await createTestingDatabase();
  let now = Date.parse("2026-09-12T12:00:00.000Z");
  const requests: Record<string, any>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const pending =
      request.model === "deepseek-light"
        ? (outputs.shift() ?? silent)
        : "reply-body";
    const output = typeof pending === "function" ? await pending() : pending;
    if (output === "HTTP_FAILURE")
      return new Response("synthetic-provider-error", { status: 400 });
    return new Response(
      JSON.stringify({
        id: "mock-completion",
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
    name: "deepseek",
    baseURL: "https://deepseek.invalid/v1",
    apiKey: "synthetic",
    fetch,
  });
  const composition = createMessageComposition(
    ({ modelTier }) => ({
      providerId: "deepseek",
      modelId: `deepseek-${modelTier}`,
      model: provider.chatModel(`deepseek-${modelTier}`),
    }),
    { moduleConfigs: createFirstPartyModuleConfigDefaults("test") },
  );
  const delivered = vi.fn(async (target: PlatformInboundMessage["target"]) => ({
    ok: true as const,
    adapterId: "test",
    platform: "qq" as const,
    target,
    raw: {},
    platformMessageId: `out-${requests.length}`,
  }));
  let cancelTask: (id: string) => Promise<unknown>;
  let core: RuntimeCapabilityContext["core"];
  const start = async () => {
    const runtime = new KaguyaRuntime({
      ...composition,
      database,
      now: () => new Date(now),
      capabilities: (context) => {
        core = context.core;
        const client = new ModelTaskClient({
          ...composition.modelTask,
          ...context,
        });
        cancelTask = (id) =>
          client.cancel({
            requestedInformationId: id,
            reason: "explicit test cancellation",
          });
        return composition.capabilities(context);
      },
    });
    runtime.registerTransport({
      adapterId: "test",
      platform: "qq",
      transport: { sendMessage: delivered },
    });
    await runtime.start();
    return runtime;
  };
  let runtime = await start();
  cleanups.push(async () => {
    await runtime.close();
    await database.close();
  });
  const atoms = () =>
    database.information.find({
      occurredAfter: "2020-01-01T00:00:00.000Z",
      order: "asc",
      limit: 1000,
    });
  const settle = async () => {
    await vi.waitFor(
      async () =>
        expect((await database.information.reliable.health()).pending).toBe(0),
      { timeout: 8000, interval: 20 },
    );
  };
  const message = (
    id = "m1",
    extra: Partial<PlatformInboundMessage> = {},
  ): PlatformInboundMessage => ({
    adapterId: "test",
    platform: "qq",
    platformMessageId: id,
    occurredAt: new Date(now).toISOString(),
    text: "测试消息",
    selfId: "bot",
    mentions: [],
    target: { kind: "private", userId: "user" },
    sender: { userId: "user" },
    raw: {},
    ...extra,
  });
  return {
    database,
    requests,
    delivered,
    atoms,
    settle,
    message,
    cancel: (id: string) => cancelTask(id),
    core: () => core,
    submit: (m: PlatformInboundMessage) => runtime.submit(m),
    restart: async () => {
      await runtime.close();
      runtime = await start();
    },
    setTime: (ms: number) => {
      now += ms;
    },
  };
}

function kinds(
  atoms: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["atoms"]>>,
) {
  return atoms.map((a) => a.kind);
}

describe("speech Planner via DeepSeek-compatible provider", () => {
  it.each([speak, silent, wait])("closes the $action DAG", async (output) => {
    const f = await fixture([output]);
    await f.submit(f.message());
    await f.settle();
    const graph = await f.atoms();
    const decision = graph.find((a) => a.kind === "agent.speech.decision")!;
    expect(decision.payload.outcome).toBe(output.action);
    expect(f.requests.filter((r) => r.model === "deepseek-light")).toHaveLength(
      1,
    );
    expect(f.requests[0]?.response_format).toMatchObject({
      type: "json_object",
    });
    expect(JSON.stringify(f.requests[0]?.messages)).toContain(
      "只输出一个 JSON 对象",
    );
    expect(JSON.stringify(f.requests[0]?.messages)).toContain("waitSeconds");
    expect(kinds(graph)).toContain(
      output.action === "speak"
        ? "agent.turn.completed"
        : output.action === "wait"
          ? "agent.turn.waiting"
          : "agent.turn.silent",
    );
    expect(kinds(graph)).not.toContain("agent.turn.failed");
    expect(f.requests.filter((r) => r.model === "deepseek-heavy")).toHaveLength(
      output.action === "speak" ? 1 : 0,
    );
    expect(f.delivered).toHaveBeenCalledTimes(
      output.action === "speak" ? 1 : 0,
    );
    if (output.action !== "speak")
      expect(kinds(graph)).not.toContain("core.message.assistant.text");
  });

  it.each([
    "HTTP_FAILURE",
    "not JSON",
    { action: "speak", reasonCode: "invented" },
    { ...wait, waitSeconds: 4 },
    { ...wait, waitSeconds: 121 },
    { ...wait, waitSeconds: 5.5 },
    { ...silent, text: "forbidden reply" },
  ])("fails closed for %j", async (output) => {
    const f = await fixture([output]);
    await f.submit(f.message());
    await f.settle();
    const graph = await f.atoms();
    expect(
      graph.find((a) => a.kind === "agent.speech.decision")?.payload,
    ).toMatchObject({
      outcome: "silent",
      reasonCodes: ["planner-unavailable"],
    });
    expect(kinds(graph)).toContain("agent.turn.silent");
    expect(kinds(graph)).not.toContain("agent.turn.failed");
    expect(kinds(graph)).not.toContain("core.message.assistant.text");
    expect(f.requests).toHaveLength(1);
    expect(f.delivered).not.toHaveBeenCalled();
  });

  it.each([
    {},
    {
      target: { kind: "group", groupId: "group" },
      mentions: [{ kind: "user", id: "bot" }],
    },
    {
      target: { kind: "group", groupId: "group" },
      replyTo: { platformMessageId: "old", senderId: "bot" },
    },
  ] as Partial<PlatformInboundMessage>[])(
    "direct input enters Planner but can remain silent: %j",
    async (extra) => {
      const f = await fixture([silent]);
      await f.submit(f.message("m1", extra));
      await f.settle();
      expect(f.requests).toHaveLength(1);
      expect(f.delivered).not.toHaveBeenCalled();
      expect(kinds(await f.atoms())).toContain("agent.turn.silent");
    },
  );

  it("ordinary group reactions and mentions of others do not invoke Planner", async () => {
    const f = await fixture([speak]);
    await f.submit(
      f.message("m1", {
        text: "哈哈",
        target: { kind: "group", groupId: "group" },
        mentions: [{ kind: "user", id: "other" }],
      }),
    );
    await f.settle();
    expect(f.requests).toHaveLength(0);
    expect(kinds(await f.atoms())).toContain("agent.turn.waiting");
  });

  it("recovers wait across restart, merges a new message, and replies once", async () => {
    const f = await fixture([wait, speak]);
    await f.submit(f.message());
    await f.settle();
    await f.restart();
    f.setTime(1000);
    const next = f.message("m2", { text: "补充完整上下文" });
    await f.submit(next);
    await f.settle();
    expect(f.requests.map((r) => r.model)).toEqual([
      "deepseek-light",
      "deepseek-light",
      "deepseek-heavy",
    ]);
    const graph = await f.atoms();
    const turns = graph.filter(
      (a) => a.kind === "agent.turn.context.completed",
    );
    expect(turns.at(-1)?.payload.inputs).toHaveLength(2);
    expect(turns.at(-1)?.payload.attempt).toBe(1);
    expect(f.delivered).toHaveBeenCalledTimes(1);
    await f.restart();
    await f.settle();
    expect(f.delivered).toHaveBeenCalledTimes(1);
  });

  it("fences a superseded Planner whose model completes after a newer candidate", async () => {
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture([() => blocked, speak]);
    try {
      await f.submit(f.message());
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.setTime(1000);
      await f.submit(f.message("m2", { text: "更新的消息" }));
      await vi.waitFor(async () =>
        expect(kinds(await f.atoms())).toContain("agent.turn.superseded"),
      );
      release(speak);
      await f.settle();
      const graph = await f.atoms();
      expect(
        graph.filter((a) => a.kind === "agent.speech.decision"),
      ).toHaveLength(1);
      expect(
        graph.filter((a) => a.kind === "core.message.assistant.text"),
      ).toHaveLength(1);
      expect(f.delivered).toHaveBeenCalledTimes(1);
      await f.restart();
      await f.settle();
      expect(f.delivered).toHaveBeenCalledTimes(1);
    } finally {
      release(speak);
    }
  });

  it("cancels an in-flight Planner and ignores its late speak output", async () => {
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture([() => blocked]);
    try {
      await f.submit(f.message());
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      const requested = (await f.atoms()).find(
        (a) => a.kind === "core.model.task.requested",
      )!;
      await f.cancel(requested.informationId);
      release(speak);
      await f.settle();
      const graph = await f.atoms();
      expect(kinds(graph)).toContain("core.model.task.cancelled");
      expect(kinds(graph)).toContain("agent.turn.silent");
      expect(kinds(graph)).not.toContain("agent.turn.failed");
      expect(kinds(graph)).not.toContain("core.message.assistant.text");
      expect(
        graph.find((a) => a.kind === "agent.speech.decision")?.payload
          .reasonCodes,
      ).toEqual(["planner-unavailable"]);
      expect(f.requests).toHaveLength(1);
    } finally {
      release(speak);
    }
  });

  it.each([true, false])(
    "includes only successfully delivered same-scope assistant history: delivered=%s",
    async (ok) => {
      const f = await fixture([speak, silent]);
      if (!ok)
        f.delivered.mockRejectedValueOnce(
          new Error("synthetic transport failure"),
        );
      await f.submit(f.message());
      await f.settle();
      f.setTime(1000);
      await f.submit(f.message("m2"));
      await f.settle();
      const prompt = JSON.stringify(f.requests.at(-1)?.messages);
      expect(prompt.includes("reply-body")).toBe(ok);
    },
  );

  it("shares the budget between the deterministic gate and Planner", async () => {
    const f = await fixture([wait, wait, wait]);
    const group = { kind: "group" as const, groupId: "group" };
    await f.submit(f.message("m1", { target: group, text: "哈哈" }));
    await f.settle();
    expect(f.requests).toHaveLength(0);
    f.setTime(1000);
    await f.submit(
      f.message("m2", {
        target: group,
        mentions: [{ kind: "user", id: "bot" }],
      }),
    );
    await f.settle();
    for (let round = 0; round < 2; round++) {
      f.setTime(6000);
      await f.restart();
      await vi.waitFor(() => expect(f.requests).toHaveLength(round + 2));
      await f.settle();
    }
    const graph = await f.atoms();
    expect(graph.filter((a) => a.kind === "agent.wait.requested")).toHaveLength(
      3,
    );
    expect(
      graph.filter((a) => a.kind === "agent.speech.decision").at(-1)?.payload,
    ).toMatchObject({
      outcome: "silent",
      attempt: 3,
      reasonCodes: ["wait-budget-exhausted"],
    });
  });

  it("starts wait at persisted model completion even when the Planner is slow", async () => {
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture([() => blocked]);
    try {
      await f.submit(f.message());
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.setTime(60000);
      release(wait);
      await f.settle();
      const graph = await f.atoms();
      expect(
        graph.find((a) => a.kind === "agent.wait.requested")?.payload.dueAt,
      ).toBe("2026-09-12T12:01:05.000Z");
      expect(f.requests).toHaveLength(1);
    } finally {
      release(wait);
    }
  });

  it("replays after a decision write failure without repeating the completed Planner", async () => {
    const f = await fixture([speak]);
    const commit = f.core().commitTerminal.bind(f.core());
    let interrupted = false;
    const hook = vi
      .spyOn(f.core(), "commitTerminal")
      .mockImplementation((...args) => {
        if (args[2].kind === "agent.speech.decision" && !interrupted) {
          interrupted = true;
          return Promise.reject(
            new Error("synthetic decision write interruption"),
          );
        }
        return commit(...args);
      });
    try {
      await f.submit(f.message());
      await vi.waitFor(() => expect(interrupted).toBe(true));
      f.setTime(10000);
      await f.restart();
      await f.settle();
      const graph = await f.atoms();
      expect(f.requests.map((r) => r.model)).toEqual([
        "deepseek-light",
        "deepseek-heavy",
      ]);
      expect(
        graph.filter((a) => a.kind === "agent.speech.decision"),
      ).toHaveLength(1);
      expect(f.delivered).toHaveBeenCalledTimes(1);
    } finally {
      hook.mockRestore();
    }
  });

  it("expiry recovers after restart and stops at the shared three-wait budget", async () => {
    const f = await fixture([wait, wait, wait, wait]);
    await f.submit(f.message());
    await f.settle();
    for (let round = 1; round <= 3; round++) {
      f.setTime(6000);
      await f.restart();
      await vi.waitFor(() => expect(f.requests).toHaveLength(round + 1), {
        timeout: 8000,
        interval: 20,
      });
      await f.settle();
    }
    const graph = await f.atoms();
    expect(graph.filter((a) => a.kind === "agent.wait.requested")).toHaveLength(
      3,
    );
    expect(
      graph.filter((a) => a.kind === "agent.speech.decision").at(-1)?.payload,
    ).toMatchObject({
      outcome: "silent",
      attempt: 3,
      reasonCodes: ["wait-budget-exhausted"],
    });
    expect(kinds(graph)).not.toContain("agent.turn.failed");
    expect(f.delivered).not.toHaveBeenCalled();
  });
});
