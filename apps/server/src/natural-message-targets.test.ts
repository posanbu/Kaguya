/**
 * 功能概述：以正式 Composition、Runtime、PGlite 和受控 HTTP provider 验证自然语言跨会话链路。
 * fixture 仅替换模型响应、在线目录与 transport，仍执行身份识别、Planner、Composer、授权和 durable 去重。
 * 覆盖双投影的范围隔离、群/私聊选择、歧义与撤销后的失败关闭；所有账号、正文和凭据均为合成数据。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import {
  KaguyaRuntime,
  GatewayAllowlist,
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
import { afterEach, expect, it, vi } from "vitest";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const speak = { action: "message", reason: "respond" };
const silent = { action: "silent", reason: "no-response-needed" };

async function fixture(
  outputs: unknown[],
  options: {
    unavailable?: boolean;
    duplicate?: boolean;
    composer?: () => void;
  } = {},
) {
  let generation = "test-generation";
  const candidates = [
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group" as const, groupId: "source-group" },
      name: "当前研究群",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group" as const, groupId: "other-group" },
      name: "协作群",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "private" as const, userId: "speaker-account" },
      name: "小明",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "private" as const, userId: "colleague-account" },
      name: "小红",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group" as const, groupId: "unrelated-private-id" },
      name: "无关会话",
    },
  ];
  if (options.duplicate)
    candidates.push({
      ...candidates[1]!,
      destination: { kind: "group", groupId: "duplicate-group" },
    });
  const policy = new GatewayAllowlist(["qq:private:*", "qq:group:*"]);

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
    const output =
      typeof pending === "function" ? await pending(request) : pending;
    if (request.model !== "deepseek-light") options.composer?.();
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
  let core: RuntimeCapabilityContext["core"];
  const start = async () => {
    const runtime = new KaguyaRuntime({
      ...composition,
      outboundAllowlist: policy,
      targetDirectory: {
        listTargets: async () => {
          if (options.unavailable)
            throw new Error("synthetic-directory-failure");
          return { generation, candidates };
        },
        isCurrentGeneration: (value) => value === generation,
      },
      database,
      now: () => new Date(now),
      capabilities: (context) => {
        core = context.core;
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
    text: "Kaguya 请发到协作群：会议三点开始",
    selfId: "bot",
    mentions: [{ kind: "user", id: "bot" }],
    target: { kind: "group", groupId: "source-group" },
    sender: { userId: "speaker-account", nickname: "小明" },
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
    policy,
    candidates,
    reconnect: () => {
      generation = "new-generation";
    },
    service: () => runtime.messageTargets!,
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

function projection(request: Record<string, any>) {
  const text = request.messages.map((m: any) => m.content).join("\n");
  return JSON.parse(text.split("结构化人物/会话上下文：").at(-1)!);
}
function choose(kind: "group" | "private", relation: string) {
  return (request: Record<string, any>) => {
    const c = projection(request).resolution.targets.find(
      (t: any) =>
        t.kind === kind && t.relation === relation && t.status === "resolved",
    );
    return {
      ...speak,
      target: {
        kind,
        reference: c?.reference ?? "missing-reference",
        instruction: "会议三点开始",
      },
    };
  };
}
it.each([
  ["当前群回复", speak, "source-group", "普通问候"],
  [
    "显式当前群",
    { ...speak, target: { kind: "current" } },
    "source-group",
    "发到当前群",
  ],
  [
    "跨群",
    choose("group", "mentioned"),
    "other-group",
    "发到协作群：会议三点开始",
  ],
  [
    "私聊我",
    choose("private", "speaker"),
    "speaker-account",
    "私聊我：会议三点开始",
  ],
  [
    "告诉某人",
    choose("private", "mentioned"),
    "colleague-account",
    "告诉小红：会议三点开始",
  ],
])("%s 自动形成唯一意图与投递", async (_label, output, destination, text) => {
  const f = await fixture([output]);
  const message = f.message("once", { text: String(text) });
  await Promise.all([f.submit(message), f.submit(message)]);
  await f.settle();
  expect(f.delivered).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.delivered.mock.calls[0])).toContain(destination);
  const graph = await f.atoms();
  expect(
    graph.filter((a) => a.kind === "agent.message.intent.requested"),
  ).toHaveLength(1);
  expect(graph.filter((a) => a.kind === "agent.turn.completed")).toHaveLength(
    1,
  );
  const plan = f.requests.find((r) => r.model === "deepseek-light")!;
  const p = projection(plan);
  expect(p.background.name).toBe("当前研究群");
  expect(p.background.participants).toContainEqual(
    expect.objectContaining({
      name: "小明",
      identityStatus: "complete",
      relation: "speaker",
    }),
  );
  expect(JSON.stringify(p)).not.toContain("source-group");
  expect(JSON.stringify(p)).not.toContain("unrelated-private-id");
  expect(JSON.stringify(p)).not.toContain("无关会话");
  const composed = graph.find(
    (a) =>
      a.kind === "core.model.task.requested" &&
      a.payload.taskId === "agent.message.compose",
  )!;
  expect(JSON.stringify(composed.payload.prompt)).toContain("当前研究群");
  expect(JSON.stringify(composed.payload.prompt)).toContain("小明");
  expect(JSON.stringify(composed.payload.prompt)).not.toContain("other-group");
  if (destination !== "source-group") {
    expect(JSON.stringify(composed.payload.prompt)).not.toContain(
      "speaker-account",
    );
    const turn = graph.find((a) => a.kind === "agent.turn.context.completed")!;
    const decision = graph.find((a) => a.kind === "agent.turn.plan.completed")!;
    await Promise.all([
      f.service().route(turn, decision),
      f.service().route(turn, decision),
    ]);
    await f.settle();
    expect(f.delivered).toHaveBeenCalledTimes(1);
  }
});
it.each([
  "ambiguous",
  "unrecognized",
  "unreachable",
  "not-found",
  "unauthorized",
])("无法解析 %s 时关闭且不回退当前群", async (reason) => {
  const f = await fixture([
    { ...speak, target: { kind: "unresolved", reason } },
  ]);
  await f.submit(f.message());
  await f.settle();
  expect(f.delivered).not.toHaveBeenCalled();
  expect(
    (await f.atoms()).find((a) => a.kind === "agent.turn.failed")?.payload
      .reason,
  ).toBe(`target-${reason}`);
  expect(f.requests).toHaveLength(1);
});
it("同名群不暴露可选择引用", async () => {
  const f = await fixture(
    [
      (request: Record<string, any>) => {
        const targets = projection(request).resolution.targets.filter(
          (t: any) => t.name === "协作群",
        );
        expect(targets).toHaveLength(2);
        expect(
          targets.every(
            (t: any) => t.status === "ambiguous" && t.reference === null,
          ),
        ).toBe(true);
        return {
          ...speak,
          target: { kind: "unresolved", reason: "ambiguous" },
        };
      },
    ],
    { duplicate: true },
  );
  await f.submit(f.message());
  await f.settle();
  expect(f.delivered).not.toHaveBeenCalled();
});
it("目录不可用仍为普通对话提供本轮人物背景", async () => {
  const f = await fixture([speak], { unavailable: true });
  await f.submit(f.message());
  await f.settle();
  expect(projection(f.requests[0]!).resolution).toEqual({
    status: "unavailable",
    targets: [],
  });
  expect(
    JSON.stringify(f.requests.find((r) => r.model === "deepseek-heavy")),
  ).toContain("小明");
  expect(f.delivered).toHaveBeenCalledTimes(1);
});
it.each(["撤销白名单", "移除目标", "重连"])(
  "正文生成期间%s，最终校验禁止投递",
  async (mode) => {
    let invalidate = () => {};
    const f = await fixture([choose("group", "mentioned")], {
      composer: () => invalidate(),
    });
    invalidate = () => {
      if (mode === "撤销白名单")
        vi.spyOn(f.policy, "allowsDestination").mockReturnValue(false);
      else if (mode === "移除目标") f.candidates.splice(1, 1);
      else f.reconnect();
    };
    await f.submit(f.message());
    await f.settle();
    expect(f.delivered).not.toHaveBeenCalled();
    expect(
      (await f.atoms()).some((a) => a.kind === "core.delivery.failed"),
    ).toBe(true);
    expect((await f.atoms()).some((a) => a.kind === "agent.turn.failed")).toBe(
      true,
    );
  },
);
it("伪造目标引用被拒绝", async () => {
  const f = await fixture([
    {
      ...speak,
      target: {
        kind: "private",
        reference: "invented",
        instruction: "会议三点开始",
      },
    },
  ]);
  await f.submit(f.message());
  await f.settle();
  expect(f.delivered).not.toHaveBeenCalled();
  expect(
    (await f.atoms()).find((a) => a.kind === "agent.turn.failed")?.payload
      .reason,
  ).toBe("target-not-found");
});

it("意图写入失败后重放原 Planner 决策，不重复模型或投递", async () => {
  const f = await fixture([choose("group", "mentioned")]);
  const register = f.core().registerOnce.bind(f.core());
  let interrupted = false;
  const hook = vi
    .spyOn(f.core(), "registerOnce")
    .mockImplementation((...args) => {
      if (args[2].kind === "agent.message.intent.requested" && !interrupted) {
        interrupted = true;
        return Promise.reject(new Error("synthetic intent write interruption"));
      }
      return register(...args);
    });
  try {
    await f.submit(f.message());
    await vi.waitFor(() => expect(interrupted).toBe(true), { timeout: 8000 });
    f.setTime(10000);
    await f.settle();
    expect(f.requests.map((r) => r.model)).toEqual([
      "deepseek-light",
      "deepseek-heavy",
    ]);
    expect(f.delivered).toHaveBeenCalledTimes(1);
    expect(
      (await f.atoms()).filter(
        (a) => a.kind === "agent.message.intent.requested",
      ),
    ).toHaveLength(1);
  } finally {
    hook.mockRestore();
  }
});
it("跨会话不能复用重启前的冻结引用", async () => {
  const f = await fixture([choose("group", "mentioned")]);
  await f.submit(f.message());
  await f.settle();
  const graph = await f.atoms();
  const turn = graph.find((a) => a.kind === "agent.turn.context.completed")!;
  const decision = graph.find((a) => a.kind === "agent.turn.plan.completed")!;
  await f.restart();
  const result = await f.service().route(turn, decision);
  expect(result.status).toBe("failed");
  expect(f.delivered).toHaveBeenCalledTimes(1);
});

it("仅入站获准不会产生出站候选授权", async () => {
  const f = await fixture([
    (request: Record<string, any>) => {
      const group = projection(request).resolution.targets.find(
        (t: any) => t.name === "协作群",
      );
      expect(group.status).toBe("unauthorized");
      expect(group.reference).toBeNull();
      return {
        ...speak,
        target: { kind: "unresolved", reason: "unauthorized" },
      };
    },
  ]);
  vi.spyOn(f.policy, "allowsDestination").mockImplementation(
    (_platform, destination) =>
      destination.kind === "group" && destination.groupId === "source-group",
  );
  await f.submit(f.message());
  await f.settle();
  expect(f.delivered).not.toHaveBeenCalled();
  expect(
    (await f.atoms()).find((a) => a.kind === "agent.turn.failed")?.payload
      .reason,
  ).toBe("target-unauthorized");
});
