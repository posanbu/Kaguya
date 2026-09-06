/**
 * 功能概述：把独立 MemoryRecall 适配为 Core 可授权的命名 Information 检索策略。
 * 主要职责：校验 Selector JSON 输入、执行稀疏召回、仅返回原始 source Information IDs，
 * 并在仓储故障时安全降级为空结果。
 * 代码库关系：Runtime 启动 Core 时注册本策略；modules 的 association Selector 只引用稳定 strategy ID；
 * Core 随后从 append-only ledger 重载并授权结果。
 * 输入输出与副作用：执行 Memory 只读 I/O；失败报告仅含错误类型，不含 query 或正文。
 */
import type { InformationRetrievalStrategy } from "@kaguya/engine";
import {
  MEMORY_RETRIEVAL_STRATEGY_ID,
  parseMemoryRecallQuery,
  type MemoryRecall,
} from "@kaguya/memory";

export interface MemoryRetrievalFailure {
  readonly errorType: string;
}

export interface MemoryInformationRetrievalStrategyOptions {
  readonly reportFailure?: (failure: MemoryRetrievalFailure) => void;
}

export class MemoryInformationRetrievalStrategy implements InformationRetrievalStrategy {
  readonly strategyId = MEMORY_RETRIEVAL_STRATEGY_ID;

  constructor(
    private readonly memory: MemoryRecall,
    private readonly options: MemoryInformationRetrievalStrategyOptions = {},
  ) {}

  async retrieve({
    input,
    limit,
  }: Parameters<InformationRetrievalStrategy["retrieve"]>[0]) {
    try {
      const query = parseMemoryRecallQuery({ ...input, limit });
      const hits = await this.memory.recall(query);
      return Object.freeze([
        ...new Set(hits.map((hit) => hit.document.sourceInformationId)),
      ]);
    } catch (error) {
      this.options.reportFailure?.({ errorType: safeErrorType(error) });
      return Object.freeze([]);
    }
  }
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) return error.name;
  return "UnknownError";
}
