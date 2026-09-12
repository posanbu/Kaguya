/**
 * 功能概述：验证 Planner 的严格结构边界与真实 Prompt 编译，不调用外部模型。
 * 测试覆盖动作原因配对、等待整数范围、额外正文/目标拒绝，以及全部冻结输入和身份溯源。
 * 与 index.test.ts 的持久化分派测试及 Runtime 双阶段集成互补，防止模型越权构造投递参数。
 */
import { describe, expect, it } from "vitest";
import { compilePlannerPrompt, plannerActionSchema } from "./planner.js";
import { fixture, identity } from "../message-composer/test-fixtures.js";

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
  it("compiles identity, policy and every frozen input with provenance", () => {
    const { atoms } = fixture(["FIRST_SENTINEL", "LAST_SENTINEL"]);
    const turn = atoms.find(
      (atom) => atom.kind === "agent.turn.context.completed",
    )!;
    const prompt = compilePlannerPrompt(identity, atoms, turn);
    expect(prompt.text).toContain(identity.persona);
    expect(prompt.text).toContain("FIRST_SENTINEL");
    expect(prompt.text).toContain("LAST_SENTINEL");
    expect(prompt.text).toContain("不可信数据");
    expect(
      prompt.variables.find((v) => v.name === "turn")?.informationIds,
    ).toEqual([turn.informationId]);
    expect(prompt.text).not.toContain("group-1");
  });
});
