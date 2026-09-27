/**
 * 公开独立 QQ 表情模块工厂，导入不执行收藏、下载或发送。
 * 导出跨会话批准/确认事实和窄 MessageAuthorization token，供 composition 与 Runtime 共享对象身份。
 * 授权消息渲染工厂供 composition 注入 Runtime，模板正文不再由宿主内嵌。
 * 功能概述：汇总 modules 包的信息原子 kind、Router、Heavy与 person-fact Model Task 公共契约。
 * 额外导出后台原始消息写回模块与 request/terminal kind，供 composition 显式装配。
 * 主要职责：导出 `createRouterModule`、`createHeavyModule`、
 * `createPersonFactTaskModule`、默认 Selector 名称以及各阶段 kind/schema；旧事件定义、reply-only completed schema 和定向事件模块不再公开。
 * 代码库关系：apps composition root 通过 first-party/catalog.ts 工厂选择模块，注入 shared completed definition，
 * 并传入 modelTaskCapability token；Host 只消费显式 Catalog 中的 Manifest。
 * 输入输出与副作用：仅 re-export，导入本文件不会注册 kind、调用 LLM 或发送平台消息。
 */
export { identityModule } from "./first-party/identity/index.js";
export {
  renderPersonProfileSections,
  displayPersonName,
  appendPersonProfilesToPrompt,
  type FrozenPersonProfile,
  type FrozenPersonName,
  type ActivePersonProfiles,
} from "./first-party/person-profile.js";
export {
  createRouterModule,
  routerSettingsSchema,
  routerStateSelector,
  lightActionSchema,
  type CreateRouterModuleOptions,
} from "./first-party/router/index.js";
export {
  heartbeatModule,
  heartbeatSettingsSchema,
  heartbeatScopeSelector,
  heartbeatDueSelector,
} from "./first-party/heartbeat/index.js";
export {
  createAttentionArousalModule,
  attentionArousalModule,
  attentionArousalSettingsSchema,
  attentionArousalStateSelector,
  attentionArousalTimerSelector,
  decideAttentionArousal,
  isNightSleepTime,
  localTimeOfDay,
  nextLocalTimeOccurrence,
  type CreateAttentionArousalModuleOptions,
  type AttentionArousalOutcome,
  type AttentionArousalSettings,
} from "./first-party/attention-arousal/index.js";
export {
  createHeavyModule,
  messageTaskOutputSchema,
  heavySettingsSchema,
  modelTierSchema,
  type CreateHeavyModuleOptions,
  type HeavySettings,
  type ModelTaskCapability,
  type ModelTaskRequest,
  type ModelTaskResult,
  type ModelTaskCompletedInformationPayload,
  type ModelTier,
  type ModuleModelSelection,
  type AgentIdentity,
  type HeavyPromptTemplates,
} from "./first-party/heavy/index.js";
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
  currentAcceptedMessageSelector,
  turnMessageContextSelector,
  inboundMemoryPromptRenderer,
} from "./first-party/heavy/message-context.js";
export {
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
  turnBootstrapProjectionSchema,
  normalizeTurnBootstrap,
  attentionArousalStateRecordedInformationKind,
  attentionArousalCompletedInformationKind,
  waitRequestedInformationKind,
  attentionArousalActivityInformationKind,
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
  type MessageIntentRequestedInformationPayload,
  type TurnBootstrapProjection,
  type NormalizedTurnBootstrapProjection,
  type AttentionArousalState,
} from "./first-party/information-kinds.js";
export {
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  createFirstPartyModuleConfigDefaults,
  type FirstPartyModuleInstanceConfig,
} from "./first-party/catalog.js";

export {
  memoryRawModule,
  memoryRawRequestedInformationKind,
  memoryRawCompletedInformationKind,
  memoryRawEmptyInformationKind,
  memoryRawFailedInformationKind,
} from "./first-party/memory-raw/index.js";

export { memoryNativeModule } from "./first-party/memory-native/index.js";
export { memoryMem0Module } from "./first-party/memory-mem0/index.js";

export * from "./first-party/message-authorization.js";
export {
  identityAliasesTemplateDeclaration,
  identityNameTemplateDeclaration,
  identityPersonaTemplateDeclaration,
} from "./prompt-declarations.js";

export { createAuthorizedMessagePromptRenderer } from "./first-party/heavy/authorized-prompt.js";

export { createQqExpressionModule } from "./first-party/qq-expression/index.js";
