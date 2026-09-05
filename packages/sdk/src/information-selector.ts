/**
 * 功能概述：定义业务模块可声明的 Information Selector 与受限只读账本契约。
 * 主要职责：提供按 kind、来源、时间、引用图和命名检索策略读取候选原子的查询类型，
 * 并通过 `defineInformationSelector` 规范化标识、冻结 Selector definition。
 * 代码库关系：模块通过本文件声明选择策略；Engine 注入受控 reader、校验有序 ID
 * 结果并重新加载原子；Database 与检索实现不会直接暴露给业务模块。
 * 输入输出与副作用：Selector 只返回 informationId 序列；definition 创建仅修改内存，
 * reader 方法是否读取持久化由 Engine 实现，并应保持每次选择调用的授权作用域隔离。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
  JsonObject,
} from "@kaguya/schema";

export interface InformationFindQuery {
  readonly kinds?: readonly string[];
  readonly sources?: readonly string[];
  readonly occurredAfter?: string;
  readonly occurredBefore?: string;
  readonly limit: number;
}

export interface InformationRelatedQuery {
  readonly from: readonly InformationId[];
  readonly relation?: string;
  readonly direction: "outgoing" | "incoming";
  readonly limit: number;
}

export interface InformationRetrievalQuery {
  readonly strategyId: string;
  readonly input: JsonObject;
  readonly limit: number;
}

export interface InformationSelectorLedger {
  find(
    query: InformationFindQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
  related(
    query: InformationRelatedQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
  retrieve(
    query: InformationRetrievalQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]>;
}

export interface InformationSelectorContext {
  readonly sourceAtom: DeepReadonly<InformationAtom>;
  readonly ledger: InformationSelectorLedger;
}

export interface InformationSelectorDefinition {
  readonly selectorId: string;
  select(
    context: InformationSelectorContext,
  ): readonly InformationId[] | Promise<readonly InformationId[]>;
}

export function defineInformationSelector(
  definition: InformationSelectorDefinition,
): InformationSelectorDefinition {
  const selectorId = definition.selectorId.trim();
  if (selectorId.length === 0) {
    throw new Error("information selector id must not be blank");
  }
  return Object.freeze({ selectorId, select: definition.select });
}
