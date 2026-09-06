import { describe, expect, it } from "vitest";
import { scoreTurnContext, speechDecisionSettingsSchema, speechDecisionModule } from "./speech-decision.js";

const context = {
  candidateInformationId: "candidate-1",
  source: { adapterId: "test", platform: "qq", platformMessageId: "m-1", destination: { kind: "private", userId: "u-1" }, senderId: "u-1" },
  directness: 1, contentNeed: 1, messageCount: 1, recentPresencePenalty: 0, frequencyMultiplier: 1,
  muted: false, safe: true, destinationAvailable: true, stale: false, attempt: 0, totalWaitBudget: 2,
};

describe("speech decision module", () => {
  it("scores the same immutable context deterministically", () => {
    expect(scoreTurnContext(context)).toEqual(scoreTurnContext(structuredClone(context)));
    expect(scoreTurnContext(context).score).toBeGreaterThan(0.6);
  });

  it("hard gates mute and unsafe contexts regardless of score", () => {
    expect(speechDecisionSettingsSchema.parse({})).toMatchObject({ speakThreshold: 0.6 });
    expect(speechDecisionModule.manifest.consumes.map(({ kind }) => kind)).toEqual(["agent.turn.context.completed"]);
    expect(speechDecisionModule.manifest.produces.map(({ kind }) => kind)).toEqual(["agent.speech.decision", "agent.wait.requested"]);
  });
});
