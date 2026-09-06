/**
 * 功能概述：提供演示用通过过滤器，把入站文本推进为唯一回复请求事实。
 * 主要职责：alwaysReplyFilterModule 声明 consumes/produces，按稳定订阅 ID durable 消费；
 * registerOnce 使用输入 informationId 去重，无字段严格 settings schema 拒绝额外配置。
 * 代码库关系：Host 补齐因果和 context，Core/Database 原子提交输出与后续 delivery intent；
 * catalog.ts 显式收集本定义，模块导入不启动任何任务。
 * 输入输出与副作用：重复投递返回原有赢家，模块没有数据库连接、网络或跨请求状态。
 */
import { z } from "@kaguya/schema";
import { defineInformationModule, onInformation } from "@kaguya/sdk";

import {
  inboundTextInformationKind,
  replyRequestedInformationKind,
} from "./information-kinds.js";

export const alwaysReplyFilterSettingsSchema = z.object({}).strict();

export const alwaysReplyFilterModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
    definitionId: "demo.filter.always",
    displayName: "Always reply filter",
    settingsSchema: alwaysReplyFilterSettingsSchema,
    consumes: [inboundTextInformationKind],
    produces: [replyRequestedInformationKind],
  },
  create: () => ({
    provisions: [],
    subscriptions: [
      onInformation(
        inboundTextInformationKind,
        { subscriptionId: "kaguya.filter.inbound", delivery: "durable" },
        async (atom, context) => {
          await context.registerOnce(
            "kaguya.filter.reply.v1",
            atom.informationId,
            replyRequestedInformationKind,
            {
              payload: atom.payload,
            },
          );
        },
      ),
    ],
  }),
});
