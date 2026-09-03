/**
 * 功能概述：本模块提供演示用的“始终回复”信息过滤器，将每个入站文本原子转换为
 * `filter.decision` 原子，而不承担后续回复选择或定向路由。
 * 主要职责：导出严格设置 schema，并在 `alwaysReplyInformationFilterModule` 的
 * `onInformation` handler 中通过 context.register 保留原有 shouldReply、reason 与
 * targetInstanceId payload；输入 atom 仅触发派生注册，不会被修改。
 * 代码库关系：依赖 `information-kinds.ts` 的入站文本和决策 definition，由模块包的
 * 测试和后续 Runtime 组合；InformationModuleHost 负责为 register 注入 source 与引用。
 * 输入输出与副作用：设置必须包含非空 replyTargetInstanceId；每次入站会请求注册一个
 * 决策 atom，Core 最终负责持久化、广播和消费者故障记录。
 */
import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  onInformation,
} from "@kaguya/sdk";

import {
  filterDecisionInformationKind,
  inboundTextInformationKind,
} from "./information-kinds.js";

export const alwaysReplyInformationFilterSettingsSchema = z
  .object({ replyTargetInstanceId: z.string().trim().min(1) })
  .strict();

export const alwaysReplyInformationFilterModule = defineInformationModule({
  manifest: {
    apiVersion: 1,
    definitionId: "demo.filter.always-information",
    displayName: "Always reply information filter",
    settingsSchema: alwaysReplyInformationFilterSettingsSchema,
    informationKinds: [inboundTextInformationKind, filterDecisionInformationKind],
  },
  create: ({ settings }) => ({
    subscriptions: [
      onInformation(inboundTextInformationKind, async (atom, context) => {
        await context.register(filterDecisionInformationKind, {
          payload: {
            shouldReply: true,
            reason: "always-reply",
            targetInstanceId: settings.replyTargetInstanceId,
          },
        });
        void atom;
      }),
    ],
  }),
});
