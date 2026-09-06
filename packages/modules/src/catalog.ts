/**
 * 功能概述：集中显式导入 first-party 模块，提供可被 composition root 选择和合并的 Catalog。
 * 主要职责：createFirstPartyModuleCatalog 接收宿主 Model Task token 和共享 completed kind，构造过滤与回复定义；
 * firstPartyModuleActivations 声明演示默认设置，与“可发现”的 Catalog 分开。
 * 代码库关系：Server、Demo 和测试组合入口传入 Runtime 的实际 token/definition；工厂仅依赖模块侧
 * 结构类型，保留 completed payload 泛型与对象身份，避免 modules 反向依赖 Runtime。
 * 输入输出与副作用：纯内存定义，没有 timer、环境读取、连接、全局注册或动态目录扫描。
 */
import {
  defineInformationModuleCatalog,
  type InformationModuleActivation,
} from "@kaguya/sdk";
import { alwaysReplyFilterModule } from "./always-reply-filter.js";
import { identityModule } from "./identity.js";
import {
  createLlmReplyModule,
  type CreateLlmReplyModuleOptions,
  type ModelTaskCompletedInformationPayload,
} from "./llm-reply.js";
export function createFirstPartyModuleCatalog<
  P extends ModelTaskCompletedInformationPayload,
>(options: CreateLlmReplyModuleOptions<P>) {
  return defineInformationModuleCatalog(
    alwaysReplyFilterModule,
    identityModule,
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
    Object.freeze({
      instanceId: "identity.default",
      definitionId: "core.identity.normalize",
      settings: Object.freeze({}),
    }),
  ]);
