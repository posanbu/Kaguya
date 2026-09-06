/**
 * 功能概述：汇总 modules 包的信息原子 kind、默认过滤器、LLM 回复与 person-fact Model Task 公共契约。
 * 主要职责：导出最终 `alwaysReplyFilterModule`、`createLlmReplyModule`、
 * `createPersonFactTaskModule`、默认 Selector 名称以及各阶段 kind/schema；旧事件定义、reply-only completed schema 和定向事件模块不再公开。
 * 代码库关系：apps composition root 通过 catalog.ts 工厂选择模块，注入 shared completed definition，
 * 并传入 modelTaskCapability token；Host 只消费显式 Catalog，informationModuleKinds 仅收集本包 kind。
 * 输入输出与副作用：仅 re-export，导入本文件不会注册 kind、调用 LLM 或发送平台消息。
 */
export {
  alwaysReplyFilterModule,
  alwaysReplyFilterSettingsSchema,
} from "./always-reply-filter.js";
export { identityModule } from "./identity.js";
export { turnContextModule } from "./turn-context.js";
export { speechReplyModule } from "./speech-reply.js";
export {
  scoreTurnContext,
  speechDecisionModule,
  speechDecisionSettingsSchema,
  type SpeechDecisionSettings,
} from "./speech-decision.js";
export {
  createLlmReplyModule,
  replyTaskOutputSchema,
  llmReplySettingsSchema,
  modelTierSchema,
  type CreateLlmReplyModuleOptions,
  type LlmReplySettings,
  type ModelTaskCapability,
  type ModelTaskRequest,
  type ModelTaskResult,
  type ModelTaskCompletedInformationPayload,
  type ModelTier,
  type ModuleModelSelection,
} from "./llm-reply.js";
export {
  createPersonFactTaskModule,
  currentPersonFactCandidateSelector,
  personFactCandidatePromptRenderer,
  personFactTaskOutputSchema,
  personFactTaskSettingsSchema,
  type CreatePersonFactTaskModuleOptions,
  type PersonFactTaskOutput,
  type PersonFactTaskSettings,
} from "./person-fact-task.js";
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
  personFactCandidateInformationKind,
  personFactCandidateInformationPayloadSchema,
  personFactExtractedInformationKind,
  personFactExtractedPayloadSchema,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  chatScopeEntityInformationKind,
  chatScopeBindingInformationKind,
  platformAccountEntityInformationKind,
  platformAccountBindingInformationKind,
  personEntityInformationKind,
  personObservedInformationKind,
  personResolutionInformationKind,
  personContextCompletedInformationKind,
  turnContextCompletedInformationKind,
  speechDecisionInformationKind,
  waitRequestedInformationKind,
  type PersonFactCandidateInformationPayload,
  type PersonFactExtractedPayload,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
export {
  createFirstPartyModuleCatalog,
  firstPartyModuleActivations,
} from "./catalog.js";
