/**
 * 功能概述：汇总 engine 层最终的信息原子编排 API，提供持久化优先的 Core、并发广播、
 * kind registry 与模块宿主，不再暴露事件总线或工作流执行器。
 * 主要职责：导出 `InformationCore`、`InformationBus`、`InformationKindRegistry`、
 * `ModuleHost` 及其错误和边界类型。
 * 代码库关系：Runtime 通过本入口组合 Core 和 ModuleHost；database 实现
 * `InformationLedger`，modules 只经 SDK 契约接入宿主。
 * 输入输出与副作用：本文件只组织静态导出，无 I/O；所有导出都指向最终文件名。
 */
export {
  InformationBus,
  type InformationBroadcastResult,
  type InformationConsumer,
  type InformationSubscriber,
} from "./information-bus.js";
export {
  DuplicateInformationKindError,
  DuplicateSelectedInformationIdError,
  InformationCoreClosedError,
  InformationCoreNotStartedError,
  InformationEngineError,
  InformationIdCollisionError,
  InvalidInformationSelectionError,
  InvalidSelectorQueryError,
  InformationRegistrySealedError,
  InformationReferenceValidationError,
  InvalidInformationIdError,
  SelectedInformationMissingError,
  SelectorSourceInformationMissingError,
  ReservedInformationKindError,
  UnauthorizedSelectedInformationIdError,
  UnknownRetrievalStrategyError,
  UnknownSelectedInformationIdError,
  UnknownInformationKindError,
} from "./information-errors.js";
export {
  InformationCore,
  type InformationAppendOptions,
  type InformationCoreOptions,
  type InformationLedger,
  type InformationLogProjectionRunner,
  type InformationReferenceExpectation,
  type InformationReferenceQuery,
} from "./information-core.js";
export { consumerFailedInformationKind } from "./information-kinds.js";
export { InformationKindRegistry } from "./information-kind-registry.js";
export {
  InformationSelectorExecutor,
  type InformationRetrievalStrategy,
} from "./information-selector.js";
export {
  ModuleDefinitionNotFoundError,
  ModuleHost,
  ModuleKindNotDeclaredError,
  type ModuleHostOptions,
} from "./module-host.js";
