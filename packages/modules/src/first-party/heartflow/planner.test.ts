/**
 * 默认文本直接读取受版本控制的模板文件，与生产加载路径一致。
 * 功能概述：验证 Planner 的严格结构边界与真实 Prompt 编译，不调用外部模型。
 * 测试覆盖动作原因配对、等待整数范围、额外正文/目标拒绝，以及全部冻结输入和身份溯源。
 * 验证已投递引用的完整溯源、同名说话人区分、辅助上下文预算与本轮动态动作边界。
 * 与 index.test.ts 的持久化分派测试及 Runtime 双阶段集成互补，防止模型越权构造投递参数。
 */
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
const plannerTemplate = loadFirstPartyPromptTemplates().planner;
const plannerPlatformPolicies =
  loadFirstPartyPromptTemplates().plannerPlatformPolicies;
const plannerBootstrapPolicy =
  loadFirstPartyPromptTemplates().plannerBootstrapPolicy;
import { describe, expect, it } from "vitest";
import {
  compilePlannerPrompt,
  plannerActionSchema,
  plannerActionSchemaForTurn,
} from "./planner.js";
import { inboundTextInformationKind } from "../information-kinds.js";
import { atom, fixture, identity } from "../message-composer/test-fixtures.js";

describe("Planner contract", () => {
  it.each([
    { action: "message", reason: "respond", text: "forbidden" },
    { action: "message", reason: "respond", adapterId: "qq" },
    { action: "message", reason: "respond", userId: "123" },
    { action: "message", reason: "respond", destination: {} },
    { action: "silent", reason: "respond" },
    { action: "silent", reason: "planner-unavailable" },
    { action: "wait", reason: "await-more-context", waitSeconds: 4 },
    { action: "wait", reason: "await-more-context", waitSeconds: 121 },
    { action: "wait", reason: "await-more-context", waitSeconds: 5.5 },
    { action: "wait", reason: "await-more-context", waitSeconds: "5" },
  ])("rejects unauthorized output %j", (value) => {
    expect(plannerActionSchema.safeParse(value).success).toBe(false);
  });
  it.each([5, 120])("accepts wait boundary %i", (waitSeconds) => {
    expect(
      plannerActionSchema.safeParse({
        action: "wait",
        reason: "await-more-context",
        waitSeconds,
      }).success,
    ).toBe(true);
  });
  it.each([
    undefined,
    { focusInputIndexes: [], topic: "话题", replyAct: "回应" },
    { focusInputIndexes: [0, 0], topic: "话题", replyAct: "回应" },
    { focusInputIndexes: [0, 1, 2, 3], topic: "话题", replyAct: "回应" },
  ])("rejects invalid message composition %j", (composition) => {
    expect(
      plannerActionSchema.safeParse({
        action: "message",
        reason: "respond",
        composition,
      }).success,
    ).toBe(false);
  });
  it("compiles identity, policy and every frozen input with provenance", () => {
    const { atoms } = fixture(["FIRST_SENTINEL", "LAST_SENTINEL"]);
    const oldTurn = atoms.find(
      (atom) => atom.kind === "agent.turn.context.completed",
    )!;
    const turn = {
      ...oldTurn,
      payload: {
        ...oldTurn.payload,
        backlog: {
          isBacklog: true,
          evaluatedAt: "2026-09-15T00:00:00.000Z",
          oldestInputAgeMs: 300_000,
          newestInputAgeMs: 180_000,
          thresholdMs: 120_000,
        },
      },
    } as any;
    const testAtoms = atoms.map((atom) =>
      atom.informationId === oldTurn.informationId ? turn : atom,
    );
    const prompt = compilePlannerPrompt(
      identity,
      testAtoms,
      turn,
      plannerTemplate,
      plannerPlatformPolicies,
      plannerBootstrapPolicy,
    );
    expect(prompt.text).toContain(identity.persona);
    expect(prompt.text).toContain("FIRST_SENTINEL");
    expect(prompt.text).toContain("LAST_SENTINEL");
    expect(prompt.text).toContain("不可信数据");
    expect(prompt.text).toContain("QQ 中参与要克制");
    expect(prompt.text).toContain("bootstrap 只描述账本能够证明的熟悉度");
    expect(prompt.text).toContain('"mode":"legacy-unknown"');
    expect(
      prompt.variables.find((v) => v.name === "bootstrap")?.informationIds,
    ).toEqual([turn.informationId]);
    expect(prompt.text).toContain('"isBacklog":true');
    expect(prompt.text).toContain('"newestInputAgeMs":180000');
    expect(prompt.text).toContain(
      '当前时间：{"iso":"2026-09-15T00:00:00.000Z","timeZone":"Asia/Shanghai","local":"2026-09-15 周二 08:00:00"}',
    );
    expect(prompt.text).toContain('"inputIndex":0');
    expect(prompt.text).toContain('"localTime":"2026-09-09 周三 08:00:01"');
    expect(
      prompt.variables.find((v) => v.name === "turn")?.informationIds,
    ).toEqual([turn.informationId, "input-0"]);
    expect(prompt.text).not.toContain("group-1");
  });

  it("accepts the explicit expired-topic audit reason", () => {
    expect(
      plannerActionSchema.safeParse({
        action: "silent",
        reason: "topic-expired",
      }).success,
    ).toBe(true);
  });

  it("renders historical speaker, message identity, reply relation and local time", () => {
    const { atoms } = fixture(["CURRENT_INPUT"]);
    const turn = atoms.find(
      (entry) => entry.kind === "agent.turn.context.completed",
    )!;
    const history = atom("history-1", inboundTextInformationKind.kind, {
      text: "HISTORICAL_INPUT",
      source: {
        adapterId: "adapter",
        platform: "qq",
        destination: { kind: "group", groupId: "group-1" },
        senderId: "history-user",
        selfId: "bot-1",
        platformMessageId: "historical-message",
        replyTo: { platformMessageId: "earlier-message" },
      },
    });
    const prompt = compilePlannerPrompt(
      identity,
      [...atoms, history],
      turn,
      plannerTemplate,
    );
    expect(prompt.text).toContain('"speaker":"history-user"');
    expect(prompt.text).toContain('"platformMessageId":"historical-message"');
    expect(prompt.text).toContain('"replyTo":"earlier-message"');
    expect(prompt.text).toContain('"localTime":"2026-09-09 周三 08:00:01"');
  });

  it("requires and renders the frozen backlog projection", () => {
    const { atoms } = fixture(["LEGACY_INPUT"]);
    const turn = atoms.find(
      (atom) => atom.kind === "agent.turn.context.completed",
    )!;
    const prompt = compilePlannerPrompt(identity, atoms, turn, plannerTemplate);
    expect(prompt.text).toContain('"backlog":{"isBacklog":false');
    expect(prompt.text).toContain("LEGACY_INPUT");
  });
});

function compiledView(
  atoms: ReturnType<typeof atom>[],
  turn: ReturnType<typeof atom>,
) {
  const prompt = compilePlannerPrompt(identity, atoms, turn, plannerTemplate);
  const value = (name: string) =>
    JSON.parse(prompt.variables.find((v) => v.name === name)!.content);
  return { prompt, value };
}

it("connects same-named speakers and frozen input quotes without conflating their identity", () => {
  const { turn, atoms } = fixture(["去看木星吗？", "我还没说完"]);
  const payload = turn.payload as any;
  const current = {
    ...turn,
    payload: {
      ...payload,
      focusActive: true,
      inputs: payload.inputs.map((input: any) => ({
        ...input,
        source: {
          ...input.source,
          sender: { userId: input.source.senderId, nickname: "同名" },
          mentions: [{ kind: "user", id: "bot-1" }],
        },
      })),
    },
  };
  const { value } = compiledView(atoms, current);
  const view = value("turn");
  expect(view.inputs.map((i: any) => i.speaker)).toEqual(["同名", "同名"]);
  expect(view.inputs.map((i: any) => i.speakerKey)).toEqual([
    "speaker:sender-0",
    "speaker:sender-1",
  ]);
  expect(view.inputs[0]).toMatchObject({
    mentionedSelf: true,
    platformMessageId: "platform-0",
  });
  expect(view.inputs[1].quotedMessage).toMatchObject({
    status: "resolved",
    text: "去看木星吗？",
    sourceInformationId: "input-0",
  });
  expect(view.observation).toMatchObject({ isGroup: true, focusActive: true });
  expect(view.availableActions).toEqual(["message", "silent"]);
  expect(view.remainingWaits).toBe(0);
});

it.each(["delivered", "missing", "conflict", "foreign"])(
  "renders a quoted assistant only through its verified delivery chain: %s",
  (state) => {
    const { turn } = fixture(["继续讲讲"]);
    const payload = turn.payload as any;
    const target = {
      platform: "qq",
      adapterId: "adapter",
      destination: { kind: "group", groupId: "group-1" },
    };
    const assistant = atom("assistant", "core.message.assistant.text", {
      text: "木星的大红斑",
      source: target,
      originatingModuleInstanceId: "composer",
      turn: null,
    });
    const request = atom(
      "request",
      "core.delivery.requested",
      {
        ...target,
        message: { kind: "text", text: "木星的大红斑" },
        turn: null,
      },
      [{ relation: "core:caused-by", informationId: "assistant" }],
    );
    const receipt = atom(
      "receipt",
      "core.delivery.delivered",
      {
        ok: true,
        platform: "qq",
        adapterId: "adapter",
        target:
          state === "foreign"
            ? { kind: "group", groupId: "other" }
            : target.destination,
        platformMessageId: "sent",
      },
      [{ relation: "core:status-of", informationId: "request" }],
    );
    const current = {
      ...turn,
      payload: {
        ...payload,
        inputs: payload.inputs.map((i: any) => ({
          ...i,
          source: {
            ...i.source,
            replyTo: { platformMessageId: "sent", senderId: "bot-1" },
          },
        })),
      },
    };
    const evidence = [
      assistant,
      request,
      ...(state === "missing" ? [] : [receipt]),
      ...(state === "conflict"
        ? [
            {
              ...receipt,
              informationId: "receipt-2" as typeof receipt.informationId,
            },
          ]
        : []),
    ];
    const { prompt, value } = compiledView([current, ...evidence], current);
    expect(value("turn").inputs[0].repliedToSelf).toBe(true);
    expect(value("turn").inputs[0].quotedMessage).toMatchObject(
      state === "delivered"
        ? { status: "resolved", text: "木星的大红斑", speakerKey: "self" }
        : { status: "unavailable" },
    );
    expect(
      prompt.variables.find((v) => v.name === "turn")!.informationIds,
    ).toEqual(
      state === "delivered"
        ? [turn.informationId, "receipt", "request", "assistant"]
        : [turn.informationId],
    );
  },
);

it("bounds manual evidence and history while preserving full current input and provenance", () => {
  const { turn, atoms } = fixture(["全文".repeat(7000)]);
  const memory = atom("manual", "agent.user.statement", {
    text: "🌟".repeat(6000),
    sourceType: "character_setting",
    originalSourceInformationId: "original",
  });
  const history = atom("past", inboundTextInformationKind.kind, {
    text: "🌕".repeat(15000),
    source: { ...(turn.payload as any).source, platformMessageId: "past" },
  });
  const current = {
    ...turn,
    payload: { ...turn.payload, memory: [memory.informationId] },
  };
  const { value } = compiledView([...atoms, memory, history], current);
  expect(Array.from(value("memory")[0].text)).toHaveLength(4000);
  expect(value("memory")[0]).toMatchObject({
    sourceType: "character_setting",
    originalSourceInformationId: "original",
    sourceInformationId: "manual",
  });
  expect(Array.from(value("history")[0].text)).toHaveLength(12000);
  expect(value("turn").inputs[0].text).toHaveLength(14000);
});

it("keeps recent context and later interest evidence visible beside long sources", () => {
  const { turn, atoms } = fixture(["当前输入"]);
  const old = atom("old", inboundTextInformationKind.kind, {
    text: "旧".repeat(12000),
    source: { ...(turn.payload as any).source, platformMessageId: "old" },
  });
  const recent = {
    ...atom("recent", inboundTextInformationKind.kind, {
      text: "最近明确提出的新问题",
      source: { ...(turn.payload as any).source, platformMessageId: "recent" },
    }),
    occurredAt: new Date(Date.parse(old.occurredAt) + 1).toISOString(),
  };
  const long = atom("long", "agent.user.statement", {
    text: "长".repeat(6000),
  });
  const interest = atom("interest", "agent.user.statement", {
    text: "Kaguya 喜欢天文",
    sourceType: "character_setting",
  });
  const current = {
    ...turn,
    payload: {
      ...turn.payload,
      memory: [long.informationId, interest.informationId],
    },
  };
  const { value } = compiledView(
    [...atoms, old, recent, long, interest],
    current,
  );
  expect(value("history").at(-1)).toMatchObject({
    text: "最近明确提出的新问题",
    truncated: false,
  });
  expect(value("history")[0].truncated).toBe(true);
  expect(
    value("history").reduce(
      (sum: number, item: any) => sum + Array.from(item.text).length,
      0,
    ),
  ).toBe(12000);
  expect(value("memory")[0]).toMatchObject({ truncated: true });
  expect(value("memory")[1]).toMatchObject({
    text: "Kaguya 喜欢天文",
    truncated: false,
  });
});

it("rejects exhausted waits and out-of-range focus before model task completion", () => {
  const available = plannerActionSchemaForTurn({
    inputs: [{}],
    attempt: 0,
    totalWaitBudget: 1,
  });
  const exhausted = plannerActionSchemaForTurn({
    inputs: [{}],
    attempt: 1,
    totalWaitBudget: 1,
  });
  const wait = { action: "wait", reason: "await-more-context", waitSeconds: 5 };
  expect(available.safeParse(wait).success).toBe(true);
  expect(exhausted.safeParse(wait).success).toBe(false);
  const message = {
    action: "message",
    reason: "respond",
    composition: { focusInputIndexes: [1], topic: "topic", replyAct: "answer" },
  };
  expect(available.safeParse(message).success).toBe(false);
  expect(
    exhausted.safeParse({
      ...message,
      composition: { ...message.composition, focusInputIndexes: [0] },
    }).success,
  ).toBe(true);
});
