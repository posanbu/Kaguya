/**
 * 功能概述：把实体、断言与 Wiki 导航结果收束为可由 Core 重载的原始证据 ID。
 * 主要职责：MemoryKnowledgeInformationRetrievalStrategy 要求明确 canonical scope 和两种截止点，
 * 实体 Wiki 仅提供最多两条原始来源导航；页面版本与证据均须在双时间截止点内，撤回与脏页不进入本次读取。
 * 核验仓储返回事件的范围、发生时间及记录时间，并限制返回数量；派生摘要不直接进入 Prompt。
 * 代码库关系：Runtime 仅在 knowledge profile 开启时注册策略，Heartflow selector 重载后再次核验消息来源。
 * 输入输出与副作用：只读 readWikiPage/getEvent/recall；Wiki 不可用仍查询实体及断言，整体失败降级为空且只报告错误类别。
 */
import type { InformationRetrievalStrategy } from "@kaguya/engine";
import {
  MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID,
  type KnowledgeEvent,
  type MemoryKnowledgeAccess,
} from "@kaguya/memory";
import { informationIdSchema, z } from "@kaguya/schema";

const querySchema = z
  .object({
    scopeInformationId: informationIdSchema,
    entityInformationId: informationIdSchema.optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .refine((value) => Array.from(value).length <= 512)
      .optional(),
    occurredBefore: z.iso.datetime({ offset: true }),
    recordedBefore: z.iso.datetime({ offset: true }),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export class MemoryKnowledgeInformationRetrievalStrategy implements InformationRetrievalStrategy {
  readonly strategyId = MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID;

  constructor(
    private readonly memory: Pick<
      MemoryKnowledgeAccess,
      "recall" | "readWikiPage" | "getEvent"
    >,
    private readonly options: {
      readonly reportFailure?: (failure: {
        readonly errorType: string;
      }) => void;
    } = {},
  ) {}

  async retrieve({
    input,
    limit,
  }: Parameters<InformationRetrievalStrategy["retrieve"]>[0]) {
    try {
      const query = querySchema.parse({ ...input, limit });
      const wikiSources = await this.wikiSources(query);
      const result = await this.memory.recall(query);
      const sources = new Set<string>(wikiSources);
      for (const event of result.events) {
        if (sources.size >= query.limit) break;
        if (!isEventAllowed(event, query)) continue;
        const source = informationIdSchema.safeParse(event.sourceInformationId);
        if (source.success) sources.add(source.data);
      }
      return Object.freeze([...sources]);
    } catch (error) {
      this.options.reportFailure?.({
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return Object.freeze([]);
    }
  }

  private async wikiSources(
    query: z.infer<typeof querySchema>,
  ): Promise<readonly string[]> {
    if (!query.entityInformationId) return [];
    try {
      const page = await this.memory.readWikiPage({
        scopeInformationId: query.scopeInformationId,
        entityInformationId: query.entityInformationId,
      });
      const revision = page?.latestRevision;
      if (
        !page ||
        page.dirty ||
        !revision ||
        revision.version !== page.version ||
        page.scopeInformationId !== query.scopeInformationId ||
        page.entityInformationId !== query.entityInformationId ||
        revision.scopeInformationId !== query.scopeInformationId ||
        revision.entityInformationId !== query.entityInformationId ||
        !(
          Date.parse(revision.recordedAt) <= Date.parse(query.recordedBefore)
        ) ||
        !(
          Date.parse(revision.evidenceCutoff.occurredBefore) <=
          Date.parse(query.occurredBefore)
        ) ||
        !(
          Date.parse(revision.evidenceCutoff.recordedBefore) <=
          Date.parse(query.recordedBefore)
        )
      )
        return [];
      const candidates = [
        ...new Set(
          revision.sections.flatMap(
            (section) => section.evidenceSourceInformationIds,
          ),
        ),
      ].slice(0, Math.min(2, query.limit));
      const selected: string[] = [];
      for (const sourceInformationId of candidates) {
        if (!informationIdSchema.safeParse(sourceInformationId).success)
          continue;
        const event = await this.memory.getEvent(
          sourceInformationId,
          query.scopeInformationId,
        );
        if (
          event &&
          event.sourceInformationId === sourceInformationId &&
          isEventAllowed(event, query)
        )
          selected.push(sourceInformationId);
      }
      return selected;
    } catch {
      return [];
    }
  }
}

function isEventAllowed(
  event: KnowledgeEvent,
  query: z.infer<typeof querySchema>,
): boolean {
  return (
    event.sourceKind === "core.message.inbound.text" &&
    event.scopeInformationId === query.scopeInformationId &&
    Date.parse(event.occurredAt) <= Date.parse(query.occurredBefore) &&
    Date.parse(event.recordedAt) <= Date.parse(query.recordedBefore)
  );
}
