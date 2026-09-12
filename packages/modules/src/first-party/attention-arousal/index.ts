/**
 * 功能概述：判断冻结事件是否足以唤起 Agent 注意，不决定话题、回复或具体行动。
 * 主要职责：执行不可绕过的硬门禁和 MaiBot 风格的确定性 0–100 显著性评分。
 * 代码库关系：只消费 Heartflow 冻结的 turn context，并提交 claim 的唯一注意唤起终态；eligible 使用独立 attention 命名空间；非 eligible 直接提交廉价等待或静默决策。
 */
import { z } from "@kaguya/schema";
import { defineInformationModule, onInformation } from "@kaguya/sdk";

import {
  attentionArousalCompletedInformationKind,
  turnContextCompletedInformationKind,
  type TurnContextCompletedPayload,
} from "../information-kinds.js";

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
    threshold: z.number().int().min(0).max(100),
    deferMs: z.number().int().min(0),
    policyDigest: z.string().min(1),
    settingsDigest: z.string().min(1),
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
}

export function scoreAttentionArousal(
  input: TurnContextCompletedPayload,
): AttentionArousalScore {
  const frequency = Math.min(1, Math.max(0, input.frequency));
  const triggerThreshold =
    frequency === 0 ? Number.POSITIVE_INFINITY : Math.ceil(1 / frequency ** 2);
  const direct = input.mentionedSelf || input.repliedToSelf || input.namedSelf;
  const relevance = input.mentionedSelf
    ? 100
    : input.repliedToSelf || input.namedSelf
      ? 80
      : input.isPrivate
        ? 40
        : 0;
  const texts = input.inputs.map((item: { text: string }) =>
    stripNoise(item.text),
  );
  const contentResult = scoreContent(texts, direct || input.isPrivate);
  const pressure = scorePressure(
    input.messageCount,
    triggerThreshold,
    input.idleReachedAverage,
  );
  const recentPresencePenalty = scorePresencePenalty(
    input.recentSelfReplies,
    input.recentWindowMessages,
  );
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
  };
}

export function decideAttentionArousal(
  input: TurnContextCompletedPayload,
  threshold = 80,
): { outcome: AttentionArousalOutcome; reasonCodes: string[] } {
  const hardGates = [
    ...(input.muted ? ["muted"] : []),
    ...(!input.safe ? ["unsafe"] : []),
    ...(!input.destinationAvailable ? ["no-destination"] : []),
    ...(input.stale ? ["stale-candidate"] : []),
    ...(input.frequency <= 0 ? ["frequency-zero"] : []),
  ];
  if (hardGates.length > 0)
    return { outcome: "ignore", reasonCodes: hardGates };
  if (input.isPrivate)
    return { outcome: "attend", reasonCodes: ["private-conversation"] };
  if (input.mentionedSelf || input.repliedToSelf || input.namedSelf) {
    return {
      outcome: "attend",
      reasonCodes: [
        ...(input.mentionedSelf ? ["mentioned-self"] : []),
        ...(input.repliedToSelf ? ["replied-to-self"] : []),
        ...(input.namedSelf ? ["named-self"] : []),
      ],
    };
  }
  if (scoreAttentionArousal(input).score >= threshold)
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
    displayName: "Attention Arousal",
    summary: "Filters events by whether they deserve agent attention.",
    description:
      "Applies hard safety and availability gates, then scores an immutable turn context for event salience. It never chooses a topic, writes a reply, calls a model, or performs an action.",
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
          const scored = scoreAttentionArousal(input);
          const decision = decideAttentionArousal(input, settings.threshold);
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

function scoreContent(texts: string[], direct: boolean) {
  const reasons: string[] = [];
  let score = 0;
  const combined = texts.filter(Boolean).join("\n");
  if (texts.some(isQuestion)) {
    score += 15;
    reasons.push("question");
  }
  const directRequest = DIRECT_REQUEST_TERMS.some((term) =>
    combined.includes(term),
  );
  const weakRequest =
    direct && WEAK_REQUEST_TERMS.some((term) => combined.includes(term));
  if (directRequest || weakRequest) {
    score += 20;
    reasons.push("request");
  }
  if (
    OPINION_TERMS.some((term) => combined.includes(term)) ||
    /(?:你|Kaguya|辉夜).{0,6}怎么看|怎么看.{0,6}(?:你|Kaguya|辉夜)/iu.test(
      combined,
    )
  ) {
    score += 20;
    reasons.push("opinion");
  }
  if (Array.from(combined).length >= 40) {
    score += 5;
    reasons.push("long-text");
  }
  if (Array.from(combined).length >= 120) {
    score += 10;
    reasons.push("very-long-text");
  }
  const nonBlank = texts.filter(Boolean);
  if (
    nonBlank.length === 0 ||
    (nonBlank.every((text) => Array.from(text).length <= 8) &&
      nonBlank.every((text) => SHORT_REACTIONS.has(text)))
  ) {
    score -= 25;
    reasons.push("short-reaction");
  }
  return { score, reasonCodes: reasons };
}

function isQuestion(text: string): boolean {
  if (!text) return false;
  if (QUESTION_TERMS.some((term) => text.includes(term))) return true;
  if (/(?<![这那没])什么/u.test(text)) return true;
  const length = Array.from(text).length;
  if (/[吗呢][？?。！!~～…]*$/u.test(text) && length >= 4 && length <= 80)
    return true;
  return /[？?](?:$|[。！!~～…])/u.test(text) && length >= 4 && length <= 120;
}

function scorePresencePenalty(selfReplies: number, total: number): number {
  if (selfReplies <= 0 || total <= 0) return 0;
  const ratio = Math.min(1, selfReplies / total);
  if (ratio <= 0.25) return 0;
  return Math.round(25 * Math.min(1, (ratio - 0.25) / 0.35));
}

function scorePressure(
  count: number,
  threshold: number,
  idle: boolean,
): number {
  const ratio = Math.max(0, count / threshold);
  if (ratio <= 1)
    return Math.min(50, Math.round(50 * ratio ** 2) + (idle ? 15 : 0));
  const overflow = Math.min(1, Math.log1p(ratio - 1) / Math.log1p(4));
  return Math.min(100, 50 + Math.round(50 * overflow));
}
