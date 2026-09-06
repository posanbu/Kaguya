/**
 * 功能概述：汇总 modules 包的信息原子 kind、默认过滤器与 LLM 回复模块公共契约。
 * 主要职责：导出最终 `alwaysReplyFilterModule`、`createLlmReplyModule`、默认 reply
 * Selector 名称以及各阶段 kind/schema；旧事件定义和定向事件模块不再公开。
 * 代码库关系：Runtime 注入 `core.llm.completed` definition 与 lifecycle executor，并把
 * 这些模块交给 engine `ModuleHost`；`informationModuleKinds` 只包含本包拥有的 kind。
 * 输入输出与副作用：仅 re-export，导入本文件不会注册 kind、调用 LLM 或发送平台消息。
 */
export {
  alwaysReplyFilterModule,
  alwaysReplyFilterSettingsSchema,
} from "./always-reply-filter.js";
export {
  createLlmReplyModule,
  llmCompletedInformationPayloadSchema,
  llmReplySettingsSchema,
  modelTierSchema,
  type CreateLlmReplyModuleOptions,
  type LlmCompletedInformationPayload,
  type LlmReplyExecutor,
  type LlmReplySettings,
  type ModelTier,
  type ModuleModelSelection,
} from "./llm-reply.js";
export {
  compileReplyPromptFromInformation,
  currentAcceptedMessageSelector,
} from "./reply-context.js";
export {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  deliveryRequestedInformationKind,
  filterDecisionInformationKind,
  inboundTextInformationKind,
  informationModuleKinds,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
