/**
 * 功能概述：把 speak 决策转换为回复请求，是时机决策与回复生成之间唯一的 DAG 边界。
 * 主要职责：仅处理 action=speak；把原始文本、正规化 source 和 turn-context provenance 原样带入回复请求，
 * silent/wait 不产生下游事实；不评分、不调用模型、不决定措辞。
 * 代码库关系：消费 speech-decision.ts 的唯一终态并生产 llm-reply.ts 的唯一入口；ModuleHost 自动补齐
 * decision 的直接因果边和 runtime context，本模块显式保留 core:uses-context 指向 turn context。
 * 输入输出与副作用：使用 decision informationId 作为幂等键写一次账本；不保存进程状态、不调用模型或传输层。
 */
import {
  defineInformationModule,
  defineModuleDiagnostic,
  onInformation,
} from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import {
  replyRequestedInformationKind,
  speechDecisionInformationKind,
} from "./information-kinds.js";

export const speechReplySkippedDiagnostic = defineModuleDiagnostic({
  event: "reply.bridge.skipped",
  message: "Speech decision did not request a reply",
  level: "debug",
  payloadSchema: z
    .object({
      status: z.string().min(1),
      action: z.string().min(1),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

export const speechReplyModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "core.speech.reply-bridge",
    displayName: "Speech decision reply bridge",
    settingsSchema: z.object({}).strict(),
    consumes: [speechDecisionInformationKind],
    produces: [replyRequestedInformationKind],
    diagnostics: [speechReplySkippedDiagnostic],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: () => ({
    provisions: [],
    describeStartup: () => ({
      summary: "Speech-to-reply bridge ready",
      fields: { acceptedAction: "speak" },
    }),
    subscriptions: [
      onInformation(
        speechDecisionInformationKind,
        { subscriptionId: "core.speech.reply", delivery: "durable" },
        async (atom, context) => {
          const input = atom.payload as any;
          if (input.status !== "decision" || input.action !== "speak") {
            await context.report(speechReplySkippedDiagnostic, {
              status: input.status,
              action: input.action,
            });
            return;
          }
          await context.registerOnce(
            "core.speech.reply.requested",
            atom.informationId,
            replyRequestedInformationKind,
            {
              payload: { text: input.text, source: input.source },
              references: [
                {
                  relation: "core:uses-context",
                  informationId: input.turnContextInformationId,
                },
              ],
            },
          );
        },
      ),
    ],
  }),
});
