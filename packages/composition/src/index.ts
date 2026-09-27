/**
 * 按 QQ 表情实例实际开关装配草稿处理器并批准其 light 模型任务，非 QQ 和禁用路径保持原行为。
 * 模板加载器统一选择所有模块的 default/local 正文；Catalog 注入 Planner、Composer 和 Expression，授权正文渲染器注入 Runtime。
 * 功能概述：作为 Server 与 Demo 共用的唯一 Runtime Composition 边界，组装业务 Catalog 与宿主批准的 Model Task 能力。
 * 原始记忆开启时激活 memory.raw，关闭时移除该实例；未完成模块没有实例。
 * Heartflow 与 Composer 同时注入宿主目标授权能力；自然语言跨会话自动校验，管理端路径仍需正文确认。
 * 主要职责：createMessageCatalog 加载模板并注入 Runtime kind/token，供运行时及数据库 kind 检查共用；
 * createMessageComposition 注入共享 token/definition，按 activation 设置批准 tier，
 * 并将 provider client 与模型解析器交给 Runtime 构造受控 ModelTaskClient；providerId/modelId
 * 作为复合身份写入审计数据并通过异步调用上下文选择模型，避免同名 model 跨 provider 串线；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：apps/server 与 apps/demo 直接导入 @kaguya/composition；本包位于 Runtime 之上，
 * 不负责数据库连接、HTTP、transport 注册或进程启停。从 loadFirstPartyPromptTemplates().messageComposer 读取模板，组合 agent.message-composer、
 * Heartflow Planner（light）与 Runtime 通用生命周期、LLM client；settings 只含 modelTier，投递目标由消息 intent 决定。
 * 输入输出与副作用：构造阶段无网络或连接；模型句柄按复合 key 存于宿主闭包，
 * Runtime 校验 activation/policy、重载因果 context 并写通用任务生命周期，模块经 context.use 调用。
 */
import { memoryConfigSchema, type MemoryConfig } from "@kaguya/config";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  KaguyaLlmClient,
  type KaguyaLlmGenerationOptions,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import { createPlanningDeterministicModel } from "@kaguya/llm/testing";
import {
  createAuthorizedMessagePromptRenderer,
  messageAuthorizationCapability,
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  messageComposerSettingsSchema,
  type FirstPartyModuleInstanceConfig,
  type ModuleModelSelection,
  type AgentIdentity,
  type ActivePersonProfiles,
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
};
export interface MessageCompositionOptions {
  readonly memoryEnabled?: boolean;
  readonly moduleConfigs: readonly FirstPartyModuleInstanceConfig[];
  readonly agentIdentity?: Pick<AgentIdentity, "timeZone">;
  readonly activePersonProfiles?: ActivePersonProfiles;
}
export interface MemoryFeatureState {
  enabled: boolean;
}
export function createDeterministicModelSelectionResolver(): RuntimeModelSelectionResolver {
  const model = createPlanningDeterministicModel(
    "It is a lovely night for watching the moon.",
  );
  return ({ modelTier }) => ({
    providerId: "kaguya-deterministic",
    modelId: `deterministic-${modelTier}`,
    model,
  });
}
export function createMessageCatalog(
  configuredIdentity: Pick<AgentIdentity, "timeZone"> = DEFAULT_AGENT_IDENTITY,
  promptTemplates = loadFirstPartyPromptTemplates(),
  qqExpressionEnabled = false,
  activePersonProfiles?: ActivePersonProfiles,
) {
  const agentIdentity: AgentIdentity = {
    name: promptTemplates.identityName,
    aliases: promptTemplates.identityAliases,
    persona: promptTemplates.identityPersona,
    timeZone: configuredIdentity.timeZone,
  };
  return createFirstPartyModuleCatalog({
    messageAuthorizationCapability,
    modelTaskCapability,
    modelTaskCompletedInformationKind,
    modelTaskRequestedInformationKind,
    modelTaskFailedInformationKind,
    modelTaskCancelledInformationKind,
    deliveryDeliveredInformationKind,
    deliveryFailedInformationKind,
    executionExhaustedInformationKind,
    promptTemplates: promptTemplates.messageComposer,
    plannerTemplate: promptTemplates.planner,
    plannerBootstrapPolicy: promptTemplates.plannerBootstrapPolicy,
    plannerPlatformPolicies: promptTemplates.plannerPlatformPolicies,
    expressionTemplates: promptTemplates.expression,
    qqExpressionTemplates: promptTemplates.qqExpression,
    qqExpressionEnabled,
    agentIdentity,
    ...(activePersonProfiles ? { activePersonProfiles } : {}),
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
  const memoryFeatureState: MemoryFeatureState = {
    enabled: options.memoryEnabled ?? false,
  };
  const catalog = createMessageCatalog(
    identity,
    promptTemplates,
    options.moduleConfigs.some(
      (c) => c.definitionId === "plugin.qq-expression" && c.enabled,
    ),
    options.activePersonProfiles,
  );
  const memoryEnabled = options.memoryEnabled ?? false;
  const moduleConfigs = options.moduleConfigs.filter(
    (config) => memoryEnabled || config.definitionId !== "memory.raw",
  );
  const activations = createFirstPartyModuleActivations(
    catalog,
    moduleConfigs,
    runtimeIdentity,
  );
  const models = new Map<string, ReturnType<KaguyaLlmModelResolver>>();
  const activeModel = new AsyncLocalStorage<{
    readonly identity: {
      readonly providerId: string;
      readonly modelId: string;
    };
    readonly generationOptions: KaguyaLlmGenerationOptions;
  }>();
  const modelTask: RuntimeModelTaskOptions = {
    renderStructuredOutputPrompt,
    approvals: activations
      .filter((activation) =>
        [
          "agent.message-composer",
          "agent.heartflow.online",
          "memory.expression",
          "plugin.qq-expression",
        ].includes(activation.definitionId),
      )
      .map((activation) => ({
        activation: {
          instanceId: activation.instanceId,
          definitionId: activation.definitionId,
        },
        selectionPolicy: {
          tier:
            activation.definitionId !== "agent.message-composer"
              ? "light"
              : messageComposerSettingsSchema.parse(activation.settings)
                  .modelTier,
        },
      })),
    client: new KaguyaLlmClient({
      resolveModel: ({ modelId }) => {
        const active = activeModel.getStore();
        if (active === undefined || active.identity.modelId !== modelId)
          throw new Error("Unapproved model");
        const model = models.get(modelIdentityKey(active.identity));
        if (model === undefined) throw new Error("Unapproved model");
        return model;
      },
      resolveGenerationOptions: () =>
        activeModel.getStore()?.generationOptions ?? {},
    }),
    resolveModel: ({ tier }) => {
      const resolved = resolveModelSelection({ modelTier: tier });
      const identity = {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
      };
      models.set(modelIdentityKey(identity), resolved.model);
      activeModel.enterWith({
        identity,
        generationOptions: resolved.generationOptions ?? {},
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
    memory: { enabled: memoryEnabled },
    modelTask,
    capabilities: ({ oneShotSchedule }: RuntimeCapabilityContext) => [
      { capability: oneShotScheduleCapability, value: oneShotSchedule },
    ],
  };
}

function modelIdentityKey(identity: {
  readonly providerId: string;
  readonly modelId: string;
}): string {
  return JSON.stringify([identity.providerId, identity.modelId]);
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
      (config) => config.definitionId === "memory.raw" && config.enabled,
    ),
  });
}
