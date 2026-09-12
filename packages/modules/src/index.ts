/**
 * 功能概述：汇总 modules 包的信息原子 kind、Heartflow、Message Composer与 person-fact Model Task 公共契约。
 * 主要职责：导出 `createHeartflowModule`、`createMessageComposerModule`、
 * `createPersonFactTaskModule`、默认 Selector 名称以及各阶段 kind/schema；旧事件定义、reply-only completed schema 和定向事件模块不再公开。
 * 代码库关系：apps composition root 通过 first-party/catalog.ts 工厂选择模块，注入 shared completed definition，
 * 并传入 modelTaskCapability token；Host 只消费显式 Catalog 中的 Manifest。
 * 输入输出与副作用：仅 re-export，导入本文件不会注册 kind、调用 LLM 或发送平台消息。
 */
export {
  associationCandidateSelector,
  associationIdentitySelector,
  associationModule,
} from "./first-party/association/index.js";
export { identityModule } from "./first-party/identity/index.js";
export {
  createHeartflowModule,
  heartflowSettingsSchema,
  heartflowMemorySelector,
  heartflowStateSelector,
  type CreateHeartflowModuleOptions,
} from "./first-party/heartflow/index.js";
export {
  heartbeatModule,
  heartbeatSettingsSchema,
  heartbeatScopeSelector,
  heartbeatDueSelector,
} from "./first-party/heartbeat/index.js";
export {
  attentionArousalModule,
  attentionArousalSettingsSchema,
  decideAttentionArousal,
  scoreAttentionArousal,
  type AttentionArousalOutcome,
  type AttentionArousalSettings,
} from "./first-party/attention-arousal/index.js";
export {
  createMessageComposerModule,
  messageTaskOutputSchema,
  messageComposerSettingsSchema,
  modelTierSchema,
  type CreateMessageComposerModuleOptions,
  type MessageComposerSettings,
  type ModelTaskCapability,
  type ModelTaskRequest,
  type ModelTaskResult,
  type ModelTaskCompletedInformationPayload,
  type ModelTier,
  type ModuleModelSelection,
  type AgentIdentity,
  type MessagePromptTemplates,
} from "./first-party/message-composer/index.js";
export {
  createPersonFactTaskModule,
  currentPersonFactCandidateSelector,
  personFactCandidatePromptRenderer,
  personFactTaskOutputSchema,
  personFactTaskSettingsSchema,
  type CreatePersonFactTaskModuleOptions,
  type PersonFactTaskOutput,
  type PersonFactTaskSettings,
} from "./first-party/person-fact-task/index.js";
export {
  compileMessagePromptFromInformation,
  associationMessageContextSelector,
  currentAcceptedMessageSelector,
  turnMessageContextSelector,
  inboundMemoryPromptRenderer,
} from "./first-party/message-composer/message-context.js";
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
  inboundTextInformationPayloadSchema,
  messageTargetSchema,
  type MessageTarget,
  personFactCandidateInformationKind,
  personFactCandidateInformationPayloadSchema,
  personFactExtractedInformationKind,
  personFactExtractedPayloadSchema,
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  chatScopeEntityInformationKind,
  chatScopeBindingInformationKind,
  platformAccountEntityInformationKind,
  platformAccountBindingInformationKind,
  personEntityInformationKind,
  personObservedInformationKind,
  personResolutionInformationKind,
  personContextCompletedInformationKind,
  turnContextCompletedInformationKind,
  attentionArousalCompletedInformationKind,
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
  type MessageIntentRequestedInformationPayload,
} from "./first-party/information-kinds.js";
export {
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  createFirstPartyModuleConfigDefaults,
  type FirstPartyModuleInstanceConfig,
} from "./first-party/catalog.js";
