/**
 * 功能概述：在显式 composition root 选择演示业务 Catalog 与 LLM 宿主能力。
 * 主要职责：createReplyComposition 声明模块启用设置，并将模型解析器绑定为受控 executor；
 * createDeterministicModelSelectionResolver 为离线演示提供确定性模型。
 * 代码库关系：组合 modules、Runtime 通用生命周期与 LLM client，Runtime 本身不认识回复策略。
 * 输入输出与副作用：构造阶段无网络或连接；能力执行时从 Core 读取因果 context 并运行模型生命周期。
 */
import {
  KaguyaLlmClient,
  type KaguyaLlmModelResolver,
} from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import {
  createFirstPartyModuleCatalog,
  firstPartyModuleActivations,
  llmReplyExecutorCapability,
  type LlmReplyExecutor,
  type ModuleModelSelection,
  type LlmCompletedInformationPayload,
} from "@kaguya/modules";
import { type InformationKindDefinition } from "@kaguya/sdk";
import {
  llmCompletedInformationKind,
  LlmLifecycleClient,
  type RuntimeCapabilityContext,
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
    llmCompletedInformationKind:
      llmCompletedInformationKind as unknown as InformationKindDefinition<
        "core.llm.completed",
        LlmCompletedInformationPayload
      >,
  });
  return {
    catalog,
    activations: firstPartyModuleActivations,
    capabilities: ({ core, now }: RuntimeCapabilityContext) => {
      const executor: LlmReplyExecutor = {
        execute: async (input) => {
          const contexts = input.reply.references.filter(
            (r) => r.relation === "core:context",
          );
          if (contexts.length !== 1)
            throw new Error("Reply must have one context");
          const context = await core.get(contexts[0]!.informationId);
          if (context?.kind !== "core.runtime.context")
            throw new Error("Reply context information is unavailable");
          const resolved = resolveModelSelection(input.selection);
          return new LlmLifecycleClient({
            core,
            client: new KaguyaLlmClient({ model: resolved.model, now }),
            now,
          }).generate(
            {
              operationKey: input.operationKey,
              kind: "reply",
              modelId: resolved.modelId,
              workflowId: "message-module-pipeline",
              nodeId: "reply",
              originatingModuleInstanceId: input.originatingModuleInstanceId,
              prompt: input.prompt,
              contextAtoms: input.contextAtoms,
              reply: input.reply.payload,
            },
            context as Parameters<LlmLifecycleClient["generate"]>[1],
            input.reply,
          );
        },
      };
      return [{ capability: llmReplyExecutorCapability, value: executor }];
    },
  };
}
