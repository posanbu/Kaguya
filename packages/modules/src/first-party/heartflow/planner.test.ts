/**
 * 功能概述：验证 Planner 的严格结构边界与真实 Prompt 编译，不调用外部模型。
 * 测试覆盖动作原因配对、等待整数范围、额外正文/目标拒绝，以及全部冻结输入和身份溯源。
 * 与 index.test.ts 的持久化分派测试及 Runtime 双阶段集成互补，防止模型越权构造投递参数。
 */
import { describe, expect, it } from "vitest";
import { compilePlannerPrompt, plannerActionSchema } from "./planner.js";
import { atom, fixture, identity } from "../message-composer/test-fixtures.js";

describe("Planner contract", () => {
  it.each([
    { action: "message", reason: "respond", text: "forbidden" },
    { action: "message", reason: "respond", adapterId: "qq" },
    { action: "message", reason: "respond", userId: "123" },
    { action: "message", reason: "respond", destination: {} },
    { action: "message", reason: "respond", replyTo: "turn-input-0" },
    { action: "message", reason: "respond", replyTo: "platform-1" },
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
  it("accepts an optional frozen-input reply reference", () => {
    expect(
      plannerActionSchema.parse({
        action: "message",
        reason: "respond",
        replyTo: "turn-input-2",
      }),
    ).toMatchObject({ replyTo: "turn-input-2", target: { kind: "current" } });
  });
  it("compiles identity, policy and every frozen input with provenance", () => {
    const { atoms } = fixture(["FIRST_SENTINEL", "LAST_SENTINEL"]);
    const turn = atoms.find(
      (atom) => atom.kind === "agent.turn.context.completed",
    )!;
    const prompt = compilePlannerPrompt(identity, atoms, turn);
    expect(prompt.text).toContain(identity.persona);
    expect(prompt.text).toContain("FIRST_SENTINEL");
    expect(prompt.text).toContain("LAST_SENTINEL");
    expect(prompt.text).toContain("turn-input-1");
    expect(prompt.text).toContain('"processedAt":"2026-09-09T00:00:02.000Z"');
    expect(prompt.text).toContain('"selectedCount":2');
    expect(prompt.text).toContain("不可信数据");
    expect(
      prompt.variables.find((v) => v.name === "turn")?.informationIds,
    ).toEqual([turn.informationId]);
    expect(prompt.text).not.toContain("group-1");
    expect(prompt.text).not.toContain("platform-0");
  });
  it("derives backlog and stable input references when replaying legacy v1 context", () => {
    const f = fixture(["LEGACY"]);
    const payload = structuredClone(f.turn.payload) as any;
    delete payload.backlog;
    delete payload.inputs[0].inputRef;
    payload.stale = true;
    const legacyTurn = atom(
      "legacy-turn",
      "agent.turn.context.completed",
      payload,
    );
    const prompt = compilePlannerPrompt(identity, f.atoms, legacyTurn);
    expect(prompt.text).toContain('"isBacklog":true');
    expect(prompt.text).toContain('"inputRef":"turn-input-1"');
  });
});
