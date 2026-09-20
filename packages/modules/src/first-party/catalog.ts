/**
 * 功能概述：集中显式导入 first-party 模块，提供可被 composition root 选择和合并的 Catalog。
 * 主要职责：createFirstPartyModuleCatalog 接收宿主 Model Task token 和共享 completed kind，构造身份、时机与消息合成定义；
 * createFirstPartyModuleConfigDefaults 提供首次落盘模板，createFirstPartyModuleActivations
 * 同时提供独立 Memory writeback 定义，由 composition 在 Memory 启用时选择；
 * 事件与 Wiki 原型单独进入 Catalog，只有显式 knowledgeEnabled 才自动激活。
 * 严格校验已加载的实例文件，拒绝旧回复配置并提示重新初始化，与“可发现”的 Catalog 分开。
 * 代码库关系：Server、Demo 和测试组合入口传入 Runtime 的实际 token/definition；工厂仅依赖模块侧
 * 结构类型，保留 completed payload 泛型与对象身份，避免 modules 反向依赖 Runtime。
 * 模板正文由 composition 分别注入 Composer、Planner 与 Expression，默认值与本地覆盖统一在 Node 加载器选择。
 * 输入输出与副作用：纯内存定义，没有 timer、环境读取、连接、全局注册或动态目录扫描。
 */
import {
  defineInformationModuleCatalog,
  type InformationModuleCatalog,
  type InformationModuleActivation,
} from "@kaguya/sdk";
import type { JsonObject } from "@kaguya/schema";
import {
  createExpressionModule,
  type ExpressionPromptTemplates,
} from "./expression/index.js";
import { attentionFocusModule } from "./attention-focus/index.js";
import { memoryCognitionModule } from "./memory-cognition/index.js";
import { memoryIndexModule } from "./memory-index/index.js";
import { memoryWritebackModule } from "./memory-writeback/index.js";
import { memoryKnowledgeModule } from "./memory-knowledge/index.js";
import { associationModule } from "./association/index.js";
import { identityModule } from "./identity/index.js";
import { attentionArousalModule } from "./attention-arousal/index.js";
import { heartbeatModule } from "./heartbeat/index.js";
import {
  createHeartflowModule,
  type CreateHeartflowModuleOptions,
} from "./heartflow/index.js";
import {
  createMessageComposerModule,
  type AgentIdentity,
  type CreateMessageComposerModuleOptions,
  type ModelTaskCompletedInformationPayload,
} from "./message-composer/index.js";
export function createFirstPartyModuleCatalog<
  P extends ModelTaskCompletedInformationPayload,
>(
  options: CreateMessageComposerModuleOptions<P> &
    CreateHeartflowModuleOptions & {
      readonly expressionTemplates: ExpressionPromptTemplates;
    },
) {
  return defineInformationModuleCatalog(
    associationModule,
    memoryWritebackModule,
    memoryKnowledgeModule,
    memoryIndexModule,
    memoryCognitionModule,
    identityModule,
    attentionArousalModule,
    attentionFocusModule,
    createExpressionModule({
      ...options,
      promptTemplates: options.expressionTemplates,
    }),
    createMessageComposerModule({ ...options, expressionEnabled: true }),
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
  identity: Pick<AgentIdentity, "name" | "aliases"> = DEFAULT_AGENT_IDENTITY,
): readonly FirstPartyModuleInstanceConfig[] {
  return Object.freeze([
    Object.freeze({
      version: 1 as const,
      instanceId: "message-composer.default",
      definitionId: "agent.message-composer",
      enabled: true,
      settings: Object.freeze({
        modelTier: "heavy",
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
        focusRelevance: 40,
        forceDirectReply: true,
        forceNameReply: false,
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
        plannerInterruptQuietMs: 1000,
        maxReplacementAttempts: 3,
        totalWaitBudget: 3,
        noActionBackoffBaseMs: 15_000,
        noActionBackoffCapMs: 300_000,
        noActionBackoffStartCount: 2,
        noActionBackoffBypassPendingCount: 6,
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "heartflow.default",
      definitionId: "agent.heartflow.online",
      enabled: true,
      settings: Object.freeze({
        botNames: [identity.name, ...identity.aliases],
        groupFrequency: 1,
        privateFrequency: 1,
        focusFrequencyMultiplier: 1,
        dynamicFrequencyEnabled: false,
        dynamicFrequencyRules: [
          {
            platform: "",
            itemId: "",
            chatType: "group",
            time: "00:00-08:59",
            value: 0.8,
          },
          {
            platform: "",
            itemId: "",
            chatType: "group",
            time: "09:00-18:59",
            value: 1,
          },
        ],
        plannerInterruptMaxConsecutiveCount: 2,
        muted: false,
        staleAfterMs: 120_000,
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "attention-focus.default",
      definitionId: "agent.attention.focus",
      enabled: true,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "expression.default",
      definitionId: "agent.expression",
      enabled: true,
      settings: Object.freeze({ batchSize: 8 }),
    }),
  ]);
}

export function createFirstPartyModuleActivations(
  catalog: InformationModuleCatalog,
  configs: readonly FirstPartyModuleInstanceConfig[],
  identity: Pick<AgentIdentity, "name" | "aliases"> = DEFAULT_AGENT_IDENTITY,
): readonly InformationModuleActivation[] {
  return Object.freeze(
    configs
      .map((config) => {
        if (
          config.definitionId === "demo.reply.llm" ||
          config.instanceId === "reply.default"
        ) {
          throw new Error(
            "Legacy reply configuration is unsupported. Reinitialize module configuration.",
          );
        }
        const definition = catalog.definitions.find(
          ({ manifest }) => manifest.definitionId === config.definitionId,
        );
        if (definition === undefined) {
          throw new Error(`Unknown module definition: ${config.definitionId}`);
        }
        const settings = definition.manifest.settingsSchema.safeParse(
          config.definitionId === "agent.heartflow.online"
            ? {
                ...config.settings,
                botNames: [identity.name, ...identity.aliases],
              }
            : config.settings,
        );
        if (!settings.success) {
          throw new ModuleConfigurationError(
            config.instanceId,
            config.definitionId,
            settings.error.issues.map(
              (issue) => issue.path.map(String).join(".") || "settings",
            ),
          );
        }
        return Object.freeze({
          instanceId: config.instanceId,
          definitionId: config.definitionId,
          enabled: config.enabled,
          settings: settings.data,
        });
      })
      .filter((activation) => activation.enabled),
  );
}

const DEFAULT_AGENT_IDENTITY: Pick<AgentIdentity, "name" | "aliases"> = {
  name: "Kaguya",
  aliases: ["辉夜"],
};

/** 配置诊断只包含实例、字段路径和阶段，不回显配置值或凭据。 */
export class ModuleConfigurationError extends Error {
  readonly code = "MODULE_SETTINGS_INVALID";
  readonly stage = "module-settings";
  constructor(
    readonly instanceId: string,
    readonly definitionId: string,
    readonly paths: readonly string[],
  ) {
    super(
      `Module settings failed validation: ${instanceId} (${definitionId}), fields: ${paths.join(", ")}. Reinitialize module configuration.`,
    );
    this.name = "ModuleConfigurationError";
  }
}
