/**
 * 功能概述：把入站消息冻结为供发言时机模块消费的 turn-context。
 * 主要职责：只复制正规化输入并计算可重复的基础分量，不读取全局状态、不生成回复。
 */
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import {
  inboundTextInformationKind,
  turnContextCompletedInformationKind,
} from "./information-kinds.js";

export const turnContextModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "core.turn.context",
    displayName: "Turn context builder",
    settingsSchema: z.object({}).strict(),
    consumes: [inboundTextInformationKind],
    produces: [turnContextCompletedInformationKind],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: () => ({
    provisions: [],
    describeStartup: () => ({
      summary: "Turn context builder ready",
      fields: { strategy: "deterministic-v1" },
    }),
    subscriptions: [
      onInformation(
        inboundTextInformationKind,
        { subscriptionId: "core.turn.context.inbound", delivery: "durable" },
        async (atom, context) => {
          const input = atom.payload as any;
          const source = input.source;
          const directness =
            (source.mentions?.length ?? 0) > 0 || source.replyTo !== undefined
              ? 1
              : 0.8;
          const contentNeed = input.text.trim().length > 0 ? 1 : 0;
          await context.registerOnce(
            "core.turn.context.completed",
            atom.informationId,
            turnContextCompletedInformationKind,
            {
              payload: Object.freeze({
                candidateInformationId: atom.informationId,
                asOf: atom.occurredAt,
                text: input.text,
                source,
                directness,
                contentNeed,
                messageCount: 1,
                recentPresencePenalty: 0,
                frequencyMultiplier: 1,
                muted: false,
                safe: true,
                destinationAvailable: source.destination !== undefined,
                stale: false,
                attempt: 0,
                totalWaitBudget: 0,
              }),
              references: [
                {
                  relation: "core:uses-context",
                  informationId: atom.informationId,
                },
              ],
            },
          );
        },
      ),
    ],
  }),
});
