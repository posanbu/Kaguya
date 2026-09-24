/**
 * 功能概述：把知识存储中的当前 Wiki 页面投影为页面目录与可阅读详情，而不是修订流水。
 * 主要职责：生成稳定页面 ID、提取人物/会话页标题与摘要，并把最新修订和次级历史分开返回。
 * 代码库关系：inspection.ts 负责认证、游标与统一脱敏；本文件只调用 MemoryKnowledgeAccess 的有界只读方法。
 * 输入输出与副作用：只读 Wiki 页面和修订，不修改知识库；目录与历史均有明确上限。
 */
import type { KaguyaDatabase } from "@kaguya/database";
import type { ModuleInspectionSurfaceV1 } from "@kaguya/schema";

export type WikiBrowser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "wiki-browser" }
>;

type WikiStore = Pick<
  KaguyaDatabase["knowledge"],
  "listWikiPages" | "readWikiPage" | "listWikiRevisions"
>;
type WikiPage = Awaited<ReturnType<WikiStore["listWikiPages"]>>[number];
type WikiRevision = NonNullable<WikiPage["latestRevision"]>;

function cleanContent(content: string) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) => !line.startsWith("主体：") && !line.startsWith("原始经历（"),
    )
    .join(" ");
}

function observedName(revision: WikiRevision) {
  const section = revision.sections.find(
    ({ heading }) =>
      heading.startsWith("observed.card") ||
      heading.startsWith("observed.nickname"),
  );
  return section ? cleanContent(section.content) : undefined;
}

function pageTitle(page: WikiPage, revision: WikiRevision) {
  if (page.scopeInformationId === page.entityInformationId) return "会话总览";
  return (
    observedName(revision) || `人物 ${page.entityInformationId.slice(0, 8)}`
  );
}

function excerpt(revision: WikiRevision) {
  const section =
    revision.sections.find(
      ({ heading }) =>
        !heading.startsWith("observed.card") &&
        !heading.startsWith("observed.nickname"),
    ) ?? revision.sections[0];
  const value = section ? cleanContent(section.content) : "";
  return value.length > 180 ? `${value.slice(0, 180)}…` : value;
}

export function encodeWikiPageId(
  scopeInformationId: string,
  entityInformationId: string,
) {
  const compactUuid = [scopeInformationId, entityInformationId].map((value) =>
    value.match(
      /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/iu,
    ),
  );
  if (compactUuid.every((match) => match !== null))
    return `u${compactUuid
      .map((match) => match!.slice(1).join("").toLowerCase())
      .join("")}`;
  return Buffer.from(
    JSON.stringify([scopeInformationId, entityInformationId]),
  ).toString("base64url");
}

export function decodeWikiPageId(pageId: string) {
  try {
    const compact = pageId.match(/^u([0-9a-f]{64})$/u);
    if (compact) {
      const uuid = (hex: string) =>
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return {
        scopeInformationId: uuid(compact[1]!.slice(0, 32)),
        entityInformationId: uuid(compact[1]!.slice(32)),
      };
    }
    const value = JSON.parse(Buffer.from(pageId, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some(
        (item) => typeof item !== "string" || !item.trim() || item.length > 512,
      )
    )
      throw new Error("invalid page id");
    return {
      scopeInformationId: value[0] as string,
      entityInformationId: value[1] as string,
    };
  } catch {
    return undefined;
  }
}

function summary(page: WikiPage, revision: WikiRevision) {
  return {
    pageId: encodeWikiPageId(page.scopeInformationId, page.entityInformationId),
    scopeInformationId: page.scopeInformationId,
    entityInformationId: page.entityInformationId,
    title: pageTitle(page, revision),
    pageType:
      page.scopeInformationId === page.entityInformationId
        ? ("scope" as const)
        : ("entity" as const),
    version: revision.version,
    dirty: page.dirty,
    reasons: [...page.reasons],
    updatedAt: revision.recordedAt,
    sectionCount: revision.sections.length,
    excerpt: excerpt(revision),
  };
}

export async function wikiPageDirectory(
  store: WikiStore,
  limit: number,
  before?: {
    occurredAt: string;
    pageId: string;
  },
) {
  const decoded = before ? decodeWikiPageId(before.pageId) : undefined;
  if (before && !decoded) throw new Error("invalid_cursor");
  const rows = await store.listWikiPages({
    limit: limit + 1,
    ...(before && decoded
      ? {
          before: {
            recordedAt: before.occurredAt,
            ...decoded,
          },
        }
      : {}),
  });
  const visible = rows
    .slice(0, limit)
    .flatMap((page) =>
      page.latestRevision ? [summary(page, page.latestRevision)] : [],
    );
  const last = visible.at(-1);
  return {
    items: visible,
    cursor:
      rows.length > limit && last
        ? { occurredAt: last.updatedAt, pageId: last.pageId }
        : undefined,
  };
}

export async function wikiPageDetail(store: WikiStore, pageId: string) {
  const identity = decodeWikiPageId(pageId);
  if (!identity) return undefined;
  const [page, revisions] = await Promise.all([
    store.readWikiPage(identity),
    store.listWikiRevisions({ ...identity, limit: 11 }),
  ]);
  const current = revisions[0];
  if (!page || !current) return undefined;
  return {
    page: summary(page, current),
    sections: current.sections,
    history: revisions.slice(0, 10).map((revision) => ({
      version: revision.version,
      recordedAt: revision.recordedAt,
      sectionCount: revision.sections.length,
    })),
    historyTruncated: revisions.length > 10,
  };
}
