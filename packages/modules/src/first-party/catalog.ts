/**
 * QQ 表情独立进入 Catalog 和生产默认配置，显式关闭后不安装 Heavy 草稿处理路径。
 * 功能概述：集中显式导入 first-party 模块，提供可被 composition root 选择和合并的 Catalog。
 * 主要职责：createFirstPartyModuleCatalog 接收宿主 Model Task token 和共享 completed kind，构造身份、时机与消息合成定义；
 * createFirstPartyModuleConfigDefaults 提供首次落盘模板，createFirstPartyModuleActivations
 * 同时提供 memory.raw 定义及未完成的 native/mem0 目录项；
 * 严格校验已加载的实例文件，与“可发现”的 Catalog 分开。
 * 代码库关系：Server、Demo 和测试组合入口传入 Runtime 的实际 token/definition；工厂仅依赖模块侧
 * 结构类型，保留 completed payload 泛型与对象身份，避免 modules 反向依赖 Runtime。
 * 模板正文由 composition 分别注入 Heavy、Light 与 Expression，默认值与本地覆盖统一在 Node 加载器选择。
 * 输入输出与副作用：纯内存定义，没有 timer、环境读取、连接、全局注册或动态目录扫描。
 */
import { createQqExpressionModule } from "./qq-expression/index.js";
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
import { memoryRawModule } from "./memory-raw/index.js";
import { memoryNativeModule } from "./memory-native/index.js";
import { memoryMem0Module } from "./memory-mem0/index.js";
import { identityModule } from "./identity/index.js";
import { createAttentionArousalModule } from "./attention-arousal/index.js";
import { heartbeatModule } from "./heartbeat/index.js";
import {
  createRouterModule,
  type CreateRouterModuleOptions,
} from "./router/index.js";
import {
  createHeavyModule,
  type AgentIdentity,
  type CreateHeavyModuleOptions,
  type ModelTaskCompletedInformationPayload,
} from "./heavy/index.js";
export function createFirstPartyModuleCatalog<
  P extends ModelTaskCompletedInformationPayload,
>(
  options: CreateHeavyModuleOptions<P> &
    CreateRouterModuleOptions & {
      readonly expressionTemplates: ExpressionPromptTemplates;
      readonly qqExpressionTemplates: { learn: string; select: string };
      readonly qqExpressionEnabled?: boolean;
    },
) {
  return defineInformationModuleCatalog(
    createQqExpressionModule({
      modelTaskCapability: options.modelTaskCapability,
      templates: options.qqExpressionTemplates,
    }),
    memoryRawModule,
    memoryNativeModule,
    memoryMem0Module,
    identityModule,
    createAttentionArousalModule({ timeZone: options.agentIdentity.timeZone }),
    createExpressionModule({
      ...options,
      promptTemplates: options.expressionTemplates,
    }),
    createHeavyModule({
      ...options,
      expressionEnabled: true,
      draftProcessingEnabled: options.qqExpressionEnabled ?? false,
    }),
    heartbeatModule,
    createRouterModule(options),
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
  _identity: Pick<AgentIdentity, "name" | "aliases"> = DEFAULT_AGENT_IDENTITY,
): readonly FirstPartyModuleInstanceConfig[] {
  return Object.freeze([
    Object.freeze({
      version: 1 as const,
      instanceId: "heavy.default",
      definitionId: "agent.heavy",
      enabled: true,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "memory.raw.default",
      definitionId: "memory.raw",
      enabled: false,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "adapter.web.main",
      definitionId: "adapter.web",
      enabled: true,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "adapter.napcat.main",
      definitionId: "adapter.napcat",
      enabled: false,
      settings: Object.freeze({ reconnectMs: 3000 }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "memory.identity.default",
      definitionId: "memory.identity",
      enabled: true,
      settings: Object.freeze({}),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "attention-arousal.default",
      definitionId: "agent.attention.arousal",
      enabled: true,
      settings: Object.freeze({
        idleSleepEnabled: false,
        idleSleepAfterMs: 120_000,
        nightSleepEnabled: false,
        nightSleepStart: "23:00",
        nightSleepEnd: "07:00",
        periodicWakeEnabled: true,
        periodicWakeEveryMs: 300_000,
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "heartbeat.default",
      definitionId: "agent.heartbeat.short",
      enabled: true,
      settings: Object.freeze({
        interruptQuietMs: 1000,
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
      instanceId: "router.default",
      definitionId: "agent.router",
      enabled: true,
      settings: Object.freeze({
        lightInterruptMaxConsecutiveCount: 2,
        muted: false,
        focusIdleMs: 120_000,
        staleAfterMs: 120_000,
      }),
    }),
    Object.freeze({
      version: 1 as const,
      instanceId: "memory.expression.default",
      definitionId: "memory.expression",
      enabled: true,
      settings: Object.freeze({ batchSize: 8 }),
    }),
    ...(profile === "production"
      ? [
          {
            version: 1 as const,
            instanceId: "qq-expression.default",
            definitionId: "plugin.qq-expression",
            enabled: true,
            settings: Object.freeze({}),
          },
        ]
      : []),
  ]);
}

export function createFirstPartyModuleActivations(
  catalog: InformationModuleCatalog,
  configs: readonly FirstPartyModuleInstanceConfig[],
  _identity: Pick<AgentIdentity, "name" | "aliases"> = DEFAULT_AGENT_IDENTITY,
): readonly InformationModuleActivation[] {
  return Object.freeze(
    configs
      .filter((config) => !config.definitionId.startsWith("adapter."))
      .map((config) => {
        if (
          config.definitionId === "demo.reply.llm" ||
          config.instanceId === "reply.default"
        ) {
          throw new Error("Unknown module configuration");
        }
        const definition = catalog.definitions.find(
          ({ manifest }) => manifest.definitionId === config.definitionId,
        );
        if (definition === undefined) {
          throw new Error(`Unknown module definition: ${config.definitionId}`);
        }
        if (definition.manifest.development?.status === "incomplete") {
          throw new Error(
            `Incomplete module cannot be activated: ${config.definitionId}`,
          );
        }
        const settings = definition.manifest.settingsSchema.safeParse(
          config.settings,
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
      `Module settings failed validation: ${instanceId} (${definitionId}), fields: ${paths.join(", ")}.`,
    );
    this.name = "ModuleConfigurationError";
  }
}
