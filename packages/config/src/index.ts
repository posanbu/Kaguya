/**
 * 功能概述：本入口聚合 `packages/config` 的稳定公开 API，向服务启动链、
 * WebUI/API 与测试导出错误类型、就绪态工具、Profile Registry manager
 * 和 schema/type 定义，避免上层直接耦合到内部文件组织。
 * 主要职责：统一转发 `errors.ts`、`readiness.ts`、`manager.ts` 与 `model.ts`
 * 的稳定符号；随着 Task 2 的显式 bootstrap 改造，入口不再暴露旧的
 * `initialize` 选项类型，而是仅保留新的 manager 能力与 v3 registry 类型。
 * 代码库关系：`apps/server`、`apps/web` 与其他包通过该文件消费配置模块，
 * 因此这里的导出集合同时充当跨包契约边界；任何遗留的 default/initialize
 * 语义都必须在这里被移除，避免 TypeScript 继续传播旧接口。
 * 输入输出与副作用：本文件本身无运行时副作用，只定义导出面；它的准确性直接影响
 * 包级 typecheck、调用方自动补全与重构安全性。
 */
export { ConfigError, configErrorCodes } from "./errors.js";
export type { ConfigErrorCode } from "./errors.js";
export {
  configurationSetupGuidance,
  ConfigIncompleteError,
  ConfigReviewRequiredError,
  ConfigSetupRequiredError,
  inspectUserConfigProfile,
  withRegistryReadiness,
} from "./readiness.js";
export type {
  ConfigurationGuidance,
  ConfigurationGuidanceStep,
  ConfigurationIssue,
  ConfigurationReadiness,
  ConfigurationWarning,
  ExistingConfigurationReadiness,
  ProfileReadiness,
} from "./readiness.js";
export { FileUserConfigManager } from "./manager.js";
export type { FileUserConfigManagerOptions } from "./manager.js";
export { REDACTED_CONFIG_VALUE, redactConfigValue } from "./redact.js";
export type { RedactedConfigValue } from "./redact.js";
export {
  aiConfigSchema,
  aiProviderConfigSchema,
  emptyUserConfigProfileSettings,
  jsonObjectSchema,
  jsonValueSchema,
  modelTiersSchema,
  platformConfigSchema,
  pluginConfigSchema,
  profileIdSchema,
  userConfigIndexSchema,
  userConfigProfileMetadataSchema,
  userConfigProfileSchema,
  userConfigProfileSettingsSchema,
} from "./model.js";
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModelTierTarget,
  ProfileId,
  ReplaceUserConfigProfileInput,
  UpdateUserConfigProfileInput,
  UserConfigIndex,
  UserConfigProfile,
  UserConfigProfileMetadata,
  UserConfigProfileSettings,
} from "./model.js";
