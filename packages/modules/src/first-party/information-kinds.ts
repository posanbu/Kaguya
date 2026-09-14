/**
 * 功能概述：一方 Information Kind 的稳定公共入口；实现按 message、turn、heartbeat、identity、association 和 person-fact 分域。
 * 主要职责：仅重导出原有 schema、类型和定义对象，不复制实例、不注册 Kind。
 * 代码库关系：Catalog、模块及宿主继续使用此路径；领域修改留在 kinds/，Registry 对象身份和协议保持一致。
 */
export {
  turnProvenanceSchema,
  messageTargetSchema,
  type MessageTarget,
  inboundTextInformationPayloadSchema,
  messageIntentRequestedInformationPayloadSchema,
  type MessageIntentRequestedInformationPayload,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  filterDecisionInformationKind,
  coreMemoryTextInformationKind,
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
} from "./kinds/message.js";
export {
  associationRequestedInformationPayloadSchema,
  type AssociationRequestedInformationPayload,
  associationRequestedInformationKind,
  associationQueryInformationPayloadSchema,
  type AssociationQueryInformationPayload,
  associationQueryInformationKind,
  associationCandidateInformationPayloadSchema,
  type AssociationCandidateInformationPayload,
  associationCandidateInformationKind,
  associationCompletedInformationPayloadSchema,
  type AssociationCompletedInformationPayload,
  associationCompletedInformationKind,
} from "./kinds/association.js";
export {
  personFactCandidateInformationPayloadSchema,
  type PersonFactCandidateInformationPayload,
  personFactCandidateInformationKind,
  personFactExtractedPayloadSchema,
  type PersonFactExtractedPayload,
  personFactExtractedInformationKind,
} from "./kinds/person-fact.js";
export {
  turnClaimedInformationKind,
  turnStartedInformationKind,
  turnDecisionSupersededInformationKind,
  turnDecisionInterruptedInformationKind,
  turnCompletedInformationKind,
  turnWaitingInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnSupersededInformationKind,
  turnInterruptedInformationKind,
  type TurnContextCompletedPayload,
  turnContextCompletedInformationKind,
  type AttentionArousalPayload,
  attentionArousalCompletedInformationKind,
  waitRequestedInformationKind,
} from "./kinds/turn.js";
export {
  heartbeatScheduledInformationKind,
  heartbeatFiredInformationKind,
  heartbeatSupersededInformationKind,
  heartbeatFailedInformationKind,
  turnCandidateInformationKind,
  observationWakeInformationKind,
} from "./kinds/heartbeat.js";
export {
  chatScopeEntityInformationKind,
  chatScopeBindingInformationKind,
  platformAccountEntityInformationKind,
  platformAccountBindingInformationKind,
  personEntityInformationKind,
  personObservedInformationKind,
  personResolutionInformationKind,
  personContextCompletedInformationKind,
} from "./kinds/identity.js";
