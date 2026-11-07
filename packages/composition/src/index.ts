/**
 * 模型对象直接保存在各自异步上下文，避免同 provider/model id 的路由覆盖；非秘密 descriptor 与 generationOptions 生成稳定摘要。
 * 按 QQ 表情实例实际开关装配草稿处理器并批准其 light 模型任务，非 QQ 和禁用路径保持原行为。
 * 模板加载器统一选择所有模块的 default/local 正文；Catalog 注入 Light、Heavy 和 Expression，授权正文渲染器注入 Runtime。
 * nativeTaskModels 只为明确任务提供独立宿主路由；nativeMemoryTools 显式安装 Heavy 的 Memory 工具。
 * 功能概述：作为 Server 与 Demo 共用的唯一 Runtime Composition 边界，组装业务 Catalog 与宿主批准的 Model Task 能力。
 * 记忆开关控制 memory.native，关闭时普通对话继续运行。
 * Router 与 Heavy 同时注入宿主目标授权能力；自然语言跨会话自动校验，管理端路径仍需正文确认。
 * 主要职责：createMessageCatalog 加载模板并注入 Runtime kind/token，供运行时及数据库 kind 检查共用；
 * createMessageComposition 注入共享 token/definition，按 activation 设置批准 tier，
 * 并将 provider client 与模型解析器交给 Runtime 构造受控 ModelTaskClient；providerId/modelId
 * 作为复合身份写入审计数据并通过异步调用上下文选择模型，避免同名 model 跨 provider 串线；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：apps/server 与 apps/demo 直接导入 @kaguya/composition；本包位于 Runtime 之上，
 * 不负责数据库连接、HTTP、transport 注册或进程启停。从 loadFirstPartyPromptTemplates().heavy 读取模板，组合 agent.heavy、
 * Router 内部 Light 与 Runtime 通用生命周期、LLM client；Light、Heavy 档位固定，投递目标由消息 intent 决定。
 * 输入输出与副作用：构造阶段无网络或连接；模型句柄存于各请求的异步上下文，
 * Runtime 校验 activation/policy、重载因果 context 并写通用任务生命周期，模块经 context.use 调用。
 */
import { createHash } from "node:crypto";
import {
  lifecycleStartupCapability,
  lifecycleStartedInformationKind,
} from "@kaguya/modules";

/**
 * 按 QQ 表情实例实际开关装配草稿处理器并批准其 light 模型任务，非 QQ 和禁用路径保持原行为。
 * 模板加载器统一选择所有模块的 default/local 正文；Catalog 注入 Light、Heavy 和 Expression，授权正文渲染器注入 Runtime。
 * 功能概述：作为 Server 与 Demo 共用的唯一 Runtime Composition 边界，组装业务 Catalog 与宿主批准的 Model Task 能力。
 * 记忆开关控制 memory.native，关闭时普通对话继续运行。
 * Router 与 Heavy 同时注入宿主目标授权能力；自然语言跨会话自动校验，管理端路径仍需正文确认。
 * 主要职责：createMessageCatalog 加载模板并注入 Runtime kind/token，供运行时及数据库 kind 检查共用；
 * createMessageComposition 注入共享 token/definition，按 activation 设置批准 tier，
 * 并将 provider client 与模型解析器交给 Runtime 构造受控 ModelTaskClient；providerId/modelId
 * 作为复合身份写入审计数据并通过异步调用上下文选择模型，避免同名 model 跨 provider 串线；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：apps/server 与 apps/demo 直接导入 @kaguya/composition；本包位于 Runtime 之上，
 * 不负责数据库连接、HTTP、transport 注册或进程启停。从 loadFirstPartyPromptTemplates().heavy 读取模板，组合 agent.heavy、
 * Router 内部 Light 与 Runtime 通用生命周期、LLM client；Light、Heavy 档位固定，投递目标由消息 intent 决定。
 * 输入输出与副作用：构造阶段无网络或连接；模型句柄存于各请求的异步上下文，
 * Runtime 校验 activation/policy、重载因果 context 并写通用任务生命周期，模块经 context.use 调用。
 */
import {
  memoryConfigSchema,
  type MemoryConfig,
  type UserConfigProfile,
} from "@kaguya/config";
import {
  rawContextCapability,
  nativeMemoryCapability,
  nativeMemorySettingsSchema,
  type NativeEmbeddingSource,
} from "@kaguya/memory";
import { createCompatibleEmbeddingProvider } from "@kaguya/llm/embedding";
export { CordisAssembly } from "./cordis-assembly.js";
export {
  loadModulePlugins,
  type ModulePluginSnapshot,
} from "./module-plugins.js";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  KaguyaLlmClient,
  type KaguyaLlmGenerationOptions,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import {
  createPlanningDeterministicModel,
  createRepeatingDeterministicModel,
} from "@kaguya/llm/testing";
import {
  createAuthorizedMessagePromptRenderer,
  messageAuthorizationCapability,
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  type FirstPartyModuleInstanceConfig,
  type ModuleModelSelection,
  type AgentIdentity,
} from "@kaguya/modules";
import { loadFirstPartyPromptTemplates } from "@kaguya/modules/prompt-templates/node";
import { loadStructuredOutputPromptRenderer } from "@kaguya/llm/prompt-templates/node";
import {
  modelTaskCapability,
  modelTaskCompletedInformationKind,
  modelTaskRequestedInformationKind,
  modelTaskFailedInformationKind,
  modelTaskCancelledInformationKind,
  deliveryDeliveredInformationKind,
  deliveryFailedInformationKind,
  executionExhaustedInformationKind,
  type RuntimeModelTaskOptions,
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import { oneShotScheduleCapability } from "@kaguya/scheduler";
import { DEFAULT_AGENT_IDENTITY } from "@kaguya/config";
export type RuntimeModelSelectionResolver = (
  selection: ModuleModelSelection,
) => {
  readonly providerId: string;
  readonly modelId: string;
  readonly model: ReturnType<KaguyaLlmModelResolver>;
  readonly generationOptions?: KaguyaLlmGenerationOptions;
  /** 显式非秘密配置身份；不得包含凭据、SDK 对象或任意 provider settings。 */
  readonly configuration?: {
    adapter: string;
    protocol: string;
    endpoint: string;
    revision: string;
  };
};
export interface NativeTaskModelRoute {
  readonly definitionId: string;
  readonly taskId: string;
  readonly routeId: string;
  readonly tier: "light" | "heavy";
  readonly resolve: () => ReturnType<RuntimeModelSelectionResolver>;
}
export interface MessageCompositionOptions {
  /** 仅宿主配置，工具目录与授权不可从模型输出或 MCP annotations 推导。 */
  readonly nativeMemoryTools?: boolean;
  readonly nativeTools?: import("@kaguya/runtime").NativeToolLoopOptions;
  readonly nativeTaskModels?: readonly NativeTaskModelRoute[];
  readonly ai?: UserConfigProfile["ai"];
  readonly pluginModelTasks?: Readonly<Record<string, "light" | "heavy">>;
  readonly memoryEnabled?: boolean;
  readonly moduleConfigs: readonly FirstPartyModuleInstanceConfig[];
  readonly agentIdentity?: Pick<AgentIdentity, "timeZone">;
  readonly catalog?: ReturnType<typeof createMessageCatalog>;
}
export interface MemoryFeatureState {
  enabled: boolean;
}
export function createDeterministicModelSelectionResolver(): RuntimeModelSelectionResolver {
  const lightModel = createPlanningDeterministicModel(
    "It is a lovely night for watching the moon.",
  );
  const heavyModel = createRepeatingDeterministicModel({
    action: "message",
    text: "It is a lovely night for watching the moon.",
  });
  return ({ modelTier }) => ({
    providerId: "kaguya-deterministic",
    modelId: `deterministic-${modelTier}`,
    model: modelTier === "light" ? lightModel : heavyModel,
    configuration: {
      adapter: "deterministic",
      protocol: "local",
      endpoint: "local",
      revision: "1",
    },
  });
}
export function createMessageCatalog(
  configuredIdentity: Pick<AgentIdentity, "timeZone"> = DEFAULT_AGENT_IDENTITY,
  promptTemplates = loadFirstPartyPromptTemplates(),
  qqExpressionEnabled = false,
) {
  const agentIdentity: AgentIdentity = {
    name: promptTemplates.identityName,
    aliases: promptTemplates.identityAliases,
    persona: promptTemplates.identityPersona,
    timeZone: configuredIdentity.timeZone,
  };
  return createFirstPartyModuleCatalog({
    rawContextCapability,
    nativeMemoryCapability,
    messageAuthorizationCapability,
    modelTaskCapability,
    modelTaskCompletedInformationKind,
    modelTaskRequestedInformationKind,
    modelTaskFailedInformationKind,
    modelTaskCancelledInformationKind,
    deliveryDeliveredInformationKind,
    deliveryFailedInformationKind,
    executionExhaustedInformationKind,
    promptTemplates: promptTemplates.heavy,
    lightTemplate: promptTemplates.light,
    lightBootstrapPolicy: promptTemplates.lightBootstrapPolicy,
    lightPlatformPolicies: promptTemplates.lightPlatformPolicies,

    nativeMemoryTemplate: promptTemplates.nativeMemory,
    qqExpressionTemplates: promptTemplates.qqExpression,
    qqExpressionEnabled,
    agentIdentity,
  });
}
export function createMessageComposition(
  resolveModelSelection: RuntimeModelSelectionResolver = createDeterministicModelSelectionResolver(),
  options: MessageCompositionOptions,
) {
  const identity = options.agentIdentity ?? DEFAULT_AGENT_IDENTITY;
  const promptTemplates = loadFirstPartyPromptTemplates();
  const runtimeIdentity: AgentIdentity = {
    name: promptTemplates.identityName,
    aliases: promptTemplates.identityAliases,
    persona: promptTemplates.identityPersona,
    timeZone: identity.timeZone,
  };
  const renderStructuredOutputPrompt = loadStructuredOutputPromptRenderer();
  const memoryEnabled =
    (options.memoryEnabled ?? false) &&
    options.moduleConfigs.some(
      (c) => c.definitionId === "memory.native" && c.enabled,
    );
  const memoryFeatureState: MemoryFeatureState = { enabled: memoryEnabled };
  const catalog =
    options.catalog ??
    createMessageCatalog(
      identity,
      promptTemplates,
      options.moduleConfigs.some(
        (c) => c.definitionId === "plugin.qq-expression" && c.enabled,
      ),
    );
  const moduleConfigs = options.moduleConfigs.filter(
    (config) =>
      (memoryEnabled || config.definitionId !== "memory.native") &&
      (config.enabled ||
        catalog.definitions.some(
          ({ manifest }) => manifest.definitionId === config.definitionId,
        ) ||
        config.definitionId.startsWith("adapter.")),
  );
  const activations = createFirstPartyModuleActivations(
    catalog,
    moduleConfigs,
    runtimeIdentity,
  );
  const activeModel = new AsyncLocalStorage<{
    readonly identity: {
      readonly providerId: string;
      readonly modelId: string;
    };
    readonly generationOptions: KaguyaLlmGenerationOptions;
    readonly model: ReturnType<KaguyaLlmModelResolver>;
  }>();
  const routes = new Map(
    (options.nativeTaskModels ?? []).map((r) => [r.routeId, r]),
  );
  if (routes.size !== (options.nativeTaskModels ?? []).length)
    throw new Error("Duplicate task model route");
  if (options.nativeMemoryTools && !memoryEnabled)
    throw new Error("Native Memory tools require enabled Memory");
  const nativeTools =
    options.nativeTools ??
    (options.nativeMemoryTools
      ? {
          memory: true,
          registrations: [],
          tasks: [
            {
              taskId: "agent.heavy.respond",
              definitionId: "agent.heavy",
              toolIds: [
                "memory.query",
                "memory.read",
                "memory.history",
                "memory.correct",
                "memory.record",
              ],
            },
          ],
        }
      : undefined);
  const modelTask: RuntimeModelTaskOptions = {
    renderStructuredOutputPrompt,
    approvals: [
      ...activations
        .filter(
          (activation) =>
            [
              "agent.heavy",
              "agent.router",
              "agent.situation",
              "memory.native",
              "plugin.qq-expression",
            ].includes(activation.definitionId) ||
            options.pluginModelTasks?.[activation.definitionId] !== undefined,
        )
        .map((activation) => ({
          activation: {
            instanceId: activation.instanceId,
            definitionId: activation.definitionId,
          },
          selectionPolicy: {
            tier:
              options.pluginModelTasks?.[activation.definitionId] ??
              (activation.definitionId === "agent.heavy" ? "heavy" : "light"),
          },
        })),
      ...activations.flatMap((activation) =>
        (options.nativeTaskModels ?? [])
          .filter((r) => r.definitionId === activation.definitionId)
          .map((r) => ({
            activation: {
              instanceId: activation.instanceId,
              definitionId: activation.definitionId,
            },
            taskId: r.taskId,
            selectionPolicy: { tier: r.tier, routeId: r.routeId },
          })),
      ),
    ],
    client: new KaguyaLlmClient({
      resolveModel: ({ modelId }) => {
        const active = activeModel.getStore();
        if (active === undefined || active.identity.modelId !== modelId)
          throw new Error("Unapproved model");
        return active.model;
      },
      resolveGenerationOptions: () =>
        activeModel.getStore()?.generationOptions ?? {},
    }),
    resolveModel: ({ tier, routeId }) => {
      const route = routeId ? routes.get(routeId) : undefined;
      if (routeId && (!route || route.tier !== tier))
        throw new Error("Unapproved task model route");
      const resolved = route
        ? route.resolve()
        : resolveModelSelection({ modelTier: tier });
      const options = resolved.generationOptions ?? {};
      const generationOptions: KaguyaLlmGenerationOptions = Object.freeze({
        ...(options.structuredOutputMode === undefined
          ? {}
          : { structuredOutputMode: options.structuredOutputMode }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...(options.reasoning === undefined
          ? {}
          : { reasoning: options.reasoning }),
        ...(options.recommendedDurationMs === undefined
          ? {}
          : { recommendedDurationMs: options.recommendedDurationMs }),
      });
      const identity = {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        ...(resolved.configuration
          ? {
              configurationDigest: createHash("sha256")
                .update(
                  stableModelConfiguration({
                    configuration: resolved.configuration,
                    generationOptions,
                  }),
                )
                .digest("hex"),
            }
          : {}),
      };
      activeModel.enterWith({
        identity,
        model: resolved.model,
        generationOptions,
      });
      return identity;
    },
  };
  return {
    memoryFeatureState,
    authorizedMessagePromptRenderer: createAuthorizedMessagePromptRenderer(
      promptTemplates.authorizedMessage,
    ),
    catalog,
    activations,
    memory: {
      enabled: memoryEnabled,
      embeddings: memoryEnabled ? nativeEmbeddings(options) : [],
    },
    modelTask,
    ...(nativeTools ? { nativeTools } : {}),
    capabilities: ({
      oneShotSchedule,
      core,
      now,
    }: RuntimeCapabilityContext) => [
      { capability: oneShotScheduleCapability, value: oneShotSchedule },
      {
        capability: lifecycleStartupCapability,
        value: {
          start: async (instanceId: string) => {
            await core.register(lifecycleStartedInformationKind, {
              occurredAt: now().toISOString(),
              source: `module:${instanceId}`,
              payload: { instanceId, at: now().toISOString() },
              references: [],
            });
          },
        },
      },
    ],
  };
}

/** 只序列化宿主声明的非秘密字段，使键顺序不影响冻结配置身份。 */
function stableModelConfiguration(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableModelConfiguration).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableModelConfiguration(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** 只从宿主已经校验的 selected Profile 构造 provider；关闭态不读取凭据或创建客户端。 */
export function createMemoryCompositionOptions(
  memory: MemoryConfig,
): Pick<MessageCompositionOptions, "memoryEnabled"> {
  return { memoryEnabled: memory.enabled };
}

/** Derive raw Memory's runtime state from its global instance. */
export function memoryConfigFromModules(
  configs: readonly FirstPartyModuleInstanceConfig[],
): MemoryConfig {
  return memoryConfigSchema.parse({
    enabled: configs.some(
      (config) => config.definitionId === "memory.native" && config.enabled,
    ),
  });
}

function nativeEmbeddings(
  options: MessageCompositionOptions,
): NativeEmbeddingSource[] {
  const settings = nativeMemorySettingsSchema.parse(
    options.moduleConfigs.find((c) => c.definitionId === "memory.native")
      ?.settings ?? {},
  );
  return (["semantic", "language"] as const).flatMap((role) => {
    const config =
      role === "semantic"
        ? settings.semanticEmbedding
        : settings.languageEmbedding;
    if (!config.enabled) return [];
    const provider = options.ai?.providers.find(
      (p) => p.id === config.providerId && p.enabled,
    );
    if (
      !provider ||
      provider.type !== "openai-compatible" ||
      !provider.apiKey ||
      !provider.baseUrl ||
      !config.modelId ||
      !config.revision
    )
      throw new Error(`Memory ${role} embedding configuration is incomplete`);
    return [
      {
        role,
        timeoutMs: config.timeoutMs,
        provider: createCompatibleEmbeddingProvider({
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          modelId: config.modelId,
          revision: config.revision,
          dimensions: config.dimensions,
        }),
      },
    ];
  });
}
