/**
 * 功能概述：作为 Server 与 Demo 共用的唯一 Runtime Composition 边界，组装业务 Catalog 与宿主批准的 Model Task 能力。
 * Memory 开启时加入缺省 writeback activation，关闭时移除写回实例；尊重已配置实例的禁用状态。
 * 主要职责：createMessageCatalog 加载模板并注入 Runtime kind/token，供运行时及数据库 kind 检查共用；
 * createMessageComposition 注入共享 token/definition，按 activation 设置批准 tier，
 * 并将 provider client 与模型解析器交给 Runtime 构造受控 ModelTaskClient；providerId/modelId
 * 作为复合身份写入审计数据并通过异步调用上下文选择模型，避免同名 model 跨 provider 串线；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：apps/server 与 apps/demo 直接导入 @kaguya/composition；本包位于 Runtime 之上，
 * 不负责数据库连接、HTTP、transport 注册或进程启停。从 loadFirstPartyPromptTemplates().messageComposer 读取模板，组合 agent.message-composer、
 * Runtime 通用生命周期与 LLM client；settings 只含 modelTier，投递目标由消息 intent 决定。
 * 输入输出与副作用：构造阶段无网络或连接；模型句柄按复合 key 存于宿主闭包，
 * Runtime 校验 activation/policy、重载因果 context 并写通用任务生命周期，模块经 context.use 调用。
 */
import {
  Mem0CognitionProvider,
  embeddingIdentityKey,
  type EmbeddingProvider,
  type MemoryCognitionProvider,
  type CognitionIdentity,
  memoryCognitionCapability,
} from "@kaguya/memory";
import {
  memoryIndexBootstrapCapability,
  memoryBackfillRequestedInformationKind,
} from "@kaguya/modules";
import { createCompatibleEmbeddingProvider } from "@kaguya/llm/embedding";
import type { MemoryConfig } from "@kaguya/config";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  KaguyaLlmClient,
  type KaguyaLlmGenerationOptions,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import {
  createFirstPartyModuleCatalog,
  createFirstPartyModuleActivations,
  messageComposerSettingsSchema,
  type FirstPartyModuleInstanceConfig,
  type ModuleModelSelection,
  type AgentIdentity,
} from "@kaguya/modules";
import { loadFirstPartyPromptTemplates } from "@kaguya/modules/prompt-templates/node";
import {
  modelTaskCapability,
  modelTaskCompletedInformationKind,
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
  readonly embedding?: EmbeddingProvider;
  readonly cognition?: MemoryCognitionProvider;
  readonly moduleConfigs: readonly FirstPartyModuleInstanceConfig[];
  readonly agentIdentity?: AgentIdentity;
}
export function createDeterministicModelSelectionResolver(): RuntimeModelSelectionResolver {
  const model = createRepeatingDeterministicModel({
    text: "It is a lovely night for watching the moon.",
  });
  return ({ modelTier }) => ({
    providerId: "kaguya-deterministic",
    modelId: `deterministic-${modelTier}`,
    model,
  });
}
export function createMessageCatalog(
  agentIdentity: AgentIdentity = DEFAULT_AGENT_IDENTITY,
  cognitionIdentity?: CognitionIdentity,
) {
  const promptTemplates = loadFirstPartyPromptTemplates();
  return createFirstPartyModuleCatalog({
    modelTaskCapability,
    modelTaskCompletedInformationKind,
    modelTaskFailedInformationKind,
    modelTaskCancelledInformationKind,
    deliveryDeliveredInformationKind,
    deliveryFailedInformationKind,
    executionExhaustedInformationKind,
    promptTemplates: promptTemplates.messageComposer,
    agentIdentity,
    ...(cognitionIdentity ? { cognitionIdentity } : {}),
  });
}
export function createMessageComposition(
  resolveModelSelection: RuntimeModelSelectionResolver = createDeterministicModelSelectionResolver(),
  options: MessageCompositionOptions,
) {
  const identity = options.agentIdentity ?? DEFAULT_AGENT_IDENTITY;
  const catalog = createMessageCatalog(
    identity,
    options.memoryEnabled ? options.cognition?.identity : undefined,
  );
  const memoryEnabled = options.memoryEnabled ?? false;
  const moduleConfigs = options.moduleConfigs.filter(
    (config) =>
      (memoryEnabled ||
        ![
          "agent.memory.writeback",
          "agent.memory.index",
          "agent.memory.cognition",
        ].includes(config.definitionId)) &&
      (options.embedding !== undefined ||
        config.definitionId !== "agent.memory.index") &&
      (options.cognition !== undefined ||
        config.definitionId !== "agent.memory.cognition"),
  );
  if (
    memoryEnabled &&
    !moduleConfigs.some(
      (config) => config.definitionId === "agent.memory.writeback",
    )
  ) {
    moduleConfigs.push({
      version: 1,
      instanceId: "memory-writeback.default",
      definitionId: "agent.memory.writeback",
      enabled: true,
      settings: {},
    });
  }
  if (
    memoryEnabled &&
    options.embedding &&
    !moduleConfigs.some(
      (config) => config.definitionId === "agent.memory.index",
    )
  )
    moduleConfigs.push({
      version: 1,
      instanceId: "memory-index.default",
      definitionId: "agent.memory.index",
      enabled: true,
      settings: {},
    });
  if (
    memoryEnabled &&
    options.cognition &&
    !moduleConfigs.some(
      (config) => config.definitionId === "agent.memory.cognition",
    )
  )
    moduleConfigs.push({
      version: 1,
      instanceId: "memory-cognition.default",
      definitionId: "agent.memory.cognition",
      enabled: true,
      settings: {},
    });
  const activations = createFirstPartyModuleActivations(
    catalog,
    moduleConfigs,
    identity,
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
    approvals: activations
      .filter(
        (activation) => activation.definitionId === "agent.message-composer",
      )
      .map((activation) => ({
        activation: {
          instanceId: activation.instanceId,
          definitionId: activation.definitionId,
        },
        selectionPolicy: {
          tier: messageComposerSettingsSchema.parse(activation.settings)
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
    catalog,
    activations,
    memory: {
      enabled: memoryEnabled,
      ...(memoryEnabled && options.embedding
        ? { embedding: options.embedding }
        : {}),
    },
    modelTask,
    capabilities: ({
      oneShotSchedule,
      core,
      now,
    }: RuntimeCapabilityContext) => [
      { capability: oneShotScheduleCapability, value: oneShotSchedule },
      ...(memoryEnabled && options.cognition
        ? [{ capability: memoryCognitionCapability, value: options.cognition }]
        : []),
      ...(memoryEnabled && options.embedding
        ? [
            {
              capability: memoryIndexBootstrapCapability,
              value: {
                requestBackfill: async (
                  identity: EmbeddingProvider["identity"],
                ) => {
                  await core.registerOnce(
                    "kaguya.memory.index.page.v1",
                    JSON.stringify([embeddingIdentityKey(identity), "root"]),
                    memoryBackfillRequestedInformationKind,
                    {
                      source: "composition:memory-index",
                      occurredAt: now().toISOString(),
                      payload: { identity, batchSize: 50, afterMemoryId: null },
                      references: [],
                    },
                  );
                },
              },
            },
          ]
        : []),
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
): Pick<
  MessageCompositionOptions,
  "memoryEnabled" | "embedding" | "cognition"
> {
  if (!memory.enabled) return { memoryEnabled: false };
  return {
    memoryEnabled: true,
    ...(memory.embedding
      ? { embedding: createCompatibleEmbeddingProvider(memory.embedding) }
      : {}),
    ...(memory.cognition
      ? { cognition: new Mem0CognitionProvider(memory.cognition) }
      : {}),
  };
}
