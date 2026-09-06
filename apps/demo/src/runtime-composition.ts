/**
 * 功能概述：在显式 composition root 选择业务 Catalog 与宿主批准的 Model Task 能力。
 * 主要职责：createReplyComposition 注入共享 token/definition，按 activation 设置批准 tier，
 * 并将 provider client 与模型解析器交给 Runtime 构造受控 ModelTaskClient；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：组合 modules、Runtime 通用生命周期与 LLM client，Runtime 本身不认识回复策略。
 * 输入输出与副作用：构造阶段无网络或连接；模型句柄仅存于宿主闭包，
 * Runtime 校验 activation/policy、重载因果 context 并写通用任务生命周期，模块经 context.use 调用。
 */
import {
  KaguyaLlmClient,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import {
  createFirstPartyModuleCatalog,
  firstPartyModuleActivations,
  llmReplySettingsSchema,
  type ModuleModelSelection,
} from "@kaguya/modules";
import {
  modelTaskCapability,
  modelTaskCompletedInformationKind,
  type RuntimeModelTaskOptions,
} from "@kaguya/runtime";
export type RuntimeModelSelectionResolver = (
  selection: ModuleModelSelection,
) => {
  readonly modelId: string;
  readonly model: ReturnType<KaguyaLlmModelResolver>;
};
export function createDeterministicModelSelectionResolver(): RuntimeModelSelectionResolver {
  const model = createRepeatingDeterministicModel({
    text: "It is a lovely night for watching the moon.",
  });
  return ({ modelTier }) => ({ modelId: `deterministic-${modelTier}`, model });
}
export function createReplyComposition(
  resolveModelSelection: RuntimeModelSelectionResolver = createDeterministicModelSelectionResolver(),
) {
  const catalog = createFirstPartyModuleCatalog({
    modelTaskCapability,
    modelTaskCompletedInformationKind,
  });
  const models = new Map<string, ReturnType<KaguyaLlmModelResolver>>();
  const modelTask: RuntimeModelTaskOptions = {
    approvals: firstPartyModuleActivations
      .filter((activation) => activation.definitionId === "demo.reply.llm")
      .map((activation) => ({
        activation: {
          instanceId: activation.instanceId,
          definitionId: activation.definitionId,
        },
        selectionPolicy: {
          tier: llmReplySettingsSchema.parse(activation.settings).modelTier,
        },
      })),
    client: new KaguyaLlmClient({
      resolveModel: ({ modelId }) => {
        const model = models.get(modelId);
        if (model === undefined) throw new Error("Unapproved model");
        return model;
      },
    }),
    resolveModel: ({ tier }) => {
      const resolved = resolveModelSelection({ modelTier: tier });
      models.set(resolved.modelId, resolved.model);
      return { providerId: "host-approved", modelId: resolved.modelId };
    },
  };
  return {
    catalog,
    activations: firstPartyModuleActivations,
    modelTask,
  };
}
