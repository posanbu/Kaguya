/**
 * 补充 QQ 插件在真实 Runtime 中的收藏、发送回执、语境门控和重启限频验证。
 * 测试配置分别声明 inboundAllowlist/outboundAllowlist，保持与严格 Profile 或 Runtime 出站策略契约一致。
 * 兼容 #136 的 agent.turn.plan 与 message/wait/silent 契约，仅增强已合并的单一 Planner 链。
 * 测试显式批准合成 QQ 目标，Runtime 未注入策略时默认拒绝非 Web 出站。
 * 功能概述：通过真实 Runtime/PGlite 与 DeepSeek-compatible HTTP mock 验证先观察、后规划的发言链。
 * fixture 装配正式 Catalog、light Planner 和 heavy Composer；settle 等待 durable 订阅闭合，
 * restart 保留数据库并重建宿主，advance 推进持久 heartbeat 时钟。仅 mock provider HTTP，
 * waitForPersistence 将本 fixture 的启动、打断、重建、重放及 settle 等待统一到已有的 8 秒
 * 持久化预算，条件满足即继续；不改变注入时钟、业务静默窗、等待次数或精确行为断言。
 * 多次取消、重建与重启场景另设 30 秒总预算；QQ 四至五轮 45 秒、八轮加重启 60 秒。
 * macOS 四轮实测约 26 秒，Windows 八轮约 29 秒，顺序 I/O 不能套用单轮的 15 秒总上限；
 * 每次状态等待仍受 8 秒预算约束，不增加业务 deadline 或允许的重试次数。
 * 尚未提交决策的 Planner 可由新输入打断；静默窗后合并旧、新输入重构，已提交决策仍保持唯一终态。
 * 覆盖 message/wait/silent 与 target union 的 JSON mode 本地校验、一次结构修复、耗尽后失败关闭、
 * 累计 usage 和单 requested/terminal/decision；重试复用冻结 Prompt，重放与新输入取消均不重复落地。
 * Planner v2 的每轮 schema 在模型修复阶段拒绝超预算 wait 与焦点越界；保留单次结构修复和单一回合终态。
 * 同时保留直接信号、Planner 独立等待预算和并发入站去重回归。
 * 所有消息和密钥均为合成测试数据；清理按 Runtime、数据库顺序关闭，不访问外部服务。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  attentionArousalStateRecordedInformationKind,
  createFirstPartyModuleConfigDefaults,
} from "@kaguya/modules";
import {
  KaguyaRuntime,
  GatewayAllowlist,
  ModelTaskClient,
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
import { afterEach, describe, expect, it, vi } from "vitest";

const PERSISTENCE_WAIT = { timeout: 8000, interval: 20 } as const;
const MULTI_STAGE_TIMEOUT = 30_000;
const QQ_MULTI_TURN_TIMEOUT = 45_000;
const QQ_RESTART_TIMEOUT = 60_000;
function waitForPersistence(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, PERSISTENCE_WAIT);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const speak = {
  action: "message",
  reason: "respond",
  composition: {
    focusInputIndexes: [0],
    topic: "当前消息",
    replyAct: "回应用户",
  },
};
const silent = { action: "silent", reason: "no-response-needed" };
const wait = { action: "wait", reason: "await-more-context", waitSeconds: 5 };

async function fixture(outputs: unknown[], qqExpression = false) {
  let expressionChoice: {
    assetInformationId: string | null;
    emoji: string | null;
  } = { assetInformationId: null, emoji: "😂" };
  const database = await createTestingDatabase();
  let now = Date.parse("2026-09-12T12:00:00.000Z");
  const requests: Record<string, any>[] = [];
  const backgroundRequests: Record<string, any>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const promptText = JSON.stringify(request.messages);
    const learning = promptText.includes("归纳这批真人消息");
    const qqSelecting = promptText.includes("已判定幽默/友好调侃");
    const qqLearning = promptText.includes("你负责从文字上下文推断一个");
    const qqSourceText = request.messages
      .map((m: { content: unknown }) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
    const selecting = promptText.includes("依据冻结回合和已获胜的消息意图");
    (learning || selecting || qqSelecting || qqLearning
      ? backgroundRequests
      : requests
    ).push(request);
    const pending = qqSelecting
      ? expressionChoice
      : qqLearning
        ? {
            meaning: "好笑的无奈",
            usage: "友好自嘲",
            confidence: 0.95,
            evidenceIds: [
              qqSourceText.match(/"id":"([^"]+)"/u)?.[1] ?? "missing",
            ],
          }
        : learning
          ? { patterns: [] }
          : selecting
            ? { habitIds: [] }
            : request.model === "deepseek-light"
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
    {
      moduleConfigs: [
        ...createFirstPartyModuleConfigDefaults("test"),
        ...(qqExpression
          ? [
              {
                version: 1 as const,
                instanceId: "qq-expression.default",
                definitionId: "plugin.qq-expression",
                enabled: true,
                settings: { cooldownSeconds: 60, minMessagesBetween: 3 },
              },
            ]
          : []),
      ],
    },
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
      outboundAllowlist: new GatewayAllowlist(["qq:private:*", "qq:group:*"]),
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
    await waitForPersistence(async () =>
      expect((await database.information.reliable.health()).pending).toBe(0),
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
    waitForDeliveries: (count: number) =>
      waitForPersistence(() => expect(delivered).toHaveBeenCalledTimes(count)),
    database,
    requests,
    backgroundRequests,
    useExpression(choice: typeof expressionChoice) {
      expressionChoice = choice;
    },
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

describe("Heartflow Planner via DeepSeek-compatible provider", () => {
  it.each([speak, silent, wait])("closes the $action DAG", async (output) => {
    const f = await fixture([output]);
    await f.submit(f.message());
    await f.settle();
    const graph = await f.atoms();
    const decision = graph.find((a) => a.kind === "agent.turn.plan.completed")!;
    expect((decision.payload.action as { action: string }).action).toBe(
      output.action,
    );
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
      output.action === "message"
        ? "agent.turn.completed"
        : output.action === "wait"
          ? "agent.turn.waiting"
          : "agent.turn.silent",
    );
    expect(kinds(graph)).not.toContain("agent.turn.failed");
    expect(f.requests.filter((r) => r.model === "deepseek-heavy")).toHaveLength(
      output.action === "message" ? 1 : 0,
    );
    expect(f.delivered).toHaveBeenCalledTimes(
      output.action === "message" ? 1 : 0,
    );
    if (output.action !== "message")
      expect(kinds(graph)).not.toContain("core.message.assistant.text");
  });

  it.each([
    { invalid: "", recovered: speak },
    { invalid: "INVALID_PRIVATE_PROVIDER_RESPONSE", recovered: wait },
    { invalid: { action: "message", reason: "respond" }, recovered: silent },
  ])(
    "repairs one invalid response before $recovered.action",
    async ({ invalid, recovered }) => {
      const f = await fixture([invalid, recovered]);
      await f.submit(f.message());
      await f.settle();
      const graph = await f.atoms();
      const plannerRequests = f.requests.filter(
        (r) => r.model === "deepseek-light",
      );
      expect(plannerRequests).toHaveLength(2);
      expect(plannerRequests[1]?.messages).toEqual(
        plannerRequests[0]?.messages,
      );
      for (const request of plannerRequests)
        expect(request.response_format).toEqual({ type: "json_object" });
      expect(JSON.stringify(plannerRequests[1]?.messages)).not.toContain(
        "INVALID_PRIVATE_PROVIDER_RESPONSE",
      );
      const tasks = graph.filter((a) => a.payload.taskId === "agent.turn.plan");
      expect(
        tasks.filter((a) => a.kind === "core.model.task.requested"),
      ).toHaveLength(1);
      const terminals = tasks.filter(
        (a) => a.kind !== "core.model.task.requested",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.kind).toBe("core.model.task.completed");
      expect(terminals[0]?.payload).toMatchObject({
        output: recovered,
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      });
      const decisions = graph.filter(
        (a) => a.kind === "agent.turn.plan.completed",
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.payload.action).toMatchObject(recovered);
      expect(kinds(graph)).not.toContain("agent.turn.failed");
      expect(f.delivered).toHaveBeenCalledTimes(
        recovered.action === "message" ? 1 : 0,
      );
      const requestCount = f.requests.length;
      await f.restart();
      await f.settle();
      expect(f.requests).toHaveLength(requestCount);
      const replayed = await f.atoms();
      expect(
        replayed.filter((a) => a.payload.taskId === "agent.turn.plan"),
      ).toHaveLength(tasks.length);
      expect(
        replayed.filter((a) => a.kind === "agent.turn.plan.completed"),
      ).toHaveLength(1);
      expect(f.delivered).toHaveBeenCalledTimes(
        recovered.action === "message" ? 1 : 0,
      );
    },
  );

  it.each([
    { kind: "current" },
    {
      kind: "group",
      reference: "synthetic-group-reference",
      instruction: "转告合成测试消息",
    },
    {
      kind: "private",
      reference: "synthetic-private-reference",
      instruction: "转告合成测试消息",
    },
    { kind: "unresolved", reason: "not-found" },
  ])(
    "accepts the nested $kind target union before routing authorization",
    async (target) => {
      const output = { ...speak, target };
      const f = await fixture([output]);
      await f.submit(f.message());
      await f.settle();
      const graph = await f.atoms();
      const terminal = graph.find(
        (a) =>
          a.kind === "core.model.task.completed" &&
          a.payload.taskId === "agent.turn.plan",
      );
      expect(terminal?.payload.output).toEqual(output);
      expect(
        graph.find((a) => a.kind === "agent.turn.plan.completed")?.payload
          .action,
      ).toEqual(output);
      expect(
        f.requests.filter((r) => r.model === "deepseek-light"),
      ).toHaveLength(1);
      expect(f.requests[0]?.response_format).toEqual({ type: "json_object" });
      expect(f.delivered).toHaveBeenCalledTimes(
        target.kind === "current" ? 1 : 0,
      );
    },
  );

  it.each([
    "",
    "not JSON",
    { action: "message", reason: "invented" },
    { ...wait, waitSeconds: 4 },
    { ...wait, waitSeconds: 121 },
    { ...wait, waitSeconds: 5.5 },
    { ...silent, text: "forbidden reply" },
  ])(
    "fails closed after exhausting one structural repair for %j",
    async (output) => {
      const f = await fixture([output, output]);
      await f.submit(f.message());
      await f.settle();
      const graph = await f.atoms();
      expect(
        graph.find((a) => a.kind === "agent.turn.plan.completed")?.payload,
      ).toMatchObject({
        action: { action: "silent", reason: "planner-unavailable" },
      });
      expect(kinds(graph)).toContain("agent.turn.silent");
      expect(kinds(graph)).not.toContain("agent.turn.failed");
      expect(kinds(graph)).not.toContain("core.message.assistant.text");
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.messages).toEqual(f.requests[0]?.messages);
      expect(f.delivered).not.toHaveBeenCalled();
      const tasks = graph.filter((a) => a.payload.taskId === "agent.turn.plan");
      expect(
        tasks.filter((a) => a.kind === "core.model.task.requested"),
      ).toHaveLength(1);
      expect(
        tasks
          .filter((a) => a.kind !== "core.model.task.requested")
          .map((a) => a.kind),
      ).toEqual(["core.model.task.failed"]);
      expect(
        graph.filter((a) => a.kind === "agent.turn.plan.completed"),
      ).toHaveLength(1);
      await f.restart();
      await f.settle();
      expect(f.requests).toHaveLength(2);
      const replayed = await f.atoms();
      expect(
        replayed.filter((a) => a.payload.taskId === "agent.turn.plan"),
      ).toHaveLength(tasks.length);
      expect(
        replayed.filter((a) => a.kind === "agent.turn.plan.completed"),
      ).toHaveLength(1);
    },
  );

  it("repairs out-of-turn focus before dispatch and replays the v2 decision once", async () => {
    const f = await fixture([
      {
        ...speak,
        composition: { ...speak.composition, focusInputIndexes: [1] },
      },
      speak,
    ]);
    await f.submit(f.message());
    await f.settle();
    const before = await f.atoms();
    expect(f.requests).toHaveLength(3); // invalid Planner, repaired Planner, Composer
    const task = before.find(
      (a) =>
        a.kind === "core.model.task.requested" &&
        a.payload.taskId === "agent.turn.plan",
    )!;
    expect(task.payload.version).toBe("2");
    expect(
      before.filter((a) => a.kind === "agent.turn.plan.completed"),
    ).toHaveLength(1);
    expect(f.delivered).toHaveBeenCalledTimes(1);
    await f.restart();
    await f.settle();
    expect(f.requests).toHaveLength(3);
    expect(f.delivered).toHaveBeenCalledTimes(1);
  });

  it("fails closed without structural repair for an HTTP failure", async () => {
    const f = await fixture(["HTTP_FAILURE", speak]);
    await f.submit(f.message());
    await f.settle();
    const graph = await f.atoms();
    expect(
      graph.find((a) => a.kind === "agent.turn.plan.completed")?.payload.action,
    ).toEqual({
      action: "silent",
      reason: "planner-unavailable",
    });
    expect(kinds(graph)).toContain("core.model.task.failed");
    expect(kinds(graph)).toContain("agent.turn.silent");
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

  it("observes an ordinary group opportunity while Arousal is awake", async () => {
    const f = await fixture([silent]);
    await f.submit(
      f.message("m1", {
        text: "哈哈",
        target: { kind: "group", groupId: "group" },
        mentions: [{ kind: "user", id: "other" }],
      }),
    );
    await f.settle();
    expect(f.requests).toHaveLength(1);
    const graph = await f.atoms();
    expect(
      graph.find((atom) => atom.kind === "agent.attention.arousal.completed")
        ?.payload,
    ).toMatchObject({
      outcome: "observe",
      arousalState: "awake",
      wakeSignal: false,
      reasonCodes: ["arousal-awake"],
    });
    expect(kinds(graph)).toContain("agent.turn.context.completed");
    expect(kinds(graph)).toContain("agent.turn.silent");
  });

  it(
    "recovers wait across restart, merges a new message, and replies once",
    async () => {
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
    },
    MULTI_STAGE_TIMEOUT,
  );

  it.each([false, true])(
    "interrupts Planner during repair=%s and coalesces incoming messages after the quiet window",
    async (duringRepair) => {
      let release!: (value: unknown) => void;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const f = await fixture([
        ...(duringRepair ? ["not JSON"] : []),
        () => blocked,
        speak,
      ]);
      const blockedRequestCount = duringRepair ? 2 : 1;
      try {
        await f.submit(f.message());
        await waitForPersistence(() =>
          expect(f.requests).toHaveLength(blockedRequestCount),
        );
        f.setTime(1000);
        for (let i = 0; i < 8; i++)
          await f.submit(f.message(`m${i + 2}`, { text: `更新的消息 ${i}` }));
        await waitForPersistence(async () =>
          expect(kinds(await f.atoms())).toContain("agent.observation.wake"),
        );
        expect(
          (await f.atoms()).filter((a) => a.kind === "agent.turn.candidate"),
        ).toHaveLength(1);
        expect(f.requests).toHaveLength(blockedRequestCount);
        release(speak);
        await f.settle();
        f.setTime(1001);
        await f.restart();
        await f.settle();
        const graph = await f.atoms();
        expect(
          graph.filter((a) => a.kind === "agent.turn.decision.interrupted"),
        ).toHaveLength(1);
        expect(
          graph.filter((a) => a.kind === "agent.turn.context.completed").at(-1)
            ?.payload.inputs,
        ).toHaveLength(9);
        expect(f.requests.map((r) => r.model)).toEqual([
          ...(duringRepair ? ["deepseek-light"] : []),
          "deepseek-light",
          "deepseek-light",
          "deepseek-heavy",
        ]);
        expect(
          graph.filter((a) => a.kind === "core.message.assistant.text"),
        ).toHaveLength(1);
        const plannerTasks = graph.filter(
          (a) => a.payload.taskId === "agent.turn.plan",
        );
        expect(
          plannerTasks.filter((a) => a.kind === "core.model.task.requested"),
        ).toHaveLength(2);
        expect(
          plannerTasks.filter((a) => a.kind === "core.model.task.cancelled"),
        ).toHaveLength(1);
        expect(
          plannerTasks.filter((a) => a.kind === "core.model.task.completed"),
        ).toHaveLength(1);
        expect(
          graph.filter((a) => a.kind === "agent.turn.plan.completed"),
        ).toHaveLength(1);
        expect(f.delivered).toHaveBeenCalledTimes(1);
        const requestCount = f.requests.length;
        await f.restart();
        await f.settle();
        expect(f.requests).toHaveLength(requestCount);
        expect(f.delivered).toHaveBeenCalledTimes(1);
      } finally {
        release(speak);
      }
    },
    MULTI_STAGE_TIMEOUT,
  );

  it(
    "refreshes the interruption quiet window from the latest message",
    async () => {
      let release!: (value: unknown) => void;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const f = await fixture([() => blocked, silent]);
      try {
        await f.submit(f.message());
        await waitForPersistence(() => expect(f.requests).toHaveLength(1));
        f.setTime(1000);
        await f.submit(f.message("m2"));
        await waitForPersistence(async () =>
          expect(kinds(await f.atoms())).toContain("agent.turn.interrupted"),
        );
        release(silent);
        await f.settle();
        f.setTime(500);
        await f.submit(f.message("m3"));
        await f.settle();
        f.setTime(900);
        await f.restart();
        await f.settle();
        expect(f.requests).toHaveLength(1);
        f.setTime(101);
        await f.restart();
        await f.settle();
        expect(f.requests).toHaveLength(2);
        expect(
          (await f.atoms())
            .filter((a) => a.kind === "agent.turn.context.completed")
            .at(-1)?.payload.inputs,
        ).toHaveLength(3);
      } finally {
        release(silent);
      }
    },
    MULTI_STAGE_TIMEOUT,
  );

  it(
    "stops interrupting after two Planner rebuilds",
    async () => {
      const releases: ((value: unknown) => void)[] = [];
      const blocked = () =>
        new Promise((resolve) => {
          releases.push(resolve);
        });
      const f = await fixture([blocked, blocked, blocked, silent]);
      try {
        await f.submit(f.message());
        await waitForPersistence(() => expect(releases).toHaveLength(1));
        for (let round = 1; round <= 2; round++) {
          f.setTime(1000);
          await f.submit(f.message(`m${round + 1}`));
          await waitForPersistence(async () =>
            expect(
              (await f.atoms()).filter(
                (a) => a.kind === "agent.turn.interrupted",
              ),
            ).toHaveLength(round),
          );
          releases[round - 1]!(silent);
          await f.settle();
          f.setTime(1001);
          await f.restart();
          await waitForPersistence(() =>
            expect(releases).toHaveLength(round + 1),
          );
        }
        f.setTime(1000);
        await f.submit(f.message("m4"));
        await waitForPersistence(async () =>
          expect(kinds(await f.atoms())).toContain("agent.observation.wake"),
        );
        expect(
          (await f.atoms()).filter((a) => a.kind === "agent.turn.interrupted"),
        ).toHaveLength(2);
        releases[2]!(silent);
        await f.settle();
      } finally {
        for (const release of releases) release(silent);
      }
    },
    MULTI_STAGE_TIMEOUT,
  );

  it(
    "rebuilds on new input without consuming the wait budget",
    async () => {
      let release!: (value: unknown) => void;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const f = await fixture([() => blocked, speak]);
      try {
        await f.submit(f.message());
        await waitForPersistence(() => expect(f.requests).toHaveLength(1));
        f.setTime(1000);
        await f.submit(f.message("during-wait"));
        await waitForPersistence(async () =>
          expect(kinds(await f.atoms())).toContain("agent.observation.wake"),
        );
        release(wait);
        await f.settle();
        f.setTime(1001);
        await f.restart();
        await f.settle();
        const turns = (await f.atoms()).filter(
          (a) => a.kind === "agent.turn.context.completed",
        );
        expect(turns).toHaveLength(2);
        expect(turns[1]!.payload.attempt).toBe(0);
        expect(
          (await f.atoms())
            .filter((a) => a.kind === "agent.turn.candidate")
            .at(-1)?.payload.rebuildAttempt,
        ).toBe(1);
        expect(turns[1]!.payload.inputs).toHaveLength(2);
        expect(f.delivered).toHaveBeenCalledTimes(1);
        f.setTime(10000);
        await f.restart();
        await f.settle();
        expect(f.requests).toHaveLength(3);
        expect(f.delivered).toHaveBeenCalledTimes(1);
      } finally {
        release(wait);
      }
    },
    MULTI_STAGE_TIMEOUT,
  );

  it("cancels an in-flight Planner and ignores its late message output", async () => {
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture([() => blocked]);
    try {
      await f.submit(f.message());
      await waitForPersistence(() => expect(f.requests).toHaveLength(1));
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
        graph.find((a) => a.kind === "agent.turn.plan.completed")?.payload
          .action,
      ).toEqual({ action: "silent", reason: "planner-unavailable" });
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

  it(
    "keeps Arousal defer outside the Planner wait budget",
    async () => {
      const f = await fixture([wait, wait, wait, wait]);
      const group = { kind: "group" as const, groupId: "group" };
      await f.core().register(attentionArousalStateRecordedInformationKind, {
        occurredAt: "2026-09-12T12:00:00.000Z",
        source: "module:test",
        payload: {
          state: "asleep",
          cause: "external",
          lastEvaluatedAt: "2026-09-12T12:00:00.000Z",
          lastInboundInformationId: null,
          lastActivityAt: "2026-09-12T12:00:00.000Z",
          sleepStartedAt: "2026-09-12T12:00:00.000Z",
          lastPeriodicWakeAt: null,
          reasonCodes: ["test-asleep"],
          policyVersion: "attention-observation.v1",
        },
        references: [],
      });
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
      for (let round = 0; round < 3; round++) {
        f.setTime(6000);
        await f.restart();
        await waitForPersistence(() =>
          expect(f.requests).toHaveLength(round === 2 ? 5 : round + 2),
        );
        await f.settle();
      }
      const graph = await f.atoms();
      expect(f.requests).toHaveLength(5);
      expect(
        graph.filter(
          (a) =>
            a.kind === "core.model.task.requested" &&
            a.payload.taskId === "agent.turn.plan",
        ),
      ).toHaveLength(4);
      expect(
        graph.filter((a) => a.kind === "agent.wait.requested"),
      ).toHaveLength(3);
      expect(
        graph.filter((a) => a.kind === "agent.turn.plan.completed").at(-1)
          ?.payload,
      ).toMatchObject({
        action: { action: "silent", reason: "no-response-needed" },
      });
    },
    MULTI_STAGE_TIMEOUT,
  );

  it("starts wait at persisted model completion even when the Planner is slow", async () => {
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture([() => blocked]);
    try {
      await f.submit(f.message());
      await waitForPersistence(() => expect(f.requests).toHaveLength(1));
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

  it(
    "rebuilds after a decision write failure when new input arrives before decision commit",
    async () => {
      const f = await fixture([speak, speak]);
      const commit = f.core().commitTerminal.bind(f.core());
      let interrupted = false;
      const hook = vi
        .spyOn(f.core(), "commitTerminal")
        .mockImplementation((...args) => {
          if (args[2].kind === "agent.turn.plan.completed" && !interrupted) {
            interrupted = true;
            return Promise.reject(
              new Error("synthetic decision write interruption"),
            );
          }
          return commit(...args);
        });
      try {
        await f.submit(f.message());
        await waitForPersistence(() => expect(interrupted).toBe(true));
        await f.submit(
          f.message("late-history", {
            occurredAt: "2026-09-12T11:59:00.000Z",
            text: "BACKDATED_HISTORY",
          }),
        );
        f.setTime(10000);
        await f.restart();
        await f.settle();
        f.setTime(1001);
        await f.restart();
        await f.settle();
        const graph = await f.atoms();
        expect(f.requests.map((r) => r.model)).toEqual([
          "deepseek-light",
          "deepseek-light",
          "deepseek-heavy",
        ]);
        expect(JSON.stringify(f.requests[0])).not.toContain(
          "BACKDATED_HISTORY",
        );
        expect(JSON.stringify(f.requests[1])).toContain("BACKDATED_HISTORY");
        expect(
          graph.filter((a) => a.kind === "agent.turn.plan.completed"),
        ).toHaveLength(1);
        expect(
          graph.filter((a) => a.kind === "agent.turn.decision.interrupted"),
        ).toHaveLength(1);
        expect(f.delivered).toHaveBeenCalledTimes(1);
      } finally {
        hook.mockRestore();
      }
    },
    MULTI_STAGE_TIMEOUT,
  );

  it(
    "expiry recovers after restart and stops at the shared three-wait budget",
    async () => {
      const f = await fixture([wait, wait, wait, wait]);
      await f.submit(f.message());
      await f.settle();
      for (let round = 1; round <= 3; round++) {
        f.setTime(6000);
        await f.restart();
        await waitForPersistence(() =>
          expect(f.requests).toHaveLength(round === 3 ? 5 : round + 1),
        );
        await f.settle();
      }
      const graph = await f.atoms();
      expect(f.requests).toHaveLength(5);
      expect(
        graph.filter(
          (a) =>
            a.kind === "core.model.task.requested" &&
            a.payload.taskId === "agent.turn.plan",
        ),
      ).toHaveLength(4);
      expect(
        graph.filter((a) => a.kind === "agent.wait.requested"),
      ).toHaveLength(3);
      expect(
        graph.filter((a) => a.kind === "agent.turn.plan.completed").at(-1)
          ?.payload,
      ).toMatchObject({
        action: { action: "silent", reason: "no-response-needed" },
      });
      expect(kinds(graph)).not.toContain("agent.turn.failed");
      expect(f.delivered).not.toHaveBeenCalled();
    },
    MULTI_STAGE_TIMEOUT,
  );
});

describe("independent QQ expression plugin through real Runtime", () => {
  const humorous = {
    ...speak,
    composition: { ...speak.composition, tone: "humorous" },
  };
  it(
    "limits Unicode emoji across restart and preserves the ordinary reply pipeline",
    async () => {
      const f = await fixture(
        Array.from({ length: 8 }, () => humorous),
        true,
      );
      for (let i = 0; i < 4; i++) {
        f.setTime(1);
        await f.submit(f.message(`emoji-${i}`));
        await f.waitForDeliveries(i + 1);
        await f.settle();
      }
      expect(
        (await f.atoms()).filter((a) =>
          /consumer.failed|execution.exhausted/.test(a.kind),
        ),
      ).toEqual([]);
      const contents = () =>
        f.delivered.mock.calls.map(
          (call) => (call as unknown as [unknown, { text: string }])[1].text,
        );
      expect(contents()).toEqual([
        "reply-body",
        "reply-body",
        "reply-body",
        "reply-body 😂",
      ]);
      // 新消息只推进 1 毫秒，保证先后顺序且仍在冷却窗口内；重启不得归还额度。
      // 冷却到期边界由纯策略测试控制，不混入真实 Scheduler 的到期触发。
      await f.restart();
      for (let i = 4; i < 8; i++) {
        f.setTime(1);
        await f.submit(f.message(`emoji-${i}`));
        await f.waitForDeliveries(i + 1);
        await f.settle();
      }
      expect(contents().slice(4)).toEqual(
        Array.from({ length: 4 }, () => "reply-body"),
      );
      expect(
        (await f.atoms()).filter((a) => a.kind === "core.delivery.delivered"),
      ).toHaveLength(8);
    },
    QQ_RESTART_TIMEOUT,
  );
  it(
    "sends a collected QQ face only in a humorous plan and falls back on neutral plans",
    async () => {
      const f = await fixture(
        [humorous, humorous, humorous, humorous, speak],
        true,
      );
      await f.submit(
        f.message("face-source", {
          text: "哈哈这次又翻车了[face:14]",
          expressions: [{ kind: "face", id: "14" }],
        }),
      );
      await f.waitForDeliveries(1);
      await f.settle();
      const asset = (await f.atoms()).find(
        (a) => a.kind === "plugin.qq-expression.collected",
      )!;
      expect(asset).toBeDefined();
      expect(
        (await f.atoms()).find((a) => a.kind === "plugin.qq-expression.learned")
          ?.payload.confidence,
      ).toBe(0.95);
      f.useExpression({ assetInformationId: asset.informationId, emoji: null });
      for (let i = 1; i < 5; i++) {
        f.setTime(1);
        await f.submit(f.message(`face-${i}`));
        await f.waitForDeliveries(i + 1);
        await f.settle();
      }
      expect(
        (f.delivered.mock.calls[3] as unknown as [unknown, unknown])[1],
      ).toMatchObject({
        text: "reply-body",
        expression: { kind: "face", id: "14" },
      });
      expect(
        (f.delivered.mock.calls[4] as unknown as [unknown, unknown])[1],
      ).toEqual({ kind: "text", text: "reply-body" });
      expect(
        (await f.atoms()).filter((a) => a.kind === "core.delivery.delivered"),
      ).toHaveLength(5);
    },
    QQ_MULTI_TURN_TIMEOUT,
  );
});

it(
  "keeps normal delivery alive when the optional expression model fails",
  async () => {
    const humorous = {
      ...speak,
      composition: { ...speak.composition, tone: "humorous" },
    };
    const f = await fixture(
      Array.from({ length: 4 }, () => humorous),
      true,
    );
    f.useExpression("HTTP_FAILURE" as never);
    for (let i = 0; i < 4; i++) {
      f.setTime(1);
      await f.submit(f.message(`optional-failure-${i}`));
      await f.waitForDeliveries(i + 1);
      await f.settle();
    }
    expect(
      (f.delivered.mock.calls[3] as unknown as [unknown, unknown])[1],
    ).toEqual({ kind: "text", text: "reply-body" });
    const graph = await f.atoms();
    expect(
      graph.some(
        (a) =>
          a.kind === "core.model.task.failed" &&
          a.payload.taskId === "plugin.qq-expression.select",
      ),
    ).toBe(true);
    expect(graph.filter((a) => a.kind === "agent.turn.failed")).toHaveLength(0);
    expect(
      graph.filter((a) => a.kind === "core.delivery.delivered"),
    ).toHaveLength(4);
  },
  QQ_MULTI_TURN_TIMEOUT,
);
