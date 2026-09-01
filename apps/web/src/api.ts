/**
 * 架构说明：本模块是 Web 端唯一的 Kaguya HTTP 客户端门面，
 * 负责把界面动作翻译成显式的 `/api/v1/setup` 与 Profile Registry 请求。
 * 它必须只暴露最小必需的 wire contract：读取匿名 setup 状态、发送消息、
 * 检查健康，以及对 Profile 集合执行列出、创建、读取、完整替换、
 * 显式选择和删除；所有请求都要在本地先校验 token，再拼出精确的
 * method / URL / Bearer 头 / JSON body，避免把鉴权或隐藏字段交给浏览器猜测。
 * 主要职责：为 App 及后续 Profile 管理页面提供稳定的 typed API，
 * 同时保留旧的消息与健康检查路径；Profile 请求必须编码 path 参数，
 * 匿名 setup 状态要能返回安全的 Registry 元数据，但不能包含任何 secret。
 * 代码库关系：该文件依赖 `@kaguya/config` 的 Profile JSON 结构作为返回值
 * 类型参考，但不会持有任何持久化密钥；Task 6 的 editor helper 会把
 * 表单字段转成完整的替换体，Task 7 再消费这里的客户端函数。
 * 输入输出与副作用：所有函数都通过可注入 `fetch` 实现发起请求，
 * 默认使用全局 `fetch`；若 token 为空、网络断开、响应格式不匹配或
 * 服务端返回错误 JSON，这里会抛出 `GatewayRequestError`。
 */
export const MAX_MESSAGE_LENGTH = 131_072;
const OPENAI_COMPATIBLE_PROVIDER_TYPE = "openai-compatible";
const DEFAULT_PROVIDER_ID = "default-provider";

export interface GatewayConfig {
  readonly token: string;
}

export interface SendMessageInput {
  readonly text: string;
}

export interface AcceptedMessage {
  readonly status: "accepted";
  readonly requestId: string;
}

export interface ProfileMetadata {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JsonObject {
  readonly [key: string]: unknown;
}

export interface UserConfigProfileProvider {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
  readonly settings: JsonObject;
}

export interface UserConfigProfilePlatform {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly credentials: JsonObject;
  readonly settings: JsonObject;
}

export interface UserConfigProfilePlugin {
  readonly id: string;
  readonly enabled: boolean;
  readonly settings: JsonObject;
}

export interface UserConfigProfile {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly ai: {
    readonly defaultProviderId?: string;
    readonly modelTiers?: {
      readonly light: {
        readonly providerId: string;
        readonly modelId: string;
      };
      readonly heavy: {
        readonly providerId: string;
        readonly modelId: string;
      };
    };
    readonly providers: readonly UserConfigProfileProvider[];
  };
  readonly platforms: readonly UserConfigProfilePlatform[];
  readonly plugins: readonly UserConfigProfilePlugin[];
  readonly review?: {
    readonly acknowledgedWarnings: readonly string[];
  };
}

export interface ConfigurationIssue {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export interface ConfigurationWarning {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

/**
 * 说明：Web 客户端保留 `setup_required` 这个状态，是为了对齐底层配置库在
 * bootstrap 之前的只读 inspect 契约。正常的 Kaguya Server 启动流程会先创建
 * 空 registry，因此 `/api/v1/setup` 通常返回 `invalid`、`review_required`、
 * `restart_required` 或 `ready`，但客户端仍接受 `setup_required`，以兼容
 * 未来显式 bootstrap/setup mode 或更底层的管理调用。
 */
export interface ConfigurationStatus {
  readonly status:
    | "setup_required"
    | "restart_required"
    | "ready"
    | "invalid"
    | "review_required";
  readonly selectedProfileId: string;
  readonly profiles: readonly ProfileMetadata[];
  readonly issues?: readonly ConfigurationIssue[];
  readonly warnings?: readonly ConfigurationWarning[];
}

export interface ProfileRegistryMetadata {
  readonly selectedProfileId: string;
  readonly profiles: readonly ProfileMetadata[];
}

export interface ProfileReadResult {
  readonly profile: UserConfigProfile;
}

export interface ProfileMutationResult {
  readonly profile: UserConfigProfile;
  readonly restartRequired: boolean;
}

export interface CreateProfileInput {
  readonly name: string;
}

export interface ReplaceProfileInput {
  readonly name: string;
  readonly acknowledgedWarnings: readonly string[];
  readonly ai: {
    readonly defaultProviderId: string;
    readonly modelTiers: {
      readonly light: {
        readonly providerId: string;
        readonly modelId: string;
      };
      readonly heavy: {
        readonly providerId: string;
        readonly modelId: string;
      };
    };
    readonly providers: readonly UserConfigProfileProvider[];
  };
  readonly platforms: readonly UserConfigProfilePlatform[];
  readonly plugins: readonly UserConfigProfilePlugin[];
}

export type ProfileReplacementInput = ReplaceProfileInput;

export interface ConfigurationSaved {
  readonly status: "configured";
  readonly restartRequired: true;
}

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

export async function getConfigurationStatus(
  fetchImplementation: typeof fetch = fetch,
): Promise<ConfigurationStatus> {
  const response = await requestJson(
    "/api/v1/setup",
    { method: "GET" },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isConfigurationStatusResponse(payload)) {
    throw new GatewayRequestError(
      `无法读取配置状态（HTTP ${response.status}）`,
      "configuration_status_failed",
      response.status,
    );
  }
  return payload.data;
}

export async function listProfiles(
  config: GatewayConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<ProfileRegistryMetadata> {
  const response = await requestAuthenticatedJson(
    config,
    "/api/v1/profiles",
    { method: "GET" },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isProfileRegistryMetadataResponse(payload)) {
    throw new GatewayRequestError(
      `无法读取 Profile 集合（HTTP ${response.status}）`,
      "profiles_failed",
      response.status,
    );
  }
  return payload.data;
}

export async function createProfile(
  config: GatewayConfig,
  input: CreateProfileInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<ProfileMutationResult> {
  const token = requireToken(config);
  const response = await requestJson(
    "/api/v1/profiles",
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
    fetchImplementation,
  );
  return readProfileMutationResult(response, "profile_create_failed");
}

export async function getProfile(
  config: GatewayConfig,
  profileId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ProfileReadResult> {
  const token = requireToken(config);
  const response = await requestJson(
    `/api/v1/profiles/${encodeURIComponent(profileId)}`,
    {
      method: "GET",
      headers: bearerHeaders(token),
    },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isProfileReadResultResponse(payload)) {
    throw new GatewayRequestError(
      `无法读取 Profile（HTTP ${response.status}）`,
      "profile_read_failed",
      response.status,
    );
  }
  return payload.data;
}

export async function replaceProfile(
  config: GatewayConfig,
  profileId: string,
  replacement: ProfileReplacementInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<ProfileMutationResult> {
  const token = requireToken(config);
  const response = await requestJson(
    `/api/v1/profiles/${encodeURIComponent(profileId)}`,
    {
      method: "PUT",
      headers: jsonHeaders(token),
      body: JSON.stringify(replacement),
    },
    fetchImplementation,
  );
  return readProfileMutationResult(response, "profile_replace_failed");
}

export async function selectProfile(
  config: GatewayConfig,
  profileId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ProfileMutationResult> {
  const token = requireToken(config);
  const response = await requestJson(
    "/api/v1/profiles/selection",
    {
      method: "PUT",
      headers: jsonHeaders(token),
      body: JSON.stringify({ selectedProfileId: profileId }),
    },
    fetchImplementation,
  );
  return readProfileMutationResult(response, "profile_select_failed");
}

export async function deleteProfile(
  config: GatewayConfig,
  profileId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const token = requireToken(config);
  const response = await requestJson(
    `/api/v1/profiles/${encodeURIComponent(profileId)}`,
    {
      method: "DELETE",
      headers: bearerHeaders(token),
    },
    fetchImplementation,
  );
  if (response.status === 204) {
    return;
  }
  const payload = await readJson(response);
  if (!response.ok) {
    const gatewayError = isErrorResponse(payload) ? payload.error : undefined;
    throw new GatewayRequestError(
      gatewayError?.message ?? `删除 Profile 失败（HTTP ${response.status}）`,
      gatewayError?.code ?? "profile_delete_failed",
      response.status,
      gatewayError?.requestId,
    );
  }
  throw new GatewayRequestError(
    "服务返回了无法识别的删除响应",
    "invalid_response",
    response.status,
  );
}

export async function checkGatewayHealth(
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const response = await requestJson(
    "/healthz",
    { method: "GET" },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload) || payload.status !== "ok") {
    throw new GatewayRequestError(
      `服务健康检查失败（HTTP ${response.status}）`,
      "health_check_failed",
      response.status,
    );
  }
}

export async function sendMessage(
  config: GatewayConfig,
  input: SendMessageInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<AcceptedMessage> {
  const token = requireToken(config);

  if (!input.text.trim()) {
    throw new GatewayRequestError("消息不能为空", "empty_message", 0);
  }
  if ([...input.text].length > MAX_MESSAGE_LENGTH) {
    throw new GatewayRequestError(
      "消息超过服务允许的长度",
      "message_too_long",
      0,
    );
  }

  const response = await requestJson(
    "/api/v1/messages",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify({ text: input.text }),
    },
    fetchImplementation,
  );

  const payload = await readJson(response);
  if (!response.ok) {
    const gatewayError = isErrorResponse(payload) ? payload.error : undefined;
    throw new GatewayRequestError(
      gatewayError?.message ?? `服务请求失败（HTTP ${response.status}）`,
      gatewayError?.code ?? "gateway_error",
      response.status,
      gatewayError?.requestId,
    );
  }
  if (!isAcceptedMessageResponse(payload)) {
    throw new GatewayRequestError(
      "服务返回了无法识别的响应",
      "invalid_response",
      response.status,
    );
  }
  return payload.data;
}

/**
 * 兼容旧的 setup 聚合写入口，供当前尚未切换到 Profile 管理页的界面使用。
 * 后续 UI 迁移完成后应移除。
 */
export interface InitialConfigurationInput {
  readonly profileName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly lightModel: string;
  readonly heavyModel: string;
  readonly acknowledgeOptional: boolean;
}

export async function initializeConfiguration(
  config: GatewayConfig,
  input: InitialConfigurationInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<ConfigurationSaved> {
  const profileId =
    input.profileName.trim() === "default"
      ? "default"
      : (
          await createProfile(
            config,
            { name: input.profileName },
            fetchImplementation,
          )
        ).profile.id;
  await replaceProfile(
    config,
    profileId,
    {
      name: input.profileName,
      acknowledgedWarnings: input.acknowledgeOptional
        ? ["platforms-empty", "plugins-empty"]
        : [],
      ai: {
        defaultProviderId: DEFAULT_PROVIDER_ID,
        modelTiers: {
          light: {
            providerId: DEFAULT_PROVIDER_ID,
            modelId: input.lightModel,
          },
          heavy: {
            providerId: DEFAULT_PROVIDER_ID,
            modelId: input.heavyModel,
          },
        },
        providers: [
          {
            id: DEFAULT_PROVIDER_ID,
            type: OPENAI_COMPATIBLE_PROVIDER_TYPE,
            enabled: true,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            models: [input.lightModel, input.heavyModel],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    },
    fetchImplementation,
  );
  return {
    status: "configured",
    restartRequired: true,
  };
}

async function readProfileMutationResult(
  response: Response,
  failureCode: string,
): Promise<ProfileMutationResult> {
  const payload = await readJson(response);
  if (!response.ok || !isProfileMutationResultResponse(payload)) {
    const gatewayError = isErrorResponse(payload) ? payload.error : undefined;
    throw new GatewayRequestError(
      gatewayError?.message ??
        `Profile mutation failed（HTTP ${response.status}）`,
      gatewayError?.code ?? failureCode,
      response.status,
      gatewayError?.requestId,
    );
  }
  return payload.data;
}

async function requestAuthenticatedJson(
  config: GatewayConfig,
  path: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  const token = requireToken(config);
  return requestJson(
    path,
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...bearerHeaders(token),
      },
    },
    fetchImplementation,
  );
}

async function requestJson(
  path: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImplementation(path, init);
  } catch (error) {
    throw new GatewayRequestError(
      error instanceof Error && error.name === "AbortError"
        ? "服务请求已取消"
        : "无法连接到 Kaguya 服务",
      "network_error",
      0,
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function requireToken(config: GatewayConfig): string {
  const token = config.token.trim();
  if (!token) {
    throw new GatewayRequestError("请输入服务访问令牌", "missing_token", 0);
  }
  return token;
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
  };
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...bearerHeaders(token),
    "content-type": "application/json",
  };
}

function isAcceptedMessageResponse(
  value: unknown,
): value is { data: AcceptedMessage } {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }
  return (
    value.data.status === "accepted" && typeof value.data.requestId === "string"
  );
}

function isConfigurationStatusResponse(
  value: unknown,
): value is { data: ConfigurationStatus } {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }
  const status = value.data.status;
  if (
    ![
      "setup_required",
      "restart_required",
      "ready",
      "invalid",
      "review_required",
    ].includes(String(status))
  ) {
    return false;
  }
  return (
    typeof value.data.selectedProfileId === "string" &&
    isProfileMetadataArray(value.data.profiles) &&
    isOptionalConfigurationIssueArray(value.data.issues) &&
    isOptionalConfigurationWarningArray(value.data.warnings)
  );
}

function isProfileRegistryMetadataResponse(
  value: unknown,
): value is { data: ProfileRegistryMetadata } {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }
  return (
    typeof value.data.selectedProfileId === "string" &&
    isProfileMetadataArray(value.data.profiles)
  );
}

function isProfileReadResultResponse(
  value: unknown,
): value is { data: ProfileReadResult } {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    isUserConfigProfile(value.data.profile)
  );
}

function isProfileMutationResultResponse(
  value: unknown,
): value is { data: ProfileMutationResult } {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    isUserConfigProfile(value.data.profile) &&
    typeof value.data.restartRequired === "boolean"
  );
}

function isProfileMetadataArray(
  value: unknown,
): value is readonly ProfileMetadata[] {
  return Array.isArray(value) && value.every(isProfileMetadata);
}

function isProfileMetadata(value: unknown): value is ProfileMetadata {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isOptionalConfigurationIssueArray(
  value: unknown,
): value is readonly ConfigurationIssue[] | undefined {
  return value === undefined || isConfigurationIssueArray(value);
}

function isConfigurationIssueArray(
  value: unknown,
): value is readonly ConfigurationIssue[] {
  return Array.isArray(value) && value.every(isConfigurationIssue);
}

function isConfigurationIssue(value: unknown): value is ConfigurationIssue {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}

function isOptionalConfigurationWarningArray(
  value: unknown,
): value is readonly ConfigurationWarning[] | undefined {
  return value === undefined || isConfigurationWarningArray(value);
}

function isConfigurationWarningArray(
  value: unknown,
): value is readonly ConfigurationWarning[] {
  return Array.isArray(value) && value.every(isConfigurationWarning);
}

function isConfigurationWarning(value: unknown): value is ConfigurationWarning {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isUserConfigProfile(value: unknown): value is UserConfigProfile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isProfileAi(value.ai) &&
    isProfilePlatformArray(value.platforms) &&
    isProfilePluginArray(value.plugins) &&
    (value.review === undefined || isProfileReview(value.review))
  );
}

function isProfileAi(value: unknown): value is UserConfigProfile["ai"] {
  return (
    isRecord(value) &&
    isOptionalString(value.defaultProviderId) &&
    isOptionalModelTiers(value.modelTiers) &&
    isProfileProviderArray(value.providers)
  );
}

function isOptionalModelTiers(
  value: unknown,
): value is UserConfigProfile["ai"]["modelTiers"] | undefined {
  return value === undefined || isModelTiers(value);
}

function isModelTiers(value: unknown): boolean {
  return (
    isRecord(value) &&
    isModelTierTarget(value.light) &&
    isModelTierTarget(value.heavy)
  );
}

function isModelTierTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.providerId === "string" &&
    typeof value.modelId === "string"
  );
}

function isProfileProviderArray(
  value: unknown,
): value is readonly UserConfigProfileProvider[] {
  return Array.isArray(value) && value.every(isProfileProvider);
}

function isProfileProvider(value: unknown): value is UserConfigProfileProvider {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.enabled === "boolean" &&
    isOptionalString(value.baseUrl) &&
    isOptionalString(value.apiKey) &&
    isStringArray(value.models) &&
    isJsonObject(value.settings)
  );
}

function isProfilePlatformArray(
  value: unknown,
): value is readonly UserConfigProfilePlatform[] {
  return Array.isArray(value) && value.every(isProfilePlatform);
}

function isProfilePlatform(value: unknown): value is UserConfigProfilePlatform {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.enabled === "boolean" &&
    isJsonObject(value.credentials) &&
    isJsonObject(value.settings)
  );
}

function isProfilePluginArray(
  value: unknown,
): value is readonly UserConfigProfilePlugin[] {
  return Array.isArray(value) && value.every(isProfilePlugin);
}

function isProfilePlugin(value: unknown): value is UserConfigProfilePlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.enabled === "boolean" &&
    isJsonObject(value.settings)
  );
}

function isProfileReview(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.acknowledgedWarnings) &&
    value.acknowledgedWarnings.every((warning) => typeof warning === "string")
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isErrorResponse(value: unknown): value is {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
} {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }
  return (
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    typeof value.error.requestId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
