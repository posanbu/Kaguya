/**
 * 架构说明：本入口汇总 engine 层的事件总线、工作流、模块宿主与信息原子编排能力，
 * 供下游包通过一个稳定的公共面导入运行时基础设施。
 * 主要职责：向外导出 EventBus/WorkflowEngine/ModuleHost 这组旧能力，以及
 * InformationBus/InformationCore/InformationKindRegistry 与相关错误类型，
 * 让信息原子链路能够在 engine 层闭合并被后续 Runtime、数据库和模块代码复用。
 * 代码库关系：`packages/engine/src/*.ts` 的实现会被 `packages/runtime`、`packages/modules`
 * 和测试套件直接消费；本文件不包含业务逻辑，只负责稳定导出。
 * 输入输出与副作用：无运行时副作用，仅组织模块出口；这里的导出顺序必须与实际文件
 * 的命名保持一致，避免下游在 Task 4 及之后继续引用旧的中间文件名。
 */
export {
  EventBus,
  EventCloneError,
  EventValidationError,
  type EventCloneField,
  type EventBusOptions,
  type EventEmitOptions,
  type EventValidationPhase,
  type InterceptResult,
} from "./event-bus.js";
export {
  InformationBus,
  type InformationBusOptions,
} from "./information-bus.js";
export {
  DuplicateInformationKindError,
  InformationCoreClosedError,
  InformationCoreNotStartedError,
  InformationEngineError,
  InformationIdCollisionError,
  InformationRegistrySealedError,
  InformationReferenceValidationError,
  InvalidInformationIdError,
  ReservedInformationKindError,
  UnknownInformationKindError,
} from "./information-errors.js";
export {
  InformationCore,
  type InformationAtomStore,
  type InformationCoreOptions,
  type InformationReferenceExpectation,
  type InformationReferenceQuery,
} from "./information-core.js";
export {
  InformationKindRegistry,
} from "./information-kind-registry.js";
export {
  AbortError,
  RetryableError,
  WorkflowEngine,
  WorkflowRunRecordingError,
  type WorkflowEngineOptions,
  type WorkflowExecutionResult,
  type WorkflowRunRecorder,
} from "./workflow-engine.js";
export {
  ModuleDefinitionNotFoundError,
  ModuleHost,
  ModuleTargetNotFoundError,
  type ModuleHostOptions,
} from "./module-host.js";
