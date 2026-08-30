/**
 * 架构说明：本入口只做配置模型、就绪态与管理器能力的稳定导出，
 * 让上层调用方无需关心各 schema/错误类型的文件切分，同时避免
 * 直接依赖内部实现细节。
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
export type {
  FileUserConfigInitializeOptions,
  FileUserConfigManagerOptions,
} from "./manager.js";
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
