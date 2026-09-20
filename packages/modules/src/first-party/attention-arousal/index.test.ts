/**
 * 功能概述：验证注意力纯评分和硬门禁，覆盖 Focus 配置、四项实际计算证据及旧完成载荷兼容。
 * 主要职责：边界表锁定内容、压力和在场分数；断言证据步骤与数值一致，handler 将原始计算证据提交给唯一终态。
 * 代码库关系：直接调用 index.ts 与 turn.ts 的完成 schema，commitTerminal 是内存 spy；无数据库、模型或平台副作用。
 * 输入输出与副作用：固定冻结输入，不重算历史；唯一异步测试直接 await handler 完成，不轮询、不依赖计时器。
 */
import { describe, expect, it, vi } from "vitest";
import { freezeInformationAtom } from "@kaguya/schema";
import type { InformationModuleHandlerContext } from "@kaguya/sdk";

import {
  attentionArousalModule,
  attentionArousalSettingsSchema,
  decideAttentionArousal,
  scoreAttentionArousal,
} from "./index.js";
import {
  attentionArousalCompletedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";

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

const withTexts = (texts: string[]) => ({
  ...base,
  inputs: texts.map((text, index) => ({
    ...base.inputs[0],
    informationId: `input-${index}`,
    text,
  })),
});
const evidencePart = (
  score: ReturnType<typeof scoreAttentionArousal>,
  id: string,
) => {
  const part = score.scoreEvidence.parts.find((item) => item.id === id);
  if (!part) throw new Error(`Missing score evidence: ${id}`);
  return part;
};

describe("persisted scoring evidence", () => {
  it("records cleaned short reactions and preserves the exact -25 contribution", () => {
    const scored = scoreAttentionArousal(
      withTexts(["[reply:old] @辉夜 嗯", "[image:photo]", "哈哈"]),
    );
    const content = evidencePart(scored, "content");
    expect(content.value).toBe(-25);
    expect(content.steps).toEqual([
      { label: "所有非空输入均为不超过 8 字符的指定短反应", delta: -25 },
    ]);
    expect(content.facts).toEqual(
      expect.arrayContaining([
        { label: "清理后合并文本", value: "嗯\n哈哈" },
        { label: "清理后非空输入数", value: 2 },
        { label: "指定短反应匹配词", value: "嗯、哈哈" },
      ]),
    );
    expect(scored.score).toBe(25);
    const empty = evidencePart(
      scoreAttentionArousal(withTexts(["[voice:clip]"])),
      "content",
    );
    expect(empty.steps).toEqual([{ label: "清理后没有非空输入", delta: -25 }]);
    expect(empty.facts).toContainEqual({ label: "清理后非空输入数", value: 0 });
  });

  it("records exact request keywords and every applicable content category once", () => {
    const text = "能不能帮我看看你觉得这件事怎么处理？" + "甲".repeat(120);
    const scored = scoreAttentionArousal(withTexts([text]));
    const content = evidencePart(scored, "content");
    expect(content.value).toBe(70);
    expect(content.steps.map(({ delta }) => delta)).toEqual([
      15, 20, 20, 5, 10,
    ]);
    expect(content.steps).toContainEqual({
      label: "请求：命中「帮我、能不能」（本批计一次）",
      delta: 20,
    });
    expect(content.facts).toEqual(
      expect.arrayContaining([
        { label: "显式请求关键词", value: "帮我、能不能" },
        { label: "弱请求关键词", value: "看看" },
        { label: "合并后字符数（含换行）", value: Array.from(text).length },
        { label: "疑问规则实际命中", value: "疑问词「怎么」" },
        { label: "征求意见实际命中", value: "你觉得" },
      ]),
    );
    expect(scored.reasonCodes).toEqual([
      "question",
      "request",
      "opinion",
      "long-text",
      "very-long-text",
    ]);
    expect(scoreAttentionArousal(withTexts(["看看"])).components.content).toBe(
      0,
    );
    const direct = scoreAttentionArousal({
      ...withTexts(["看看"]),
      namedSelf: true,
    });
    expect(direct.components.content).toBe(20);
    expect(evidencePart(direct, "content").steps).toContainEqual({
      label: "请求：命中「看看」（本批计一次）",
      delta: 20,
    });
    expect(evidencePart(direct, "content").facts).toContainEqual({
      label: "本次允许弱请求加分（直接指向或私聊）",
      value: true,
    });
    expect(
      scoreAttentionArousal({ ...withTexts(["看看"]), focusActive: true })
        .components.content,
    ).toBe(0);
  });

  it.each([
    ["什么", true],
    ["这什么", false],
    ["那什么", false],
    ["没什么", false],
    ["这是什么", true],
    ["你好吗", false],
    ["你还好吗", true],
    ["甲".repeat(79) + "吗", true],
    ["甲".repeat(80) + "吗", false],
    ["甲".repeat(80) + "吗?", true],
    ["你还好吗。", true],
    ["你还好吗，", false],
    ["ab?", false],
    ["abc?", true],
    ["甲".repeat(119) + "?", true],
    ["甲".repeat(120) + "?", false],
    ["abc?！def", true],
    ["abc?def", false],
    ["甲".repeat(121) + "如何", true],
  ])("preserves question branch %s", (text, expected) => {
    const scored = scoreAttentionArousal(withTexts([String(text)]));
    expect(scored.reasonCodes.includes("question")).toBe(expected);
    expect(
      evidencePart(scored, "content").steps.some(({ delta }) => delta === 15),
    ).toBe(expected);
  });

  it.each([
    [39, 0],
    [40, 5],
    [119, 5],
    [120, 15],
  ])("preserves Unicode length boundary %i", (length, expected) => {
    expect(
      scoreAttentionArousal(withTexts(["😀".repeat(length)])).components
        .content,
    ).toBe(expected);
  });
  it("keeps batch newlines and allows long-text rewards alongside short-reaction deductions", () => {
    const scored = scoreAttentionArousal(
      withTexts(Array.from({ length: 41 }, () => "哈哈")),
    );
    const content = evidencePart(scored, "content");
    expect(content.value).toBe(-10);
    expect(content.steps.map(({ delta }) => delta)).toEqual([5, 10, -25]);
    expect(content.facts).toContainEqual({
      label: "合并后字符数（含换行）",
      value: 122,
    });
    const long = evidencePart(
      scoreAttentionArousal(withTexts(["甲".repeat(800)])),
      "content",
    );
    expect(long.facts).toContainEqual({ label: "文本摘录已截断", value: true });
    expect(long.facts).toContainEqual({
      label: "合并后字符数（含换行）",
      value: 800,
    });
    expect(
      String(long.facts.find(({ label }) => label === "清理后合并文本")!.value)
        .length,
    ).toBeLessThan(400);
  });

  it("records the first relevance branch and the actual configured focus value", () => {
    const direct = evidencePart(
      scoreAttentionArousal(
        {
          ...base,
          mentionedSelf: true,
          repliedToSelf: true,
          focusActive: true,
        },
        17,
      ),
      "relevance",
    );
    expect(direct.value).toBe(100);
    expect(direct.steps).toEqual([
      { label: "被 @，采用首个命中项", delta: 100 },
    ]);
    const focus = evidencePart(
      scoreAttentionArousal({ ...base, focusActive: true }, 17),
      "relevance",
    );
    expect(focus.value).toBe(17);
    expect(focus.facts).toContainEqual({
      label: "本次 focusRelevance 配置",
      value: 17,
    });
  });

  it.each([
    [0, false, 0, 0],
    [0, true, 15, 11],
    [1, false, 3, 2],
    [1, true, 18, 14],
    [2, false, 13, 10],
    [3, true, 43, 32],
    [4, false, 50, 38],
    [4, true, 50, 38],
    [5, false, 57, 43],
    [5, true, 57, 43],
    [8, true, 72, 54],
    [20, false, 100, 75],
  ])(
    "preserves pressure for count=%i idle=%s",
    (count, idle, pressure, score) => {
      const scored = scoreAttentionArousal({
        ...base,
        frequency: 0.5,
        messageCount: count,
        idleReachedAverage: idle,
      });
      expect(scored.components.pressure).toBe(pressure);
      expect(scored.score).toBe(score);
      const evidence = evidencePart(scored, "pressure");
      expect(evidence.value).toBe(pressure);
      expect(evidence.steps.reduce((sum, { delta }) => sum + delta, 0)).toBe(
        pressure,
      );
      expect(evidence.facts).toContainEqual({
        label: "触发量 T = ceil(1 / f²)",
        value: 4,
      });
    },
  );

  it.each([
    [25, 100, 0],
    [251, 1000, 0],
    [26, 100, 1],
    [4, 10, 11],
    [59, 100, 24],
    [6, 10, 25],
    [12, 10, 25],
    [0, 10, 0],
    [1, 0, 0],
  ])(
    "records signed presence contribution for %i/%i",
    (replies, total, penalty) => {
      const scored = scoreAttentionArousal({
        ...base,
        recentSelfReplies: replies,
        recentWindowMessages: total,
      });
      expect(scored.components.recentPresencePenalty).toBe(penalty);
      const evidence = evidencePart(scored, "recentPresencePenalty");
      expect(evidence.value).toBe(penalty ? -penalty : 0);
      expect(evidence.steps[0]!.delta).toBe(evidence.value);
      expect(evidence.facts).toContainEqual({
        label: "实际扣分",
        value: penalty,
      });
    },
  );

  it("serializes frequency-zero evidence without Infinity and accepts legacy completion payloads", () => {
    const scored = scoreAttentionArousal({
      ...base,
      frequency: 0,
      idleReachedAverage: true,
    });
    expect(scored.score).toBe(8);
    expect(evidencePart(scored, "pressure").facts).toContainEqual({
      label: "触发量 T = ceil(1 / f²)",
      value: "∞（频率为零，不写入非有限数字）",
    });
    const payload = {
      outcome: "ignore",
      text: base.text,
      source: base.source,
      candidateInformationId: base.candidateInformationId,
      claimInformationId: base.claimInformationId,
      turnContextInformationId: "context-1",
      score: scored.score,
      threshold: 80,
      components: scored.components,
      reasonCodes: ["frequency-zero"],
      missingInputs: [],
      policyDigest: "test-policy",
      settingsDigest: "test-settings",
      attempt: 0,
      totalWaitBudget: 3,
    };
    const schema = attentionArousalCompletedInformationKind.payloadSchema;
    expect(schema.parse(payload)).not.toHaveProperty("scoreEvidence");
    const parsed = schema.parse(
      JSON.parse(
        JSON.stringify({ ...payload, scoreEvidence: scored.scoreEvidence }),
      ),
    );
    expect(parsed.scoreEvidence).toEqual(scored.scoreEvidence);
    const invalid = structuredClone(scored.scoreEvidence);
    invalid.parts[0]!.value = Number.POSITIVE_INFINITY;
    expect(() =>
      schema.parse({ ...payload, scoreEvidence: invalid }),
    ).toThrow();
    for (const part of scored.scoreEvidence.parts)
      expect(part.steps.reduce((sum, { delta }) => sum + delta, 0)).toBe(
        part.value,
      );
  });

  it("commits evidence from the actual calculation even when a hard gate overrides the score", async () => {
    const payload = turnContextCompletedInformationKind.payloadSchema.parse({
      ...withTexts(["能不能帮我看看怎么做？"]),
      muted: true,
      focusActive: true,
      backlog: {
        isBacklog: false,
        evaluatedAt: base.asOf,
        oldestInputAgeMs: 0,
        newestInputAgeMs: 0,
        thresholdMs: 300_000,
      },
    });
    const atom = freezeInformationAtom({
      informationId: "context-evidence",
      kind: turnContextCompletedInformationKind.kind,
      source: "test:arousal",
      occurredAt: base.asOf,
      payload,
      references: [],
    });
    const lifecycle = {
      signal: new AbortController().signal,
      now: () => new Date(base.asOf),
      report: async () => undefined,
      use: () => {
        throw new Error("Unexpected capability");
      },
    };
    const settings = attentionArousalSettingsSchema.parse({
      focusRelevance: 17,
      threshold: 80,
      deferMs: 15000,
      policyDigest: "test-policy",
      settingsDigest: "test-settings",
    });
    const instance = await attentionArousalModule.create(
      {
        instanceId: "arousal-test",
        settings,
        activation: {
          instanceId: "arousal-test",
          definitionId: attentionArousalModule.manifest.definitionId,
        },
      },
      lifecycle,
    );
    const commitTerminal = vi
      .fn<
        (
          group: string,
          subject: string,
          definition: unknown,
          input: { payload: unknown },
        ) => Promise<typeof atom>
      >()
      .mockResolvedValue(atom);
    const context: InformationModuleHandlerContext = {
      ...lifecycle,
      definitionId: attentionArousalModule.manifest.definitionId,
      instanceId: "arousal-test",
      sourceAtom: atom,
      commitTerminal,
      select: async () => {
        throw new Error("Unexpected select");
      },
      register: async () => {
        throw new Error("Unexpected register");
      },
      registerOnce: async () => {
        throw new Error("Unexpected registerOnce");
      },
    };
    await instance.subscriptions[0]!.handle(atom, context);
    expect(commitTerminal).toHaveBeenCalledTimes(1);
    const call = commitTerminal.mock.calls[0]!;
    expect(call[0]).toBe("agent.turn.decision");
    expect(call[1]).toBe(base.claimInformationId);
    const saved = attentionArousalCompletedInformationKind.payloadSchema.parse(
      call[3].payload,
    );
    expect(saved.outcome).toBe("ignore");
    expect(saved.reasonCodes).toEqual(["muted"]);
    const scored = scoreAttentionArousal(payload, 17);
    expect(saved.scoreEvidence).toEqual(scored.scoreEvidence);
    expect(saved.components).toEqual(scored.components);
    expect(saved.score).toBe(scored.score);
    expect(scored.reasonCodes).toEqual(["question", "request"]);
  });
});

describe("focus relevance", () => {
  it("uses MaiBot's 40-point focus relevance for short reactions", () => {
    const input = {
      ...base,
      focusActive: true,
      inputs: [{ ...base.inputs[0], text: "哈哈" }],
    };
    expect(scoreAttentionArousal(input).score).toBe(65);
    expect(decideAttentionArousal(input).outcome).toBe("defer");
  });
  it("can force a name mention without changing the default score path", () => {
    const input = { ...base, namedSelf: true, frequency: 0.2 };
    expect(decideAttentionArousal(input).outcome).toBe("defer");
    expect(decideAttentionArousal(input, 80, 40, true, true).outcome).toBe(
      "attend",
    );
  });
  it("boosts ordinary followups and permits disabling the boost", () => {
    expect(decideAttentionArousal({ ...base, focusActive: true }).outcome).toBe(
      "attend",
    );
    expect(
      decideAttentionArousal({ ...base, focusActive: true }, 80, 0).outcome,
    ).toBe("defer");
    expect(
      decideAttentionArousal({ ...base, focusActive: false }).outcome,
    ).toBe("defer");
  });
  it.each([
    { muted: true },
    { safe: false },
    { destinationAvailable: false },
    { frequency: 0 },
  ])("preserves hard gate %j", (gate) => {
    expect(
      decideAttentionArousal({ ...base, focusActive: true, ...gate }).outcome,
    ).toBe("ignore");
  });

  it("lets semantic attention evaluate stale input without weakening other hard gates", () => {
    expect(decideAttentionArousal({ ...base, stale: true }).outcome).toBe(
      "defer",
    );
    expect(
      decideAttentionArousal({ ...base, stale: true, isPrivate: true }).outcome,
    ).toBe("attend");
    expect(
      decideAttentionArousal({ ...base, stale: true, muted: true }),
    ).toEqual({ outcome: "ignore", reasonCodes: ["muted"] });
  });
});
