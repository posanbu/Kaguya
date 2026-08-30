/**
 * 功能概述：本文件集中定义 `packages/config` 的稳定错误码与 `ConfigError`
 * 容器，供 manager、schema 校验、敏感文件读写与 readiness 流程共享，
 * 保证跨层错误分类可被测试、上层服务和 WebUI 一致消费。
 * 主要职责：`configErrorCodes` 枚举对外可观测的配置错误；`ConfigError`
 * 封装错误码、消息与可选 cause，并作为所有配置模块失败的统一承载类型。
 * 代码库关系：`manager.ts`、`secure-files.ts`、`readiness.ts` 和测试直接依赖
 * 本文件；Task 2 新增 `CONFIG_PROFILE_IN_USE`，用于显式 selected Profile
 * 删除保护，避免继续复用旧的 default 语义。
 * 输入输出与副作用：本文件无运行时副作用，但其错误码联合类型会参与
 * TypeScript 类型检查，缺失条目会直接导致公开 API 无法通过编译。
 */
export const configErrorCodes = [
  "CONFIG_INVALID_INPUT",
  "CONFIG_PROFILE_NOT_FOUND",
  "CONFIG_PROFILE_NAME_CONFLICT",
  "CONFIG_DEFAULT_PROFILE_PROTECTED",
  "CONFIG_PROFILE_IN_USE",
  "CONFIG_UNSUPPORTED_VERSION",
  "CONFIG_CORRUPT_STORE",
  "CONFIG_UNSAFE_PATH",
  "CONFIG_PERMISSION_ERROR",
  "CONFIG_IO_ERROR",
  "CONFIG_SETUP_REQUIRED",
  "CONFIG_INCOMPLETE",
  "CONFIG_REVIEW_REQUIRED",
] as const;

export type ConfigErrorCode = (typeof configErrorCodes)[number];

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  override readonly cause: unknown;

  constructor(
    code: ConfigErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ConfigError";
    this.code = code;
    this.cause = options.cause;
  }
}
