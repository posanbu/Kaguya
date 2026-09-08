/**
 * 功能概述：汇总 modules 包的信息原子 kind、Heartflow、LLM 回复与 person-fact Model Task 公共契约。
 * 主要职责：导出 `createHeartflowModule`、`createLlmReplyModule`、
 * `createPersonFactTaskModule`、默认 Selector 名称以及各阶段 kind/schema；旧事件定义、reply-only completed schema 和定向事件模块不再公开。
 * 代码库关系：apps composition root 通过 catalog.ts 工厂选择模块，注入 shared completed definition，
 * 并传入 modelTaskCapability token；Host 只消费显式 Catalog，informationModuleKinds 仅收集本包 kind。
 * 输入输出与副作用：仅 re-export，导入本文件不会注册 kind、调用 LLM 或发送平台消息。
 */
export {
  associationCandidateSelector,
  associationIdentitySelector,
  associationModule,
} from "./association.js";
export { identityModule } from "./identity.js";
export {
  createHeartflowModule,
  heartflowMemorySelector,
  heartflowStateSelector,
  type CreateHeartflowModuleOptions,
} from "./heartflow.js";
export {
  heartbeatModule,
  heartbeatSettingsSchema,
  heartbeatScopeSelector,
  heartbeatDueSelector,
} from "./heartbeat.js";
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
  associationReplyContextSelector,
  currentAcceptedMessageSelector,
  turnReplyContextSelector,
  inboundMemoryPromptRenderer,
} from "./reply-context.js";
export {
  associationCandidateInformationKind,
  associationCandidateInformationPayloadSchema,
  associationCompletedInformationKind,
  associationCompletedInformationPayloadSchema,
  associationQueryInformationKind,
  associationQueryInformationPayloadSchema,
  associationRequestedInformationKind,
  associationRequestedInformationPayloadSchema,
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
  heartbeatScheduledInformationKind,
  heartbeatFiredInformationKind,
  heartbeatSupersededInformationKind,
  heartbeatFailedInformationKind,
  turnCandidateInformationKind,
  turnClaimedInformationKind,
  turnStartedInformationKind,
  turnDecisionSupersededInformationKind,
  turnCompletedInformationKind,
  turnWaitingInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnSupersededInformationKind,
  type PersonFactCandidateInformationPayload,
  type PersonFactExtractedPayload,
  type AssociationCandidateInformationPayload,
  type AssociationCompletedInformationPayload,
  type AssociationQueryInformationPayload,
  type AssociationRequestedInformationPayload,
  type ReplyRequestedInformationPayload,
} from "./information-kinds.js";
export {
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  firstPartyModuleActivations,
} from "./catalog.js";
