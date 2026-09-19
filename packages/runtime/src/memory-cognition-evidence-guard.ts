/**
 * 功能概述：将 Knowledge 的持久来源撤回检查暴露为 Core 命名检索策略，保护既有 Mem0 快照。
 * 主要职责：MemoryCognitionEvidenceGuardStrategy 接收最多 32 个完整闭包来源，保留调用方顺序，
 * 只返回既属于输入又未撤回的 ID；参数、存储或结果异常都返回空集合，不能绕过开启态检查。
 * 代码库关系：Runtime 仅在 knowledgeEnabled 时注册；memory-cognition selector 要求全部来源
 * 通过后才返回快照，Core 再从不可变账本加载这些 ID。本策略不授予跨场景权限，场景和时间由 selector 校验。
 * 输入输出与副作用：只调用 MemoryKnowledgeAccess.filterAvailableSourceIds，无写入、定时器或正文读取；
 * 未投影的原文由仓储保留可用，撤回和身份失效的全局 tombstone 立即阻止旧快照重新进入 Prompt。
 */
import type { InformationRetrievalStrategy } from "@kaguya/engine";
import {
  MEMORY_COGNITION_EVIDENCE_GUARD_STRATEGY_ID,
  type MemoryKnowledgeAccess,
} from "@kaguya/memory";
import { informationIdSchema, z } from "@kaguya/schema";

const guardQuerySchema = z
  .object({
    sourceInformationIds: z.array(informationIdSchema).min(1).max(32),
    limit: z.number().int().min(1).max(32),
  })
  .strict()
  .refine(
    (query) =>
      new Set(query.sourceInformationIds).size ===
        query.sourceInformationIds.length &&
      query.sourceInformationIds.length <= query.limit,
  );

export class MemoryCognitionEvidenceGuardStrategy implements InformationRetrievalStrategy {
  readonly strategyId = MEMORY_COGNITION_EVIDENCE_GUARD_STRATEGY_ID;

  constructor(
    private readonly knowledge: Pick<
      MemoryKnowledgeAccess,
      "filterAvailableSourceIds"
    >,
  ) {}

  async retrieve({
    input,
    limit,
  }: Parameters<InformationRetrievalStrategy["retrieve"]>[0]) {
    try {
      const query = guardQuerySchema.parse({ ...input, limit });
      const available = new Set(
        await this.knowledge.filterAvailableSourceIds({
          sourceInformationIds: query.sourceInformationIds,
        }),
      );
      return Object.freeze(
        query.sourceInformationIds.filter((id) => available.has(id)),
      );
    } catch {
      return Object.freeze([]);
    }
  }
}
