/**
 * 功能概述：集中显式导入 first-party 模块，提供可被 composition root 选择和合并的 Catalog。
 * 主要职责：createFirstPartyModuleCatalog 接收共享 LLM completed kind，构造过滤与回复定义；
 * firstPartyModuleActivations 声明演示默认设置，与“可发现”的 Catalog 分开。
 * 代码库关系：Server、Demo 和测试组合入口调用本工厂并注入 executor capability；Runtime 不引用本目录。
 * 输入输出与副作用：纯内存定义，没有 timer、环境读取、连接、全局注册或动态目录扫描。
 */
import {
  defineInformationModuleCatalog,
  type InformationModuleActivation,
} from "@kaguya/sdk";
import { alwaysReplyFilterModule } from "./always-reply-filter.js";
import {
  createLlmReplyModule,
  type CreateLlmReplyModuleOptions,
} from "./llm-reply.js";
export function createFirstPartyModuleCatalog(
  options: CreateLlmReplyModuleOptions,
) {
  return defineInformationModuleCatalog(
    alwaysReplyFilterModule,
    createLlmReplyModule(options),
  );
}
export const firstPartyModuleActivations: readonly InformationModuleActivation[] =
  Object.freeze([
    Object.freeze({
      instanceId: "filter.default",
      definitionId: "demo.filter.always",
      settings: Object.freeze({}),
    }),
    Object.freeze({
      instanceId: "reply.default",
      definitionId: "demo.reply.llm",
      settings: Object.freeze({
        modelTier: "heavy",
        outbound: Object.freeze({ mode: "source", messageKind: "reply" }),
      }),
    }),
  ]);
