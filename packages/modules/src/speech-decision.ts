/**
 * 功能概述：独立决定当前回合是 speak、wait 还是 silent，不生成文本、不调用模型、不发送消息。
 * 主要职责：对不可变 turn-context 执行硬门禁和确定性评分，并以 Reliable DAG 为同一 candidate 提交唯一决策。
 * 代码库关系：只消费 `agent.turn.context.completed`；回复生成模块可在后续阶段消费 speak 决策，二者没有共享进程状态。
 */
import { z } from "@kaguya/schema";
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import {
  speechDecisionInformationKind,
  turnContextCompletedInformationKind,
  waitRequestedInformationKind,
  type TurnContextCompletedPayload,
} from "./information-kinds.js";

export const speechDecisionSettingsSchema = z.object({
  speakThreshold: z.number().min(0).max(1).default(0.6),
  waitThreshold: z.number().min(0).max(1).default(0.35),
  policyDigest: z.string().min(1).default("speech-policy:deterministic-v1"),
  settingsDigest: z.string().min(1).default("speech-settings:default-v1"),
}).strict();

export type SpeechDecisionSettings = z.infer<typeof speechDecisionSettingsSchema>;

export function scoreTurnContext(input: TurnContextCompletedPayload): {
  score: number;
  components: Record<string, number>;
  reasonCodes: string[];
  missingInputs: string[];
} {
  const components = {
    directness: input.directness,
    contentNeed: input.contentNeed,
    messageCount: Math.min(input.messageCount / 3, 1),
    recentPresencePenalty: input.recentPresencePenalty,
    frequencyMultiplier: input.frequencyMultiplier,
  };
  const score = Math.max(0, Math.min(1, (components.directness * 0.35 + components.contentNeed * 0.35 + components.messageCount * 0.15 - components.recentPresencePenalty * 0.15) * components.frequencyMultiplier));
  const missingInputs: string[] = [];
  if (input.recheckAt === undefined) missingInputs.push("recheckAt");
  return { score, components, reasonCodes: [], missingInputs };
}

export const speechDecisionModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "core.speech.decision",
    displayName: "Deterministic speech timing decision",
    settingsSchema: speechDecisionSettingsSchema,
    consumes: [turnContextCompletedInformationKind],
    produces: [speechDecisionInformationKind, waitRequestedInformationKind],
    selectors: [], promptRenderers: [], requires: [], provides: [],
  },
  create: ({ settings }) => ({
    provisions: [],
    subscriptions: [onInformation(turnContextCompletedInformationKind, { subscriptionId: "core.speech.turn-context", delivery: "durable" }, async (atom, context) => {
      const input = atom.payload as TurnContextCompletedPayload;
      const scored = scoreTurnContext(input);
      const hardGate = input.muted || !input.safe || !input.destinationAvailable || input.stale || input.frequencyMultiplier <= 0;
      const reasonCodes = hardGate ? [
        ...(input.muted ? ["muted"] : []),
        ...(!input.safe ? ["unsafe"] : []),
        ...(!input.destinationAvailable ? ["no-destination"] : []),
        ...(input.stale ? ["stale-candidate"] : []),
        ...(input.frequencyMultiplier <= 0 ? ["frequency-zero"] : []),
      ] : scored.reasonCodes;
      const action = hardGate ? "silent" : scored.score >= settings.speakThreshold ? "speak" : input.recheckAt !== undefined && input.attempt < input.totalWaitBudget && scored.score >= settings.waitThreshold ? "wait" : "silent";
      const payload = {
        action, status: "decision", candidateInformationId: input.candidateInformationId, turnContextInformationId: atom.informationId,
        score: scored.score, thresholds: { speak: settings.speakThreshold, wait: settings.waitThreshold }, components: scored.components,
        reasonCodes, missingInputs: scored.missingInputs, policyDigest: settings.policyDigest, settingsDigest: settings.settingsDigest,
        ...(input.recheckAt && action === "wait" ? { recheckAt: input.recheckAt, dueAt: input.recheckAt, delayMs: Math.max(0, Date.parse(input.recheckAt) - context.now().getTime()), wakePolicy: "recheckAt" as const } : {}),
        attempt: input.attempt, totalWaitBudget: input.totalWaitBudget,
      } as any;
      const decision = await context.commitTerminal("core.speech.decision", input.candidateInformationId, speechDecisionInformationKind, { payload, references: [{ relation: "core:uses-context", informationId: atom.informationId }] });
      if (action === "wait") await context.registerOnce("core.speech.wait", decision.informationId, waitRequestedInformationKind, { payload: { dueAt: input.recheckAt!, delayMs: payload.delayMs!, reason: "score-below-speak-threshold", attempt: input.attempt, totalWaitBudget: input.totalWaitBudget, wakePolicy: "recheckAt" }, references: [{ relation: "core:caused-by", informationId: decision.informationId }] });
    })],
  }),
});
