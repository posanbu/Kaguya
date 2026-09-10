import { describe, expect, it } from "vitest";

import {
  attentionArousalModule,
  decideAttentionArousal,
  scoreAttentionArousal,
} from "./index.js";

const base = {
  candidateInformationId: "candidate-1",
  claimInformationId: "claim-1",
  scopeKey: "qq:test:group:g1",
  asOf: "2026-09-10T00:00:00.000Z",
  inputs: [
    {
      informationId: "in-1",
      occurredAt: "2026-09-10T00:00:00.000Z",
      text: "你好",
      source: {
        adapterId: "test",
        platform: "qq",
        platformMessageId: "m1",
        destination: { kind: "group", groupId: "g1" },
        senderId: "u1",
      },
      identity: {
        terminalInformationId: "identity-1",
        status: "complete",
        scopeMode: "canonical",
      },
    },
  ],
  text: "你好",
  source: {
    adapterId: "test",
    platform: "qq",
    platformMessageId: "m1",
    destination: { kind: "group", groupId: "g1" },
    senderId: "u1",
  },
  messageCount: 1,
  isPrivate: false,
  isGroup: true,
  mentionedSelf: false,
  repliedToSelf: false,
  namedSelf: false,
  recentSelfReplies: 0,
  recentWindowMessages: 1,
  idleReachedAverage: false,
  frequency: 1,
  muted: false,
  safe: true,
  destinationAvailable: true,
  stale: false,
  attempt: 0,
  totalWaitBudget: 3,
};

describe("attention arousal", () => {
  it("defers an ordinary single group event", () => {
    expect(scoreAttentionArousal(base).score).toBe(50);
    expect(decideAttentionArousal(base).outcome).toBe("defer");
  });

  it("attends combined question and request content", () => {
    const input = {
      ...base,
      text: "能不能帮我看看这个要怎么做？",
      inputs: [{ ...base.inputs[0], text: "能不能帮我看看这个要怎么做？" }],
    };
    expect(scoreAttentionArousal(input).score).toBeGreaterThanOrEqual(80);
    expect(decideAttentionArousal(input).outcome).toBe("attend");
  });

  it("keeps short reactions low and applies presence penalty", () => {
    const short = {
      ...base,
      text: "哈哈",
      inputs: [{ ...base.inputs[0], text: "哈哈" }],
    };
    expect(scoreAttentionArousal(short).score).toBe(25);
    expect(
      scoreAttentionArousal({
        ...base,
        recentSelfReplies: 4,
        recentWindowMessages: 10,
      }).components.recentPresencePenalty,
    ).toBe(11);
  });

  it("attends private and direct events after hard gates", () => {
    expect(
      decideAttentionArousal({ ...base, isPrivate: true, isGroup: false })
        .outcome,
    ).toBe("attend");
    expect(
      decideAttentionArousal({ ...base, mentionedSelf: true }).outcome,
    ).toBe("attend");
    expect(
      decideAttentionArousal({ ...base, mentionedSelf: true, muted: true }),
    ).toEqual({ outcome: "ignore", reasonCodes: ["muted"] });
    expect(
      decideAttentionArousal({ ...base, repliedToSelf: true }).outcome,
    ).toBe("attend");
    expect(decideAttentionArousal({ ...base, namedSelf: true }).outcome).toBe(
      "attend",
    );
  });

  it("freezes idle pressure and frequency into the score", () => {
    const lowFrequency = scoreAttentionArousal({ ...base, frequency: 0.5 });
    const idle = scoreAttentionArousal({
      ...base,
      frequency: 0.5,
      idleReachedAverage: true,
    });
    expect(lowFrequency.score).toBeLessThan(scoreAttentionArousal(base).score);
    expect(idle.components.pressure).toBeGreaterThan(
      lowFrequency.components.pressure,
    );
    expect(decideAttentionArousal({ ...base, frequency: 0 })).toEqual({
      outcome: "ignore",
      reasonCodes: ["frequency-zero"],
    });
  });

  it("ignores after the durable wait budget is exhausted", () => {
    expect(decideAttentionArousal({ ...base, attempt: 3 }).outcome).toBe(
      "ignore",
    );
  });

  it("publishes only the attention completion kind", () => {
    expect(attentionArousalModule.manifest.protocolVersion).toBe(1);
    expect(
      attentionArousalModule.manifest.produces.map(({ kind }) => kind),
    ).toEqual(["agent.attention.arousal.completed"]);
  });
});
