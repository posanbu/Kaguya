/**
 * 架构说明：本模块是 Web 端 Profile 表单与完整 Profile 文档之间的
 * 客户端保全边界。它把可见的名称、URL、API Key、轻重模型、网关白名单与
 * “暂不配置平台和插件”的确认态，转换成完整替换 Profile 时所需的 wire payload，
 * 并在这个过程中原样保留所有未在表单里出现的 provider、platform、
 * plugin、credentials 和嵌套 settings。
 * 主要职责：`profileToEditorFields` 从现有 Profile 提取表单字段；
 * `mergeProfileEditorFields` 基于表单字段产生完整的 `ReplaceProfileInput`，
 * 复用现有 OpenAI-compatible provider，必要时补出 `default-provider`，
 * 并且绝不丢失隐藏集合。这个模块是纯函数层，方便 Task 7 的页面代码
 * 直接消费，而不需要把保存逻辑塞回组件树里。
 * 代码库关系：它依赖 `@kaguya/config` 的 Profile 类型作为输入约束，
 * 输出则与服务器 `/api/v1/profiles/:profileId` 的 replace body 对齐。
 * 每个 tier 的硬超时以秒展示、毫秒持久化；空值使用 LLM 默认 300 秒，非法输入阻止保存。
 * 输入输出与副作用：函数只处理内存对象；实现必须克隆数组和对象，
 * 不能修改传入的 profile 引用，也不能偷偷删减未展示字段。
 */
import type { ReplaceProfileInput, UserConfigProfile } from "./api.js";

const DEFAULT_PROVIDER_ID = "default-provider";
const OPENAI_COMPATIBLE_PROVIDER_TYPE = "openai-compatible";

interface MutableProfile {
  name: string;
  identity: {
    name: string;
    aliases: string[];
    persona: string;
  };
  gatewayAllowlist: string[];
  ai: {
    defaultProviderId?: string;
    modelTiers?: {
      light: {
        providerId: string;
        modelId: string;
        generation?: MutableGenerationOptions;
        recommendedDurationMs?: number;
      };
      heavy: {
        providerId: string;
        modelId: string;
        generation?: MutableGenerationOptions;
        recommendedDurationMs?: number;
      };
    };
    providers: MutableProvider[];
  };
  memory: {
    enabled: boolean;
  };
  platforms: MutablePlatform[];
  review?: {
    acknowledgedWarnings: string[];
  };
}

interface MutableGenerationOptions {
  timeoutMs?: number;
  reasoning?:
    | "provider-default"
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
}

interface MutableProvider {
  id: string;
  type: string;
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  settings: Record<string, unknown>;
}

interface MutablePlatform {
  id: string;
  type: string;
  enabled: boolean;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface ProfileEditorFields {
  readonly name: string;
  readonly agentName: string;
  readonly agentAliasesText: string;
  readonly agentPersona: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly lightModel: string;
  readonly lightTimeoutSeconds: string;
  readonly heavyTimeoutSeconds: string;
  readonly heavyModel: string;
  readonly lightThinkingEnabled: boolean;
  readonly lightReasoningEffort: string;
  readonly lightRecommendedDurationMs: string;
  readonly heavyThinkingEnabled: boolean;
  readonly heavyReasoningEffort: string;
  readonly heavyRecommendedDurationMs: string;
  readonly gatewayAllowlistText: string;
  readonly memoryEnabled: boolean;
}

export function profileToEditorFields(
  profile: UserConfigProfile,
): ProfileEditorFields {
  const provider = findEditableProvider(profile);
  return {
    name: profile.name,
    agentName: profile.identity.name,
    agentAliasesText: profile.identity.aliases.join("\n"),
    agentPersona: profile.identity.persona,
    baseUrl: provider?.baseUrl ?? "",
    apiKey: provider?.apiKey ?? "",
    lightModel:
      profile.ai.modelTiers?.light.modelId ?? provider?.models[0] ?? "",
    heavyModel:
      profile.ai.modelTiers?.heavy.modelId ??
      provider?.models[1] ??
      provider?.models[0] ??
      "",
    lightTimeoutSeconds: String(
      (profile.ai.modelTiers?.light.generation?.timeoutMs ?? 300_000) / 1000,
    ),
    heavyTimeoutSeconds: String(
      (profile.ai.modelTiers?.heavy.generation?.timeoutMs ?? 300_000) / 1000,
    ),
    lightThinkingEnabled:
      profile.ai.modelTiers?.light.generation?.reasoning !== "none",
    lightReasoningEffort: reasoningEffort(
      profile.ai.modelTiers?.light.generation?.reasoning,
    ),
    lightRecommendedDurationMs: optionalNumberText(
      profile.ai.modelTiers?.light.recommendedDurationMs ?? 2_000,
    ),
    heavyThinkingEnabled:
      profile.ai.modelTiers?.heavy.generation?.reasoning !== "none",
    heavyReasoningEffort: reasoningEffort(
      profile.ai.modelTiers?.heavy.generation?.reasoning,
    ),
    heavyRecommendedDurationMs: optionalNumberText(
      profile.ai.modelTiers?.heavy.recommendedDurationMs ?? 5_000,
    ),
    gatewayAllowlistText: profile.gatewayAllowlist.join("\n"),
    memoryEnabled: profile.memory.enabled,
  };
}

export function mergeProfileEditorFields(
  profile: UserConfigProfile,
  fields: ProfileEditorFields,
): ReplaceProfileInput {
  const next = structuredClone(profile) as unknown as MutableProfile;
  const provider = ensureEditableProvider(next, fields);

  next.name = fields.name;
  next.identity = {
    name: fields.agentName.trim(),
    aliases: [
      ...new Set(
        fields.agentAliasesText
          .split(/\r?\n/u)
          .map((alias) => alias.trim())
          .filter(Boolean),
      ),
    ],
    persona: fields.agentPersona.trim(),
  };
  next.memory.enabled = fields.memoryEnabled;
  next.gatewayAllowlist = fields.gatewayAllowlistText
    .split(/\r?\n/u)
    .map((rule) => rule.trim())
    .filter(Boolean);
  provider.baseUrl = fields.baseUrl;
  provider.apiKey = fields.apiKey;
  provider.models = [fields.lightModel, fields.heavyModel];
  next.ai.defaultProviderId = provider.id;
  next.ai.modelTiers = {
    light: {
      providerId: provider.id,
      modelId: fields.lightModel,
      ...tierOptions(fields, "light"),
    },
    heavy: {
      providerId: provider.id,
      modelId: fields.heavyModel,
      ...tierOptions(fields, "heavy"),
    },
  };

  return {
    name: next.name,
    gatewayAllowlist: next.gatewayAllowlist,
    identity: next.identity,
    acknowledgedWarnings: computeAcknowledgedWarnings(next),
    ai: next.ai as ReplaceProfileInput["ai"],
    memory: next.memory,
    platforms: next.platforms,
  };
}

function optionalNumberText(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function optionalPositiveInteger(value: string): number | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function reasoningEffort(value: string | undefined): string {
  return value === undefined || value === "none" ? "provider-default" : value;
}

function tierOptions(
  fields: ProfileEditorFields,
  tier: "light" | "heavy",
): Partial<
  Pick<
    NonNullable<MutableProfile["ai"]["modelTiers"]>["light"],
    "generation" | "recommendedDurationMs"
  >
> {
  const prefix = tier === "light" ? "light" : "heavy";
  const thinkingEnabled = fields[`${prefix}ThinkingEnabled`];
  const reasoningEffort = fields[`${prefix}ReasoningEffort`];
  const recommendedDurationMs = optionalPositiveInteger(
    fields[`${prefix}RecommendedDurationMs`],
  );
  const timeoutText = fields[`${prefix}TimeoutSeconds`].trim();
  const timeoutMs =
    timeoutText === "" ? undefined : Math.round(Number(timeoutText) * 1000);
  if (
    timeoutMs !== undefined &&
    (!/^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/u.test(timeoutText) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000)
  ) {
    throw new Error("模型超时必须在 0.001–300 秒之间，最多保留三位小数。");
  }
  const generation: MutableGenerationOptions = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(!thinkingEnabled
      ? { reasoning: "none" as const }
      : reasoningEffort !== "provider-default" && isReasoning(reasoningEffort)
        ? { reasoning: reasoningEffort }
        : {}),
  };
  return {
    ...(Object.keys(generation).length === 0 ? {} : { generation }),
    ...(recommendedDurationMs === undefined ? {} : { recommendedDurationMs }),
  };
}

function isReasoning(
  value: string,
): value is NonNullable<MutableGenerationOptions["reasoning"]> {
  return [
    "provider-default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ].includes(value);
}

function findEditableProvider(profile: UserConfigProfile) {
  const preferredId = profile.ai.defaultProviderId;
  const preferredProvider = profile.ai.providers.find(
    (provider) =>
      provider.id === preferredId &&
      provider.type === OPENAI_COMPATIBLE_PROVIDER_TYPE,
  );
  if (preferredProvider !== undefined) {
    return preferredProvider;
  }
  return profile.ai.providers.find(
    (provider) => provider.type === OPENAI_COMPATIBLE_PROVIDER_TYPE,
  );
}

function ensureEditableProvider(
  profile: MutableProfile,
  fields: ProfileEditorFields,
) {
  const preferredIndex = profile.ai.providers.findIndex(
    (provider) =>
      provider.id === profile.ai.defaultProviderId &&
      provider.type === OPENAI_COMPATIBLE_PROVIDER_TYPE,
  );
  if (preferredIndex >= 0) {
    return profile.ai.providers[preferredIndex]!;
  }

  const fallbackIndex = profile.ai.providers.findIndex(
    (provider) => provider.type === OPENAI_COMPATIBLE_PROVIDER_TYPE,
  );
  if (fallbackIndex >= 0) {
    return profile.ai.providers[fallbackIndex]!;
  }

  const provider: MutableProvider = {
    id: DEFAULT_PROVIDER_ID,
    type: OPENAI_COMPATIBLE_PROVIDER_TYPE,
    enabled: true,
    baseUrl: fields.baseUrl,
    apiKey: fields.apiKey,
    models: [fields.lightModel, fields.heavyModel],
    settings: {},
  };
  profile.ai.providers.push(structuredClone(provider));
  return profile.ai.providers[profile.ai.providers.length - 1]!;
}

function computeAcknowledgedWarnings(profile: MutableProfile): string[] {
  const currentWarnings = deriveWarningIds(profile);
  const warnings = new Set<string>();
  for (const warningId of profile.review?.acknowledgedWarnings ?? []) {
    if (!currentWarnings.has(warningId)) {
      continue;
    }
    warnings.add(warningId);
  }
  return [...warnings];
}

function deriveWarningIds(profile: MutableProfile): Set<string> {
  const warnings = new Set<string>();
  for (const provider of profile.ai.providers) {
    if (!provider.enabled) {
      continue;
    }
    if (isMissingString(provider.baseUrl)) {
      warnings.add(`provider-base-url-missing:${provider.id}`);
    }
    if (isMissingString(provider.apiKey)) {
      warnings.add(`provider-api-key-missing:${provider.id}`);
    }
  }
  return warnings;
}

function isMissingString(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}
