/**
 * 功能概述：验证 Wiki Inspection 按当前页面去重展示，并把历史修订降为详情中的次级信息。
 * 主要职责：覆盖稳定页面 ID、人物标题提取、会话页标题、分页游标和脏页的最近修订正文。
 * 代码库关系：直接测试 inspection-wiki 的纯投影边界，使用内存 MemoryKnowledgeAccess 替身。
 * 输入输出与副作用：无网络或数据库 I/O。
 */
import { expect, it } from "vitest";
import {
  decodeWikiPageId,
  encodeWikiPageId,
  wikiPageDetail,
  wikiPageDirectory,
} from "./inspection-wiki.js";

const revision = (input: Record<string, unknown> = {}) => ({
  operationId: "operation-1",
  scopeInformationId: "scope-1",
  entityInformationId: "person-1",
  evidenceCutoff: {
    occurredBefore: "2026-09-24T11:00:00.000Z",
    recordedBefore: "2026-09-24T11:00:00.000Z",
  },
  generatorVersion: "test",
  sections: [
    {
      heading: "observed.card · fact",
      content: "主体：person-1；陈述者：来源观察\n月见",
      evidenceSourceInformationIds: ["source-1"],
      claimIds: [],
    },
    {
      heading: "2026-09-24T10:00:00.000Z · message",
      content: "原始经历（person-1）\n今晚喝茶",
      evidenceSourceInformationIds: ["source-2"],
      claimIds: [],
    },
  ],
  version: 3,
  recordedAt: "2026-09-24T11:00:00.000Z",
  ...input,
});
const page = {
  scopeInformationId: "scope-1",
  entityInformationId: "person-1",
  version: 3,
  dirtyVersion: 4,
  dirty: true,
  reasons: ["evidence_after_cutoff"],
  latestRevision: revision(),
};
const stalePage = {
  scopeInformationId: page.scopeInformationId,
  entityInformationId: page.entityInformationId,
  version: page.version,
  dirtyVersion: page.dirtyVersion,
  dirty: page.dirty,
  reasons: page.reasons,
};
const store = {
  listWikiPages: async () => [page],
  readWikiPage: async () => stalePage,
  listWikiRevisions: async () => [revision(), revision({ version: 2 })],
};

it("uses one current page as the directory item instead of revision rows", async () => {
  const result = await wikiPageDirectory(store, 20);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    title: "月见",
    pageType: "entity",
    version: 3,
    dirty: true,
    excerpt: "今晚喝茶",
  });
  expect(decodeWikiPageId(result.items[0]!.pageId)).toEqual({
    scopeInformationId: "scope-1",
    entityInformationId: "person-1",
  });
});

it("keeps UUID page identities below Fastify's path parameter limit", () => {
  const scopeInformationId = "b126f404-a020-4ebb-9ce3-461a137a6a51";
  const entityInformationId = "79676366-dedb-489f-a232-e786f0ab4b31";
  const pageId = encodeWikiPageId(scopeInformationId, entityInformationId);
  expect(pageId.length).toBeLessThanOrEqual(100);
  expect(decodeWikiPageId(pageId)).toEqual({
    scopeInformationId,
    entityInformationId,
  });
});

it("keeps the latest readable revision and bounded history on a dirty page", async () => {
  const directory = await wikiPageDirectory(store, 20);
  const result = await wikiPageDetail(store, directory.items[0]!.pageId);
  expect(result?.sections[1]?.content).toContain("今晚喝茶");
  expect(result?.history.map(({ version }) => version)).toEqual([3, 2]);
  expect(result?.page.dirty).toBe(true);
});
