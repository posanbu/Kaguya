/**
 * 功能概述：集中显式导入 first-party 模块，提供可被 composition root 选择和合并的 Catalog。
 * 主要职责：createFirstPartyModuleCatalog 接收宿主 Model Task token 和共享 completed kind，构造身份、时机与回复定义；
 * createFirstPartyModuleConfigDefaults 提供首次落盘模板，createFirstPartyModuleActivations
 * 严格校验已加载的实例文件，与“可发现”的 Catalog 分开。
 * 代码库关系：Server、Demo 和测试组合入口传入 Runtime 的实际 token/definition；工厂仅依赖模块侧
 * 结构类型，保留 completed payload 泛型与对象身份，避免 modules 反向依赖 Runtime。
 * 输入输出与副作用：纯内存定义，没有 timer、环境读取、连接、全局注册或动态目录扫描。
 */
import {
  defineInformationModuleCatalog,
  type InformationModuleCatalog,
  type InformationModuleActivation,
} from "@kaguya/sdk";
import type { JsonObject } from "@kaguya/schema";
import { associationModule } from "./association/index.js";
import { identityModule } from "./identity/index.js";
import { attentionArousalModule } from "./attention-arousal/index.js";
import { heartbeatModule } from "./heartbeat/index.js";
import {
  createHeartflowModule,
  type CreateHeartflowModuleOptions,
} from "./heartflow/index.js";
import {
  createLlmReplyModule,
  type CreateLlmReplyModuleOptions,
  type ModelTaskCompletedInformationPayload,
} from "./llm-reply/index.js";
export function createFirstPartyModuleCatalog<
  P extends ModelTaskCompletedInformationPayload,
>(options: CreateLlmReplyModuleOptions<P> & CreateHeartflowModuleOptions) {
  return defineInformationModuleCatalog(
    associationModule,
    identityModule,
    attentionArousalModule,
    createLlmReplyModule(options),
    heartbeatModule,
    createHeartflowModule(options),
  );
}
export interface FirstPartyModuleInstanceConfig {
  readonly version: 1;
  readonly instanceId: string;
  readonly definitionId: string;
  readonly enabled: boolean;
  readonly settings: JsonObject;
}

export function createFirstPartyModuleConfigDefaults(
  profile: "production" | "test" = "production",
): readonly FirstPartyModuleInstanceConfig[] {
  return Object.freeze([
    Object.freeze({
      version: 1 as const,
      instanceId: "reply.default",
      definitionId: "demo.reply.llm",
      enabled: true,
      settings: Object.freeze({
        modelTier: "heavy",
        outbound: Object.freeze({ mode: "source", messageKind: "reply" }),
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "association.default",
      definitionId: "core.association.memory",
      enabled: true,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "identity.default",
      definitionId: "core.identity.normalize",
      enabled: true,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "attention-arousal.default",
      definitionId: "agent.attention.arousal",
      enabled: true,
      settings: Object.freeze({
        threshold: 80,
        deferMs: 15_000,
        policyDigest: "attention-arousal:maibot-v1",
        settingsDigest: "attention-arousal:default-v1",
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "heartbeat.default",
      definitionId: "agent.heartbeat.short",
      enabled: true,
      settings: Object.freeze({
        messageDebounceMs: profile === "test" ? 0 : 1500,
        maxReplacementAttempts: 3,
        totalWaitBudget: 3,
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "heartflow.default",
      definitionId: "agent.heartflow.online",
      enabled: true,
      settings: Object.freeze({
        botNames: ["Kaguya", "辉夜"],
        groupFrequency: 1,
        privateFrequency: 1,
        muted: false,
        staleAfterMs: 120_000,
      }),
    }),
  ]);
}

export function createFirstPartyModuleActivations(
  catalog: InformationModuleCatalog,
  configs: readonly FirstPartyModuleInstanceConfig[],
): readonly InformationModuleActivation[] {
  return Object.freeze(
    configs
      .map((config) => {
        const definition = catalog.definitions.find(
          ({ manifest }) => manifest.definitionId === config.definitionId,
        );
        if (definition === undefined) {
          throw new Error(`Unknown module definition: ${config.definitionId}`);
        }
        return Object.freeze({
          instanceId: config.instanceId,
          definitionId: config.definitionId,
          enabled: config.enabled,
          settings: definition.manifest.settingsSchema.parse(config.settings),
        });
      })
      .filter((activation) => activation.enabled),
  );
}
