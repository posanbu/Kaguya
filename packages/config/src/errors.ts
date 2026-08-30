export const configErrorCodes = [
  "CONFIG_INVALID_INPUT",
  "CONFIG_PROFILE_NOT_FOUND",
  "CONFIG_PROFILE_NAME_CONFLICT",
  "CONFIG_DEFAULT_PROFILE_PROTECTED",
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
