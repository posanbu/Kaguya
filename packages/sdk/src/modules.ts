/**
 * 功能概述：本模块定义信息原子模块的 SDK 契约，使模块只能订阅已声明 kind，
 * 并通过 handler context 注册由输入 atom 因果派生的新 atom、显式选择账本上下文。
 * 主要职责：`defineInformationModule` 校验清单基础约束；`onInformation` 将精确的
 * kind definition 与处理器封装为订阅；`InformationModuleHandlerContext.register`
 * 让宿主补齐 source、时间和受保护引用后交给 InformationCore；`context.select` 将
 * Selector 交由 Core 执行，并只返回 Core 校验和重新加载的不可变原子。
 * 代码库关系：由 `packages/sdk/src/index.ts` 对外导出，engine 的 `ModuleHost`
 * 消费 subscription 的 definition 并调用 Core.on；模块实现只依赖本文件而不接触
 * Core 的持久化、消费者故障记录或旧 Event ModuleHost。
 * 输入输出与副作用：定义和订阅均为内存值；清单拒绝空标识与重复 kind；handler
 * 取得只读输入 atom，register 返回 Core 已持久化且深冻结的派生 atom；select 可能
 * 执行只读持久化查询，但不允许模块绕过账本拼装上下文。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationReference,
  JsonObject,
} from "@kaguya/schema";
import { z } from "@kaguya/schema";

import type { InformationKindDefinition } from "./information-kind.js";
import type { InformationSelectorDefinition } from "./information-selector.js";

export interface InformationModuleManifest<TSettings = unknown> {
  readonly apiVersion: 1;
  readonly definitionId: string;
  readonly displayName: string;
  readonly settingsSchema: z.ZodType<TSettings>;
  readonly informationKinds: readonly InformationKindDefinition<string, any>[];
}

export interface InformationModuleActivation {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly settings: unknown;
}

export interface InformationModuleHandlerContext extends InformationExecutionContext {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly sourceAtom: DeepReadonly<InformationAtom>;
  select(
    selector: InformationSelectorDefinition,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
  register<K extends string, P extends JsonObject>(
    definition: InformationKindDefinition<K, P>,
    input: {
      readonly payload: P;
      readonly references?: readonly InformationReference[];
    },
  ): Promise<DeepReadonly<InformationAtom<K, P>>>;
}

export interface InformationExecutionContext {
  now(): Date;
}

export interface InformationModuleSubscription {
  readonly kind: string;
  readonly definition: InformationKindDefinition<string, JsonObject>;
  readonly handle: (
    atom: DeepReadonly<InformationAtom>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void;
}

export interface InformationModuleInstance {
  readonly subscriptions: readonly InformationModuleSubscription[];
  dispose?(): Promise<void> | void;
}

export interface CreateInformationModuleInstanceOptions<TSettings> {
  readonly instanceId: string;
  readonly settings: TSettings;
}

export interface InformationModuleDefinition<TSettings = unknown> {
  readonly manifest: InformationModuleManifest<TSettings>;
  create(
    options: CreateInformationModuleInstanceOptions<TSettings>,
  ): Promise<InformationModuleInstance> | InformationModuleInstance;
}

export function defineInformationModule<TSettings>(
  definition: InformationModuleDefinition<TSettings>,
): InformationModuleDefinition<TSettings> {
  assertNonBlank(definition.manifest.definitionId, "module definition id");
  assertNonBlank(definition.manifest.displayName, "module display name");
  if (definition.manifest.apiVersion !== 1) {
    throw new Error("unsupported information module API version");
  }
  if (!Array.isArray(definition.manifest.informationKinds)) {
    throw new Error("information module kinds must be an array");
  }
  const kinds = new Set<string>();
  for (const kind of definition.manifest.informationKinds) {
    if (kinds.has(kind.kind)) {
      throw new Error(`Duplicate information module kind: ${kind.kind}`);
    }
    kinds.add(kind.kind);
  }
  return definition;
}

export function onInformation<K extends string, P extends JsonObject>(
  definition: InformationKindDefinition<K, P>,
  handle: (
    atom: DeepReadonly<InformationAtom<K, P>>,
    context: InformationModuleHandlerContext,
  ) => Promise<void> | void,
): InformationModuleSubscription {
  return {
    kind: definition.kind,
    definition: definition as unknown as InformationKindDefinition<
      string,
      JsonObject
    >,
    handle: handle as InformationModuleSubscription["handle"],
  };
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}
