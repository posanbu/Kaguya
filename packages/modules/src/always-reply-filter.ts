/**
 * 功能概述：本模块提供演示用的始终通过过滤器，把每个入站文本原子显式推进为回复请求。
 * 主要职责：`alwaysReplyFilterSettingsSchema` 是无字段的严格设置 schema；
 * `alwaysReplyFilterModule` 订阅入站 kind，并以原 payload 注册回复请求 kind。
 * 代码库关系：依赖 `information-kinds.ts` 的同一 definition；engine `ModuleHost`
 * 在注册回复请求时补齐指向入站 atom 的直接 `core:caused-by` 与同一 context，因此过滤器
 * 不产生成功 decision，也不包含已删除的 target instance 配置。
 * 输入输出与副作用：任意非空设置会被 schema 拒绝；每条入站文本只调用一次 context.register，
 * Core 随后持久化和广播回复请求，模块本身没有数据库或网络副作用。
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
    apiVersion: 1,
    definitionId: "demo.filter.always",
    displayName: "Always reply filter",
    settingsSchema: alwaysReplyFilterSettingsSchema,
    informationKinds: [
      inboundTextInformationKind,
      replyRequestedInformationKind,
    ],
  },
  create: () => ({
    subscriptions: [
      onInformation(inboundTextInformationKind, async (atom, context) => {
        await context.register(replyRequestedInformationKind, {
          payload: atom.payload,
        });
      }),
    ],
  }),
});
