/**
 * 功能概述：在显式 composition root 选择业务 Catalog 与宿主批准的 Model Task 能力。
 * 主要职责：createReplyComposition 注入共享 token/definition，按 activation 设置批准 tier，
 * 并将 provider client 与模型解析器交给 Runtime 构造受控 ModelTaskClient；providerId/modelId
 * 作为复合身份写入审计数据并通过异步调用上下文选择模型，避免同名 model 跨 provider 串线；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：组合 modules、Runtime 通用生命周期与 LLM client，Runtime 本身不认识回复策略。
 * 输入输出与副作用：构造阶段无网络或连接；模型句柄按复合 key 存于宿主闭包，
 * Runtime 校验 activation/policy、重载因果 context 并写通用任务生命周期，模块经 context.use 调用。
 */
import { AsyncLocalStorage } from "node:async_hooks";

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
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import { oneShotScheduleCapability } from "@kaguya/scheduler";
export type RuntimeModelSelectionResolver = (
  selection: ModuleModelSelection,
) => {
  readonly providerId: string;
  readonly modelId: string;
  readonly model: ReturnType<KaguyaLlmModelResolver>;
};
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
export function createReplyComposition(
  resolveModelSelection: RuntimeModelSelectionResolver = createDeterministicModelSelectionResolver(),
) {
  const catalog = createFirstPartyModuleCatalog({
    modelTaskCapability,
    modelTaskCompletedInformationKind,
  });
  const models = new Map<string, ReturnType<KaguyaLlmModelResolver>>();
  const activeModel = new AsyncLocalStorage<{
    readonly providerId: string;
    readonly modelId: string;
  }>();
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
        const identity = activeModel.getStore();
        if (identity === undefined || identity.modelId !== modelId)
          throw new Error("Unapproved model");
        const model = models.get(modelIdentityKey(identity));
        if (model === undefined) throw new Error("Unapproved model");
        return model;
      },
    }),
    resolveModel: ({ tier }) => {
      const resolved = resolveModelSelection({ modelTier: tier });
      const identity = {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
      };
      models.set(modelIdentityKey(identity), resolved.model);
      activeModel.enterWith(identity);
      return identity;
    },
  };
  return {
    catalog,
    activations: firstPartyModuleActivations,
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
