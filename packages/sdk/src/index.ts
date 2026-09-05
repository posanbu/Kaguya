/**
 * 功能概述：聚合信息原子模块 SDK 的最终公共 API，使模块作者只接触 kind 声明、
 * `onInformation` 订阅与 `context.register` 派生边界。
 * 主要职责：从 `information-kind.ts` 导出 kind、引用和日志策略；从 `modules.ts`
 * 导出信息模块清单、实例、订阅与创建辅助函数。
 * 代码库关系：engine 的 `ModuleHost`、内建 modules 与 Runtime 都通过本入口共享同一
 * definition 对象；事件定义、工作流节点和旧事件模块 SDK 已被移除而不提供兼容包装。
 * 输入输出与副作用：本文件只组织静态导出，无运行时 I/O 或注册副作用。
 */
export {
  defineInformationKind,
  type DefineInformationKindInput,
  type InformationKindDefinition,
  type InformationLogDisabledPolicy,
  type InformationLogEnabledPolicy,
  type InformationLogLevel,
  type InformationLogPolicy,
  type InformationLogProjection,
  type InformationReferenceRule,
  type InformationRegistrationInput,
} from "./information-kind.js";
export {
  defineInformationModule,
  onInformation,
  type CreateInformationModuleInstanceOptions,
  type InformationExecutionContext,
  type InformationModuleActivation,
  type InformationModuleDefinition,
  type InformationModuleHandlerContext,
  type InformationModuleInstance,
  type InformationModuleManifest,
  type InformationModuleSubscription,
} from "./modules.js";
