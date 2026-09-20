/**
 * settings schema 的公开中文元数据供管理表单使用，运行时与保存共用约束。
 * 功能概述：判断冻结事件是否足以唤起 Agent 注意，不决定话题、回复或具体行动；积压时效由 Planner 语义判断。
 * 主要职责：执行不可绕过的硬门禁和 MaiBot 风格的确定性 0–100 显著性评分。
 * scoreAttentionArousal 在同一次计算中收集相关性、内容、压力和在场扣分的实际输入及步骤；scoreContent/scorePressure/
 * scorePresencePenalty 返回数值与对应 scoreEvidence，handler 将证据随完成事实提交，不改变既有分数或门控优先级。
 * evidenceExcerpt 仅限制保存的文本摘录，评分仍使用完整清理文本；证据不含非有限数字，旧历史无证据时由检查面如实降级。
 * 代码库关系：只消费 Heartflow 冻结的 turn context，并提交 claim 的唯一注意唤起终态；eligible 使用独立 attention 命名空间；非 eligible 直接提交廉价等待或静默决策。
 * 展示契约：Manifest 直接提供中文名称、摘要及输入输出职责，供 Inspection 与 WebUI 展示。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import { z } from "@kaguya/schema";
import { defineInformationModule, onInformation } from "@kaguya/sdk";

import {
  attentionArousalCompletedInformationKind,
  turnContextCompletedInformationKind,
  type TurnContextCompletedPayload,
} from "../information-kinds.js";
import type { AttentionArousalScoreEvidence } from "../kinds/turn.js";

type ScoreEvidencePart = AttentionArousalScoreEvidence["parts"][number];

const DIRECT_REQUEST_TERMS = ["帮我", "帮忙", "能不能", "可以吗", "要不要"];
const WEAK_REQUEST_TERMS = ["需要", "求", "看看", "试试"];
const QUESTION_TERMS = ["怎么", "如何", "为什么", "有没有"];
const OPINION_TERMS = ["你觉得", "你认为", "咋看", "有什么建议"];
const SHORT_REACTIONS = new Set([
  "哈哈",
  "哈哈哈",
  "草",
  "笑死",
  "好",
  "嗯",
  "啊",
  "哦",
  "6",
  "666",
  "？",
  "?",
]);

export const attentionArousalSettingsSchema = z
  .object({
    focusRelevance: z.number().min(0).max(100).default(40).meta({
      title: "持续关注相关性",
      description: "有效群聊关注租约的相关性分数，不绕过硬门禁。",
      public: true,
      default: 40,
    }),
    forceDirectReply: z.boolean().default(true).meta({
      title: "@及回复强制关注",
      description: "被 @ 或回复机器人时直接进入规划器，但规划器仍可选择静默。",
      public: true,
      default: true,
    }),
    forceNameReply: z.boolean().default(false).meta({
      title: "叫名强制关注",
      description:
        "普通文字提到机器人名字时直接进入规划器；关闭后仅增加相关性评分。",
      public: true,
      default: false,
    }),
    threshold: z.number().int().min(0).max(100).meta({
      title: "注意力阈值",
      description: "达到此分数后关注输入，范围为 0 到 100。",
      public: true,
      default: 80,
    }),
    deferMs: z.number().int().min(0).meta({
      title: "延迟关注时间",
      description: "延迟处理输入的时间，单位毫秒。",
      public: true,
      default: 15000,
    }),
    policyDigest: z.string().min(1).meta({
      title: "策略标识",
      description: "记录注意力策略版本的标识。",
      public: true,
      default: "attention-arousal:maibot-v1",
    }),
    settingsDigest: z.string().min(1).meta({
      title: "配置标识",
      description: "记录注意力设置版本的标识。",
      public: true,
      default: "attention-arousal:default-v1",
    }),
  })
  .strict();

export type AttentionArousalSettings = z.infer<
  typeof attentionArousalSettingsSchema
>;
export type AttentionArousalOutcome = "attend" | "defer" | "ignore";

export interface AttentionArousalScore {
  readonly score: number;
  readonly components: {
    readonly relevance: number;
    readonly content: number;
    readonly pressure: number;
    readonly recentPresencePenalty: number;
    readonly frequencyFactor: number;
    readonly preFrequencyScore: number;
  };
  readonly reasonCodes: string[];
  readonly scoreEvidence: AttentionArousalScoreEvidence;
}

export function scoreAttentionArousal(
  input: TurnContextCompletedPayload,
  focusRelevance = 40,
): AttentionArousalScore {
  const frequency = Math.min(1, Math.max(0, input.frequency));
  const triggerThreshold =
    frequency === 0 ? Number.POSITIVE_INFINITY : Math.ceil(1 / frequency ** 2);
  const direct = input.mentionedSelf || input.repliedToSelf || input.namedSelf;
  const relevanceResult = scoreRelevance(input, focusRelevance);
  const relevance = relevanceResult.value;
  const texts = input.inputs.map((item: { text: string }) =>
    stripNoise(item.text),
  );
  const contentResult = scoreContent(texts, direct || input.isPrivate);
  const pressureResult = scorePressure(
    input.messageCount,
    triggerThreshold,
    input.idleReachedAverage,
    frequency,
  );
  const presenceResult = scorePresencePenalty(
    input.recentSelfReplies,
    input.recentWindowMessages,
  );
  const pressure = pressureResult.value;
  const recentPresencePenalty = Math.abs(presenceResult.value);
  const preFrequencyScore =
    relevance + contentResult.score + pressure - recentPresencePenalty;
  const frequencyFactor = 0.5 + 0.5 * frequency;
  return {
    score: Math.max(
      0,
      Math.min(100, Math.round(preFrequencyScore * frequencyFactor)),
    ),
    components: {
      relevance,
      content: contentResult.score,
      pressure,
      recentPresencePenalty,
      frequencyFactor,
      preFrequencyScore,
    },
    reasonCodes: [...contentResult.reasonCodes],
    scoreEvidence: {
      version: 1,
      parts: [
        relevanceResult,
        contentResult.evidence,
        pressureResult,
        presenceResult,
      ],
    },
  };
}

export function decideAttentionArousal(
  input: TurnContextCompletedPayload,
  threshold = 80,
  focusRelevance = 40,
  forceDirectReply = true,
  forceNameReply = false,
): { outcome: AttentionArousalOutcome; reasonCodes: string[] } {
  const hardGates = [
    ...(input.muted ? ["muted"] : []),
    ...(!input.safe ? ["unsafe"] : []),
    ...(!input.destinationAvailable ? ["no-destination"] : []),
    ...(input.frequency <= 0 ? ["frequency-zero"] : []),
  ];
  if (hardGates.length > 0)
    return { outcome: "ignore", reasonCodes: hardGates };
  if (input.isPrivate)
    return { outcome: "attend", reasonCodes: ["private-conversation"] };
  if (
    (forceDirectReply && (input.mentionedSelf || input.repliedToSelf)) ||
    (forceNameReply && input.namedSelf)
  ) {
    return {
      outcome: "attend",
      reasonCodes: [
        ...(input.mentionedSelf ? ["mentioned-self"] : []),
        ...(input.repliedToSelf ? ["replied-to-self"] : []),
        ...(input.namedSelf ? ["named-self"] : []),
      ],
    };
  }
  if (scoreAttentionArousal(input, focusRelevance).score >= threshold)
    return { outcome: "attend", reasonCodes: ["score-threshold-met"] };
  if (input.attempt < input.totalWaitBudget)
    return { outcome: "defer", reasonCodes: ["score-below-threshold"] };
  return { outcome: "ignore", reasonCodes: ["wait-budget-exhausted"] };
}

export const attentionArousalModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.attention.arousal",
    inspection: firstPartyInspection["agent.attention.arousal"],
    displayName: "注意力唤醒",
    summary: "评估冻结回合是否值得关注、延后或忽略。",
    description:
      "消费已就绪的回合上下文，先检查安全与可用性，再计算显著性得分并输出原因；Heartflow 依据结果推进规划，本模块不调用模型或生成正文。",
    settingsSchema: attentionArousalSettingsSchema,
    consumes: [turnContextCompletedInformationKind],
    produces: [attentionArousalCompletedInformationKind],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: ({ settings }) => ({
    provisions: [],
    describeStartup: () => ({
      summary: "Attention arousal gate ready",
      fields: {
        threshold: settings.threshold,
        deferMs: settings.deferMs,
        policyDigest: settings.policyDigest,
      },
    }),
    subscriptions: [
      onInformation(
        turnContextCompletedInformationKind,
        {
          subscriptionId: "agent.attention.arousal.context",
          delivery: "durable",
        },
        async (atom, context) => {
          const input = atom.payload as TurnContextCompletedPayload;
          const scored = scoreAttentionArousal(input, settings.focusRelevance);
          const decision = decideAttentionArousal(
            input,
            settings.threshold,
            settings.focusRelevance,
            settings.forceDirectReply,
            settings.forceNameReply,
          );
          const dueAt = new Date(
            Date.parse(input.asOf) + settings.deferMs,
          ).toISOString();
          await context.commitTerminal(
            decision.outcome === "attend"
              ? "agent.turn.attention"
              : "agent.turn.decision",
            input.claimInformationId,
            attentionArousalCompletedInformationKind,
            {
              payload: {
                outcome: decision.outcome,
                text: input.text,
                source: input.source,
                candidateInformationId: input.candidateInformationId,
                claimInformationId: input.claimInformationId,
                turnContextInformationId: atom.informationId,
                score: scored.score,
                threshold: settings.threshold,
                components: scored.components,
                scoreEvidence: scored.scoreEvidence,
                reasonCodes: decision.reasonCodes,
                missingInputs: [],
                policyDigest: settings.policyDigest,
                settingsDigest: settings.settingsDigest,
                ...(decision.outcome === "defer"
                  ? {
                      dueAt,
                      delayMs: settings.deferMs,
                      wakePolicy: "recheckAt" as const,
                    }
                  : {}),
                attempt: input.attempt,
                totalWaitBudget: input.totalWaitBudget,
              },
              references: [
                {
                  relation: "core:uses-context",
                  informationId: atom.informationId,
                },
                {
                  relation: "agent:turn-claim",
                  informationId: input.claimInformationId,
                },
                {
                  relation: "core:status-of",
                  informationId: input.claimInformationId,
                },
              ],
            },
          );
        },
      ),
    ],
  }),
});

function stripNoise(text: string): string {
  return text
    .replace(/^\[reply:[^\]]+\]\s*/u, "")
    .replace(/@(?:all|\S+)/gu, "")
    .replace(/^\[(?:image|file|voice|face)[^\]]*\]\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function scoreRelevance(
  input: TurnContextCompletedPayload,
  focusRelevance: number,
): ScoreEvidencePart {
  const [label, value] = input.mentionedSelf
    ? (["被 @，采用首个命中项", 100] as const)
    : input.repliedToSelf
      ? (["回复机器人，采用首个命中项", 80] as const)
      : input.namedSelf
        ? (["称呼机器人，采用首个命中项", 80] as const)
        : input.isPrivate
          ? (["私聊，采用首个命中项", 40] as const)
          : input.focusActive
            ? (["有效关注，采用本次配置值", focusRelevance] as const)
            : (["未命中相关性条件", 0] as const);
  return {
    id: "relevance",
    value,
    facts: [
      { label: "被 @", value: input.mentionedSelf },
      { label: "回复机器人", value: input.repliedToSelf },
      { label: "称呼机器人", value: input.namedSelf },
      { label: "私聊", value: input.isPrivate },
      { label: "关注生效", value: input.focusActive ?? "未记录" },
      { label: "本次 focusRelevance 配置", value: focusRelevance },
    ],
    steps: [{ label, delta: value }],
    formula: "按 @、回复、称呼、私聊、有效关注的顺序取首个命中项，不叠加。",
  };
}

/** 摘录只用于保存证据；全部清理文本仍参与原有字符数与规则计算。 */
function evidenceExcerpt(text: string, limit = 360) {
  const characters = Array.from(text);
  return characters.length > limit
    ? `${characters.slice(0, limit).join("")}…（摘录已截断）`
    : text;
}

function scoreContent(texts: string[], direct: boolean) {
  const reasons: string[] = [];
  const steps: ScoreEvidencePart["steps"] = [];
  let score = 0;
  const nonBlank = texts.filter(Boolean);
  const combined = nonBlank.join("\n");
  const characters = Array.from(combined).length;
  const questionMatches = [...new Set(texts.flatMap(questionEvidence))];
  if (questionMatches.length) {
    score += 15;
    reasons.push("question");
    steps.push({
      label: `疑问：${evidenceExcerpt(questionMatches.join("、"), 72)}（本批计一次）`,
      delta: 15,
    });
  }
  const directRequestMatches = DIRECT_REQUEST_TERMS.filter((term) =>
    combined.includes(term),
  );
  const weakRequestMatches = WEAK_REQUEST_TERMS.filter((term) =>
    combined.includes(term),
  );
  if (directRequestMatches.length || (direct && weakRequestMatches.length)) {
    score += 20;
    reasons.push("request");
    const matches = [
      ...directRequestMatches,
      ...(direct ? weakRequestMatches : []),
    ];
    steps.push({
      label: `请求：命中「${matches.join("、")}」（本批计一次）`,
      delta: 20,
    });
  }
  const opinionMatches = OPINION_TERMS.filter((term) =>
    combined.includes(term),
  );
  const opinionPatternMatch = combined.match(
    /(?:你|Kaguya|辉夜).{0,6}怎么看|怎么看.{0,6}(?:你|Kaguya|辉夜)/iu,
  )?.[0];
  if (opinionMatches.length || opinionPatternMatch) {
    score += 20;
    reasons.push("opinion");
    const matches = [
      ...opinionMatches,
      ...(opinionPatternMatch ? [opinionPatternMatch] : []),
    ];
    steps.push({
      label: `征求意见：命中「${matches.join("、")}」（本批计一次）`,
      delta: 20,
    });
  }
  if (characters >= 40) {
    score += 5;
    reasons.push("long-text");
    steps.push({ label: `合并后 ${characters} 字符，达到 40`, delta: 5 });
  }
  if (characters >= 120) {
    score += 10;
    reasons.push("very-long-text");
    steps.push({
      label: `合并后 ${characters} 字符，达到 120，另加`,
      delta: 10,
    });
  }
  const allShort = nonBlank.every((text) => Array.from(text).length <= 8);
  const reactionMatches = [
    ...new Set(nonBlank.filter((text) => SHORT_REACTIONS.has(text))),
  ];
  if (
    nonBlank.length === 0 ||
    (allShort && nonBlank.every((text) => SHORT_REACTIONS.has(text)))
  ) {
    score -= 25;
    reasons.push("short-reaction");
    steps.push({
      label:
        nonBlank.length === 0
          ? "清理后没有非空输入"
          : "所有非空输入均为不超过 8 字符的指定短反应",
      delta: -25,
    });
  }
  if (!steps.length) steps.push({ label: "未命中内容加减分规则", delta: 0 });
  const evidence: ScoreEvidencePart = {
    id: "content",
    value: score,
    facts: [
      { label: "输入条数", value: texts.length },
      { label: "清理后非空输入数", value: nonBlank.length },
      { label: "清理后合并文本", value: evidenceExcerpt(combined) },
      { label: "文本摘录已截断", value: characters > 360 },
      { label: "合并后字符数（含换行）", value: characters },
      { label: "疑问规则实际命中", value: questionMatches.join("、") || "无" },
      {
        label: "显式请求关键词",
        value: directRequestMatches.join("、") || "无",
      },
      { label: "弱请求关键词", value: weakRequestMatches.join("、") || "无" },
      { label: "本次允许弱请求加分（直接指向或私聊）", value: direct },
      {
        label: "征求意见实际命中",
        value:
          [
            ...opinionMatches,
            ...(opinionPatternMatch ? [opinionPatternMatch] : []),
          ].join("、") || "无",
      },
      { label: "所有非空输入均不超过 8 字符", value: allShort },
      { label: "指定短反应匹配词", value: reactionMatches.join("、") || "无" },
    ],
    steps,
    formula: `${steps.map(({ delta }) => (delta < 0 ? `(${delta})` : String(delta))).join(" + ")} = ${score}`,
  };
  return { score, reasonCodes: reasons, evidence };
}

/** 按原 isQuestion 的短路顺序记录真正触发的首类规则；不能把后续未检查规则写成命中。 */
function questionEvidence(text: string): string[] {
  if (!text) return [];
  const terms = QUESTION_TERMS.filter((term) => text.includes(term));
  if (terms.length) return terms.map((term) => `疑问词「${term}」`);
  if (/(?<![这那没])什么/u.test(text))
    return ["疑问词「什么」（前一字非这、那、没）"];
  const length = Array.from(text).length;
  const ending = text.match(/[吗呢][？?。！!~～…]*$/u);
  if (ending && length >= 4 && length <= 80)
    return [`句末语气词「${ending[0][0]}」（4 至 80 字符）`];
  const questionMark = text.match(/[？?](?:$|[。！!~～…])/u);
  return questionMark && length >= 4 && length <= 120
    ? [`句末或语气标点前的问号「${questionMark[0][0]}」（4 至 120 字符）`]
    : [];
}

function scorePresencePenalty(
  selfReplies: number,
  total: number,
): ScoreEvidencePart {
  const measurable = selfReplies > 0 && total > 0;
  const ratio = measurable ? Math.min(1, selfReplies / total) : undefined;
  const penalty =
    ratio === undefined || ratio <= 0.25
      ? 0
      : Math.round(25 * Math.min(1, (ratio - 0.25) / 0.35));
  const contribution = penalty === 0 ? 0 : -penalty;
  const label =
    ratio === undefined
      ? "无自身回复或窗口总数为零，不扣分"
      : ratio <= 0.25
        ? "自身回复占比不超过 25%，不扣分"
        : "按超过 25% 的占比计算并四舍五入，最多扣 25";
  return {
    id: "recentPresencePenalty",
    value: contribution,
    facts: [
      { label: "冻结的近期自身回复数", value: selfReplies },
      { label: "冻结的近期窗口总数", value: total },
      {
        label: "自身回复占比（封顶 1）",
        value: ratio ?? "不计算（自身回复数或窗口总数为零）",
      },
      { label: "实际扣分", value: penalty },
    ],
    steps: [{ label, delta: contribution }],
    formula:
      ratio === undefined || ratio <= 0.25
        ? "本次不扣分：0"
        : `-round(25 × min(1, (${ratio} - 0.25) / 0.35)) = ${-penalty}`,
  };
}

function scorePressure(
  count: number,
  threshold: number,
  idle: boolean,
  frequency: number,
): ScoreEvidencePart {
  const ratio = Math.max(0, count / threshold);
  const facts: ScoreEvidencePart["facts"] = [
    { label: "冻结消息数 count", value: count },
    { label: "有效频率 f（裁剪到 0 至 1）", value: frequency },
    {
      label: "触发量 T = ceil(1 / f²)",
      value: Number.isFinite(threshold)
        ? threshold
        : "∞（频率为零，不写入非有限数字）",
    },
    { label: "比例 r = max(0, count / T)", value: ratio },
    { label: "达到平均空闲时间", value: idle },
    { label: "本次路径允许空闲加分", value: ratio <= 1 },
  ];
  if (ratio <= 1) {
    const rounded = Math.round(50 * ratio ** 2);
    const beforeCap = rounded + (idle ? 15 : 0);
    const value = Math.min(50, beforeCap);
    return {
      id: "pressure",
      value,
      facts,
      steps: [
        { label: "比例不超过 1，round(50 × r²)", delta: rounded },
        ...(idle ? [{ label: "达到平均空闲时间", delta: 15 }] : []),
        ...(beforeCap > 50
          ? [{ label: "此路径封顶 50", delta: 50 - beforeCap }]
          : []),
      ],
      formula: `min(50, round(50 × ${ratio}²) + ${idle ? 15 : 0}) = ${value}`,
    };
  }
  const overflow = Math.min(1, Math.log1p(ratio - 1) / Math.log1p(4));
  const overflowScore = Math.round(50 * overflow);
  const value = Math.min(100, 50 + overflowScore);
  return {
    id: "pressure",
    value,
    facts: [
      ...facts,
      { label: "溢出比例 min(1, ln(r) / ln(5))", value: overflow },
    ],
    steps: [
      { label: "比例超过 1，基础压力", delta: 50 },
      { label: "对数溢出加分（封顶 50）", delta: overflowScore },
    ],
    formula: `min(100, 50 + round(50 × min(1, ln(${ratio}) / ln(5)))) = ${value}；此路径不加空闲分。`,
  };
}
