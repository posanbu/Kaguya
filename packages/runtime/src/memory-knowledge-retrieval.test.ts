/**
 * 功能概述：验证知识记忆到在线原始证据检索的范围、双时间截止点与故障隔离。
 * 主要职责：构造越权、迟到、未来及派生候选，断言只有允许的 inbound 来源进入 Core。
 * Wiki 测试验证分层入口只导航原文、脏页与未来修订回落到实体检索，撤回证据即使仍在旧页里也被拒绝。
 * 代码库关系：测试真实 MemoryKnowledgeInformationRetrievalStrategy；仓储替身不替代模块的二次原文校验。
 * 输入输出与副作用：使用内存事件与 spy，无外部服务、日志正文或数据库写入。
 */
import type {
  KnowledgeEvent,
  KnowledgeRecallResult,
  WikiPage,
} from "@kaguya/memory";
import { describe, expect, it, vi } from "vitest";
import { MemoryKnowledgeInformationRetrievalStrategy } from "./memory-knowledge-retrieval.js";

const cutoff = "2026-09-19T12:00:00.000Z";
const input = {
  scopeInformationId: "scope-1",
  query: "咖啡",
  occurredBefore: cutoff,
  recordedBefore: cutoff,
};
const noWiki = {
  readWikiPage: async () => undefined,
  getEvent: async () => undefined,
};
function page(): WikiPage {
  return {
    scopeInformationId: "scope-1",
    entityInformationId: "person-1",
    version: 1,
    dirtyVersion: 1,
    dirty: false,
    reasons: [],
    latestRevision: {
      operationId: "wiki-operation",
      scopeInformationId: "scope-1",
      entityInformationId: "person-1",
      version: 1,
      recordedAt: "2026-09-19T11:00:00.000Z",
      generatorVersion: "test",
      evidenceCutoff: {
        occurredBefore: "2026-09-19T10:00:00.000Z",
        recordedBefore: "2026-09-19T10:00:00.000Z",
      },
      sections: [
        {
          heading: "人物认识",
          content: "派生摘要不得直接作为证据",
          evidenceSourceInformationIds: [
            "wiki-source-1",
            "wiki-source-2",
            "over-budget",
          ],
          claimIds: [],
        },
      ],
    },
  };
}
function event(
  sourceInformationId: string,
  changes: Partial<KnowledgeEvent> = {},
): KnowledgeEvent {
  return {
    sourceInformationId,
    scopeInformationId: "scope-1",
    sourceKind: "core.message.inbound.text",
    occurredAt: "2026-09-18T12:00:00.000Z",
    recordedAt: "2026-09-18T12:01:00.000Z",
    content: "不喝咖啡",
    eventType: "message",
    actor: { status: "resolved", entityInformationId: "person-1" },
    subjects: [],
    ...changes,
  };
}
function result(events: KnowledgeEvent[]): KnowledgeRecallResult {
  return {
    events,
    claims: [],
    evidenceSourceInformationIds: ["unverified-source"],
    reasons: ["entity"],
    missing: [],
    truncated: false,
  };
}

describe("knowledge retrieval evidence boundary", () => {
  it("rejects cross-scope, future, late-recorded and non-message sources, without trusting summary evidence IDs", async () => {
    const recall = vi.fn(async () =>
      result([
        event("other-scope", { scopeInformationId: "scope-2" }),
        event("future", { occurredAt: "2026-09-20T00:00:00.000Z" }),
        event("late", { recordedAt: "2026-09-20T00:00:00.000Z" }),
        event("action", { sourceKind: "device.action.failed" }),
        event("good"),
        event("good"),
        event("second"),
      ]),
    );
    const strategy = new MemoryKnowledgeInformationRetrievalStrategy({
      ...noWiki,
      recall,
    });
    await expect(strategy.retrieve({ input, limit: 1 })).resolves.toEqual([
      "good",
    ]);
    expect(recall).toHaveBeenCalledWith({ ...input, limit: 1 });
  });

  it("requires explicit scope and both cutoff clocks before accessing the store", async () => {
    const recall = vi.fn(async () => result([]));
    const strategy = new MemoryKnowledgeInformationRetrievalStrategy({
      ...noWiki,
      recall,
    });
    await expect(
      strategy.retrieve({ input: { query: "咖啡" }, limit: 8 }),
    ).resolves.toEqual([]);
    expect(recall).not.toHaveBeenCalled();
  });

  it("does not disclose provider errors and leaves optional recall empty", async () => {
    const reportFailure = vi.fn();
    const strategy = new MemoryKnowledgeInformationRetrievalStrategy(
      {
        ...noWiki,
        recall: async () => {
          throw new Error("private conversation");
        },
      },
      { reportFailure },
    );
    await expect(strategy.retrieve({ input, limit: 8 })).resolves.toEqual([]);
    expect(reportFailure).toHaveBeenCalledWith({ errorType: "Error" });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("private");
  });

  it("navigates at most two Wiki evidence pointers before entity/raw results and filters revoked pointers", async () => {
    const getEvent = vi.fn(async (id: string) =>
      id === "wiki-source-1" ? undefined : event(id),
    );
    const strategy = new MemoryKnowledgeInformationRetrievalStrategy({
      readWikiPage: async () => page(),
      getEvent,
      recall: async () =>
        result([event("entity-source"), event("third-source")]),
    });
    await expect(
      strategy.retrieve({
        input: { ...input, entityInformationId: "person-1" },
        limit: 2,
      }),
    ).resolves.toEqual(["wiki-source-2", "entity-source"]);
    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getEvent).toHaveBeenCalledWith("wiki-source-1", "scope-1");
  });

  it.each(["dirty", "future-revision", "future-evidence", "foreign-scope"])(
    "falls back to entity evidence when Wiki is %s",
    async (condition) => {
      const wiki = page();
      const invalid: WikiPage =
        condition === "dirty"
          ? { ...wiki, dirty: true }
          : {
              ...wiki,
              latestRevision: {
                ...wiki.latestRevision!,
                ...(condition === "future-revision"
                  ? { recordedAt: "2026-09-20T00:00:00.000Z" }
                  : {}),
                ...(condition === "future-evidence"
                  ? {
                      evidenceCutoff: {
                        occurredBefore: "2026-09-20T00:00:00.000Z",
                        recordedBefore: cutoff,
                      },
                    }
                  : {}),
                ...(condition === "foreign-scope"
                  ? { scopeInformationId: "other" }
                  : {}),
              },
            };
      const getEvent = vi.fn(async (id: string) => event(id));
      const strategy = new MemoryKnowledgeInformationRetrievalStrategy({
        readWikiPage: async () => invalid,
        getEvent,
        recall: async () => result([event("fallback")]),
      });
      await expect(
        strategy.retrieve({
          input: { ...input, entityInformationId: "person-1" },
          limit: 4,
        }),
      ).resolves.toEqual(["fallback"]);
      expect(getEvent).not.toHaveBeenCalled();
    },
  );
});
