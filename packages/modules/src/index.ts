/**
 * 功能概述：本入口汇总 modules 包的旧事件模块与信息原子模块公开契约，供 Runtime 和外部
 * 组合层以稳定路径导入定义、schema 与模块工厂。
 * 主要职责：继续导出尚未迁移的事件模块；导出信息 DAG 的 kind、始终回复过滤器和 LLM
 * 回复模块工厂；不在入口中创建定义或执行运行时副作用。
 * 代码库关系：Task 3 新增的 LLM 信息回复工厂由 Runtime 注入其 `core.llm.completed`
 * definition 与生命周期 executor；`informationModuleKinds` 仍只包含 modules 自己拥有的 kind。
 * 输入输出与副作用：仅 re-export，导入本文件不会注册 kind、调用 LLM 或发送平台消息。
 */
export {
  alwaysReplyFilterModule,
  alwaysReplyFilterSettingsSchema,
} from "./always-reply-filter.js";
export {
  messageIngestedEvent,
  messageMentionSchema,
  messageSenderSchema,
  moduleMessageSourceSchema,
  moduleMessageSchema,
  outboundMessageDeliveredEvent,
  outboundMessageFailedEvent,
  outboundMessageRequestedEvent,
  replyRequestedEvent,
  type MessageMention,
  type ModuleMessageSource,
  type ModuleMessage,
} from "./events.js";
export {
  createLlmReplyModule,
  llmReplySettingsSchema,
  modelTierSchema,
  type CreateLlmReplyModuleOptions,
  type ModelTier,
  type ModuleModelSelection,
  type ReplyLlmExecutor,
  type ReplyMessageReader,
} from "./llm-reply.js";
export {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  filterDecisionInformationKind,
  inboundTextInformationKind,
  informationModuleKinds,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
export {
  alwaysReplyInformationFilterModule,
  alwaysReplyInformationFilterSettingsSchema,
} from "./always-reply-information-filter.js";
export {
  createLlmInformationReplyModule,
  llmCompletedInformationPayloadSchema,
  llmInformationReplySettingsSchema,
  modelTierSchema as informationModelTierSchema,
  type CreateLlmInformationReplyModuleOptions,
  type LlmCompletedInformationPayload,
  type LlmInformationReplyExecutor,
  type LlmInformationReplySettings,
} from "./llm-information-reply.js";
