/**
 * ModelGenerationOptions.timeoutMs 随 Profile API 往返，限定为 1–300000 ms 硬超时。
 * 架构说明：本模块是 Web 端唯一的 Kaguya HTTP 客户端门面，
 * 负责把界面动作翻译成显式的 Profile Registry 请求。
 * 它必须只暴露最小必需的 wire contract：读取受保护的 Profile readiness、发送消息、
 * 检查健康，以及对 Profile 集合执行列出、创建、读取、完整替换、
 * 显式选择和删除；所有请求都要在本地先校验 token，再拼出精确的
 * method / URL / Bearer 头 / JSON body，避免把鉴权或隐藏字段交给浏览器猜测。
 * getInspection 使用共享 DTO schema 校验只读响应，并复用认证、取消与 401 锁屏处理。
 * 主要职责：为 App 及后续 Profile 管理页面提供稳定的 typed API，
 * 同时保留旧的消息与健康检查路径；Profile 请求必须编码 path 参数，
 * Profile 状态要能返回安全的 Registry 元数据，但不能包含任何 secret。
 * 代码库关系：该文件依赖 `@kaguya/config` 的 Profile JSON 结构作为返回值
 * 类型参考，但不会持有任何持久化密钥；editor helper 会把表单字段转成完整的替换体。
 * 输入输出与副作用：所有函数都通过可注入 `fetch` 实现发起请求，
 * 默认使用全局 `fetch`；若 token 为空、网络断开、响应格式不匹配或
 * 服务端返回错误 JSON，这里会抛出 `GatewayRequestError`。
 */
export const MAX_MESSAGE_LENGTH = 131_072;
export const GATEWAY_UNAUTHORIZED_EVENT = "kaguya:gateway-unauthorized";

export interface GatewayConfig {
  readonly token: string;
}

export interface NapCatStatus {
  readonly enabled: boolean;
  readonly wsUrl?: string;
  readonly hasAccessToken: boolean;
  readonly selfId?: string;
  readonly reconnectMs: number;
}

export interface NapCatSettingsInput {
  readonly enabled: boolean;
  readonly wsUrl: string;
  readonly accessToken: string;
  readonly selfId: string;
  readonly reconnectMs: number;
}

export interface NapCatMutationResult {
  readonly status: NapCatStatus;
  readonly restartRequired: true;
}

export interface SendMessageInput {
  readonly text: string;
}

export interface DiscoverModelsInput {
  readonly baseUrl: string;
  readonly apiKey: string;
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

export interface UserConfigProfile {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly gatewayAllowlist: readonly string[];
  readonly identity: {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly persona: string;
  };
  readonly ai: {
    readonly defaultProviderId?: string;
    readonly modelTiers?: {
      readonly light: {
        readonly providerId: string;
        readonly modelId: string;
        readonly generation?: ModelGenerationOptions;
        readonly recommendedDurationMs?: number;
      };
      readonly heavy: {
        readonly providerId: string;
        readonly modelId: string;
        readonly generation?: ModelGenerationOptions;
        readonly recommendedDurationMs?: number;
      };
    };
    readonly providers: readonly UserConfigProfileProvider[];
  };
  readonly memory: {
    readonly enabled: boolean;
  };
  readonly platforms: readonly UserConfigProfilePlatform[];
  readonly review?: {
    readonly acknowledgedWarnings: readonly string[];
  };
}

export interface ModelGenerationOptions {
  readonly timeoutMs?: number;
  readonly reasoning?:
    | "provider-default"
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
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

export interface ConfigurationStatus {
  readonly status: "restart_required" | "ready" | "invalid" | "review_required";
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
  readonly gatewayAllowlist: readonly string[];
  readonly identity: UserConfigProfile["identity"];
  readonly acknowledgedWarnings: readonly string[];
  readonly ai: {
    readonly defaultProviderId: string;
    readonly modelTiers: {
      readonly light: {
        readonly providerId: string;
        readonly modelId: string;
        readonly generation?: ModelGenerationOptions;
        readonly recommendedDurationMs?: number;
      };
      readonly heavy: {
        readonly providerId: string;
        readonly modelId: string;
        readonly generation?: ModelGenerationOptions;
        readonly recommendedDurationMs?: number;
      };
    };
    readonly providers: readonly UserConfigProfileProvider[];
  };
  readonly memory: {
    readonly enabled: boolean;
  };
  readonly platforms: readonly UserConfigProfilePlatform[];
}

export type ProfileReplacementInput = ReplaceProfileInput;

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

export async function getNapCatStatus(
  config: GatewayConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<NapCatStatus> {
  const response = await requestAuthenticatedJson(
    config,
    "/api/v1/napcat",
    { method: "GET" },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isNapCatStatusResponse(payload)) {
    throw new GatewayRequestError(
      `无法读取 NapCat 配置（HTTP ${response.status}）`,
      "napcat_status_failed",
      response.status,
    );
  }
  return payload.data;
}

export async function saveNapCatSettings(
  config: GatewayConfig,
  input: NapCatSettingsInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<NapCatMutationResult> {
  const response = await requestAuthenticatedJson(
    config,
    "/api/v1/napcat",
    {
      method: "PUT",
      headers: jsonHeaders(requireToken(config)),
      body: JSON.stringify(input),
    },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isNapCatMutationResponse(payload)) {
    throw new GatewayRequestError(
      `无法保存 NapCat 配置（HTTP ${response.status}）`,
      "napcat_save_failed",
      response.status,
    );
  }
  return payload.data;
}

export async function discoverModels(
  config: GatewayConfig,
  input: DiscoverModelsInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<readonly string[]> {
  const response = await requestAuthenticatedJson(
    config,
    "/api/v1/models/discover",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isModelDiscoveryResponse(payload)) {
    const gatewayError = isErrorResponse(payload) ? payload.error : undefined;
    throw new GatewayRequestError(
      gatewayError?.message ?? `获取模型列表失败（HTTP ${response.status}）`,
      gatewayError?.code ?? "model_discovery_failed",
      response.status,
      gatewayError?.requestId,
    );
  }
  return payload.data.models;
}

export async function listProfiles(
  config: GatewayConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<ConfigurationStatus> {
  const response = await requestAuthenticatedJson(
    config,
    "/api/v1/profiles",
    { method: "GET" },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isConfigurationStatusResponse(payload)) {
    throw new GatewayRequestError(
      `无法读取 Profile 集合（HTTP ${response.status}）`,
      "profile_registry_status_failed",
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
        ...jsonHeaders(token),
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
    const response = await fetchImplementation(path, init);
    if (response.status === 401 && hasAuthorizationHeader(init.headers)) {
      globalThis.window?.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
    }
    return response;
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

function hasAuthorizationHeader(headers: HeadersInit | undefined): boolean {
  return headers !== undefined && new Headers(headers).has("authorization");
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

function isNapCatStatusResponse(
  value: unknown,
): value is { data: NapCatStatus } {
  return isRecord(value) && isRecord(value.data) && isNapCatStatus(value.data);
}

function isNapCatMutationResponse(
  value: unknown,
): value is { data: NapCatMutationResult } {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    value.data.restartRequired === true &&
    isNapCatStatus(value.data.status)
  );
}

function isNapCatStatus(value: unknown): value is NapCatStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.enabled === "boolean" &&
    typeof value.hasAccessToken === "boolean" &&
    typeof value.reconnectMs === "number" &&
    (value.wsUrl === undefined || typeof value.wsUrl === "string") &&
    (value.selfId === undefined || typeof value.selfId === "string")
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
    !["restart_required", "ready", "invalid", "review_required"].includes(
      String(status),
    )
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

function isProfileIdentity(
  value: unknown,
): value is UserConfigProfile["identity"] {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isStringArray(value.aliases) &&
    typeof value.persona === "string"
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
    isProfileIdentity(value.identity) &&
    isStringArray(value.gatewayAllowlist) &&
    isProfileAi(value.ai) &&
    isProfileMemory(value.memory) &&
    isProfilePlatformArray(value.platforms) &&
    !("plugins" in value) &&
    !("runtime" in value) &&
    (value.review === undefined || isProfileReview(value.review))
  );
}

function isProfileMemory(value: unknown): value is UserConfigProfile["memory"] {
  return isRecord(value) && typeof value.enabled === "boolean";
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
    typeof value.modelId === "string" &&
    (value.generation === undefined ||
      isModelGenerationOptions(value.generation)) &&
    (value.recommendedDurationMs === undefined ||
      (typeof value.recommendedDurationMs === "number" &&
        Number.isInteger(value.recommendedDurationMs) &&
        value.recommendedDurationMs > 0))
  );
}

function isModelGenerationOptions(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.timeoutMs === undefined ||
      (typeof value.timeoutMs === "number" &&
        Number.isSafeInteger(value.timeoutMs) &&
        value.timeoutMs >= 1 &&
        value.timeoutMs <= 300_000)) &&
    (value.reasoning === undefined ||
      [
        "provider-default",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ].includes(String(value.reasoning)))
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

function isModelDiscoveryResponse(value: unknown): value is {
  data: { models: readonly string[] };
} {
  return (
    isRecord(value) && isRecord(value.data) && isStringArray(value.data.models)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function getAdapterStatus(
  config: GatewayConfig,
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<import("./adapter-status.js").AdapterStatus> {
  const response = await requestAuthenticatedJson(
    config,
    "/api/v1/adapters/status",
    { method: "GET", signal },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload) || !isAdapterHostStatus(payload.data))
    throw new GatewayRequestError(
      "无法读取 Adapter 状态",
      "adapter_status_failed",
      response.status,
    );
  return payload.data;
}
function isAdapterHostStatus(
  value: unknown,
): value is import("./adapter-status.js").AdapterStatus {
  const lifecycles = [
    "disabled",
    "starting",
    "running",
    "stopping",
    "stopped",
    "failed",
  ];
  const ingress = ["ready", "runtime_unavailable", "stopping"];
  return (
    isRecord(value) &&
    lifecycles.includes(String(value.adapterHostState)) &&
    isRecord(value.runtime) &&
    ingress.includes(String(value.runtime.ingress)) &&
    (value.runtime.reason === undefined ||
      [
        "configuration_not_ready",
        "database_unavailable",
        "runtime_start_failed",
      ].includes(String(value.runtime.reason))) &&
    Array.isArray(value.adapters) &&
    value.adapters.every(
      (a) =>
        isRecord(a) &&
        typeof a.adapterId === "string" &&
        typeof a.type === "string" &&
        typeof a.platform === "string" &&
        typeof a.enabled === "boolean" &&
        lifecycles.includes(String(a.lifecycle)) &&
        ingress.includes(String(a.ingress)) &&
        [
          "not_applicable",
          "connecting",
          "connected",
          "retrying",
          "disconnected",
        ].includes(String(a.connectivity)) &&
        typeof a.updatedAt === "string" &&
        Number.isFinite(Date.parse(a.updatedAt)) &&
        (a.attempt === undefined ||
          (typeof a.attempt === "number" &&
            Number.isInteger(a.attempt) &&
            a.attempt > 0)) &&
        (a.nextRetryAt === undefined ||
          (typeof a.nextRetryAt === "string" &&
            Number.isFinite(Date.parse(a.nextRetryAt)))) &&
        (a.errorType === undefined ||
          [
            "configuration_invalid",
            "connection_failed",
            "start_failed",
            "stop_failed",
          ].includes(String(a.errorType))),
    )
  );
}

/** 开发者只读请求；调用方必须提供 wire schema，禁止未校验 JSON 进入视图。 */
export async function getInspection<T>(
  config: GatewayConfig,
  path: string,
  schema: { parse(value: unknown): T },
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<T> {
  const response = await requestAuthenticatedJson(
    config,
    `/api/v1/inspection/${path}`,
    { method: "GET", signal, cache: "no-store" },
    fetchImplementation,
  );
  const payload = await readJson(response);
  if (!response.ok) {
    const error = isErrorResponse(payload) ? payload.error : undefined;
    throw new GatewayRequestError(
      error?.code === "inspection_unavailable"
        ? "Runtime 尚未就绪，暂时无法查看开发者数据"
        : `读取开发者数据失败（HTTP ${response.status}）`,
      error?.code ?? "inspection_failed",
      response.status,
    );
  }
  if (!isRecord(payload))
    throw new GatewayRequestError(
      "开发者数据格式无效",
      "invalid_inspection",
      response.status,
    );
  try {
    return schema.parse(payload.data);
  } catch {
    throw new GatewayRequestError(
      "开发者数据格式无效",
      "invalid_inspection",
      response.status,
    );
  }
}
