/**
 * 功能概述：验证 Planner 的严格结构边界与真实 Prompt 编译，不调用外部模型。
 * 测试覆盖动作原因配对、等待整数范围、额外正文/目标拒绝，以及全部冻结输入和身份溯源。
 * 与 index.test.ts 的持久化分派测试及 Runtime 双阶段集成互补，防止模型越权构造投递参数。
 */
import { describe, expect, it } from "vitest";
import { compilePlannerPrompt, plannerActionSchema } from "./planner.js";
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
    const prompt = compilePlannerPrompt(identity, testAtoms, turn);
    expect(prompt.text).toContain(identity.persona);
    expect(prompt.variables.find((v) => v.name === "identity")?.content).toBe(
      `名字：${identity.name}\n别名：${identity.aliases.join("、")}\n时区：${identity.timeZone}\n人设：\n${identity.persona}`,
    );
    expect(prompt.text).toContain("FIRST_SENTINEL");
    expect(prompt.text).toContain("LAST_SENTINEL");
    expect(prompt.text).toContain("不可信数据");
    expect(prompt.text).toContain('"isBacklog":true');
    expect(prompt.text).toContain('"newestInputAgeMs":180000');
    expect(prompt.text).toContain(
      '当前时间：{"iso":"2026-09-15T00:00:00.000Z","timeZone":"Asia/Shanghai","local":"2026-09-15 周二 08:00:00"}',
    );
    expect(prompt.text).toContain('"inputIndex":0');
    expect(prompt.text).toContain('"localTime":"2026-09-09 周三 08:00:01"');
    expect(
      prompt.variables.find((v) => v.name === "turn")?.informationIds,
    ).toEqual([turn.informationId]);
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
    const prompt = compilePlannerPrompt(identity, [...atoms, history], turn);
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
    const prompt = compilePlannerPrompt(identity, atoms, turn);
    expect(prompt.text).toContain('"backlog":{"isBacklog":false');
    expect(prompt.text).toContain("LEGACY_INPUT");
  });
});
