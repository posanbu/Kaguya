/**
 * 功能概述：把 speak 决策转换为回复请求，是时机决策与回复生成之间唯一的 DAG 边界。
 * 主要职责：仅处理 action=speak；不评分、不调用模型、不决定措辞。
 */
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import { replyRequestedInformationKind, speechDecisionInformationKind } from "./information-kinds.js";

export const speechReplyModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "core.speech.reply-bridge",
    displayName: "Speech decision reply bridge",
    settingsSchema: z.object({}).strict(),
    consumes: [speechDecisionInformationKind],
    produces: [replyRequestedInformationKind],
    selectors: [], promptRenderers: [], requires: [], provides: [],
  },
  create: () => ({
    provisions: [],
    subscriptions: [onInformation(speechDecisionInformationKind, { subscriptionId: "core.speech.reply", delivery: "durable" }, async (atom, context) => {
      const input = atom.payload as any;
      if (input.status !== "decision" || input.action !== "speak") return;
      await context.registerOnce("core.speech.reply.requested", atom.informationId, replyRequestedInformationKind, {
        payload: { text: input.text, source: input.source },
      });
    })],
  }),
});
