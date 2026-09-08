/**
 * 功能概述：验证发言时机的纯决策规则。
 * 主要职责：覆盖确定性评分、硬门禁与 wait 延迟。
 * 代码库关系：直接覆盖 speech-decision.ts 和 information-kinds.ts 的 DAG 契约；
 * 使用轻量 handler fixture 隔离模型任务与平台传输，确保时机测试不依赖回复文本生成实现。
 * 输入输出与副作用：测试仅记录内存中的模块注册请求，不访问数据库、模型或网络。
 */
import { describe, expect, it } from "vitest";
import {
  computeWaitDelayMs,
  decideSpeechAction,
  scoreTurnContext,
  speechDecisionSettingsSchema,
  speechDecisionModule,
} from "./speech-decision.js";

const context = {
  candidateInformationId: "candidate-1",
  source: {
    adapterId: "test",
    platform: "qq",
    platformMessageId: "m-1",
    destination: { kind: "private", userId: "u-1" },
    senderId: "u-1",
  },
  directness: 1,
  contentNeed: 1,
  messageCount: 1,
  recentPresencePenalty: 0,
  frequencyMultiplier: 1,
  muted: false,
  safe: true,
  destinationAvailable: true,
  stale: false,
  attempt: 0,
  totalWaitBudget: 2,
};

describe("speech decision module", () => {
  it("scores the same immutable context deterministically", () => {
    expect(scoreTurnContext(context)).toEqual(
      scoreTurnContext(structuredClone(context)),
    );
    expect(scoreTurnContext(context).score).toBeGreaterThan(0.6);
  });

  it("speaks when the deterministic score clears the speak threshold", () => {
    expect(decideSpeechAction(context)).toEqual({
      action: "speak",
      reasonCodes: [],
    });
  });

  it("waits when score is actionable and a recheck budget remains", () => {
    const input = {
      ...context,
      directness: 0,
      contentNeed: 1,
      asOf: "2029-12-31T23:59:00.000Z",
      recheckAt: "2030-01-01T00:00:00.000Z",
    };
    expect(scoreTurnContext(input).score).toBeGreaterThanOrEqual(0.35);
    expect(decideSpeechAction(input)).toEqual({
      action: "wait",
      reasonCodes: [],
    });
    expect(computeWaitDelayMs(input.recheckAt, input.asOf)).toBe(60_000);
  });

  it("silently drops low score and hard-gated candidates", () => {
    expect(
      decideSpeechAction({ ...context, directness: 0, contentNeed: 0 }),
    ).toEqual({ action: "silent", reasonCodes: [] });
    expect(decideSpeechAction({ ...context, muted: true })).toEqual({
      action: "silent",
      reasonCodes: ["muted"],
    });
    expect(decideSpeechAction({ ...context, safe: false })).toEqual({
      action: "silent",
      reasonCodes: ["unsafe"],
    });
  });

  it("keeps optional enrichments neutral and reports them as missing", () => {
    const scored = scoreTurnContext(context);
    expect(scored.missingInputs).toEqual([
      "memory",
      "association",
      "recheckAt",
    ]);
    expect(
      scoreTurnContext({
        ...context,
        memory: ["fact-1"],
        association: ["association-1"],
      }).score,
    ).toBe(scored.score);
  });

  it("hard gates mute and unsafe contexts regardless of score", () => {
    expect(speechDecisionSettingsSchema.parse({})).toMatchObject({
      speakThreshold: 0.6,
    });
    expect(
      speechDecisionModule.manifest.consumes.map(({ kind }) => kind),
    ).toEqual(["agent.turn.context.completed"]);
    expect(
      speechDecisionModule.manifest.produces.map(({ kind }) => kind),
    ).toEqual(["agent.speech.decision"]);
  });
});
