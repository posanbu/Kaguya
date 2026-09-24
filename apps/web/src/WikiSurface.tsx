/**
 * 功能概述：以当前 Wiki 页面为主体，提供页面目录、正文阅读、来源证据和次级修订历史。
 * 主要职责：稳定分页页面目录、选择当前页、把技术来源折叠到正文之后，并在窄屏提供目录/正文切换。
 * 代码库关系：ModuleSurface 分派 wiki-browser；列表与详情消费专用 Inspection DTO，不直接读取数据库。
 * 输入输出与副作用：只执行认证 GET 和本地选择；不会写入知识库或修改页面状态。
 */
import {
  inspectionWikiPageDetailSchema,
  inspectionWikiPageSchema,
  type InspectionModule,
  type ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Clock3,
  History,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, FieldMessage } from "./components/ui.js";
import { InspectionPager } from "./ModuleRuntimeSection.js";
import { useInspection } from "./use-inspection.js";
import "./wiki-surface.css";

type WikiBrowser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "wiki-browser" }
>;

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function pageTypeLabel(type: "scope" | "entity") {
  return type === "scope" ? "会话页" : "人物页";
}

function readableHeading(value: string) {
  const [subject, kind] = value.split(" · ");
  if (subject === "observed.card") return "群名片";
  if (subject === "observed.nickname") return "昵称";
  const timestamp = Date.parse(subject ?? "");
  if (!Number.isNaN(timestamp))
    return `${new Date(timestamp).toLocaleString()}${kind === "message" ? " · 经历" : ""}`;
  return subject || value;
}

function sectionContent(value: string) {
  const lines = value.split("\n");
  const first = lines[0]?.trim() ?? "";
  const hasContext =
    first.startsWith("主体：") || first.startsWith("原始经历（");
  return {
    context: hasContext ? first : undefined,
    body: (hasContext ? lines.slice(1) : lines).join("\n").trim(),
  };
}

export function WikiSurface({
  module,
  browser,
  token,
  revision,
}: {
  module: InspectionModule;
  browser: WikiBrowser;
  token: string;
  revision: number;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const directoryHeading = useRef<HTMLHeadingElement>(null);
  const focusDetail = useRef(false);
  const surface = module.inspection!.surface!;
  const base = `modules/${encodeURIComponent(module.definitionId)}/surfaces/${encodeURIComponent(surface.id)}`;
  const directory = useInspection(
    token,
    `${base}?limit=20${
      cursors.length ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ""
    }`,
    inspectionWikiPageSchema,
    revision,
  );
  const active =
    directory.data?.items.find(({ pageId }) => pageId === selected)?.pageId ??
    directory.data?.items[0]?.pageId;
  const detail = useInspection(
    token,
    active ? `${base}/entities/${encodeURIComponent(active)}` : undefined,
    inspectionWikiPageDetailSchema,
    revision,
  );

  useEffect(() => {
    if (
      !selected ||
      directory.data?.items.some((item) => item.pageId === selected)
    )
      return;
    setSelected(undefined);
  }, [directory.data, selected]);
  useEffect(() => {
    if (!focusDetail.current || !detail.data) return;
    focusDetail.current = false;
    detailHeading.current?.focus();
  }, [detail.data]);

  if (directory.error)
    return (
      <FieldMessage tone="error">
        Wiki 页面读取失败：{directory.error}。请刷新后重试。
      </FieldMessage>
    );
  if (!directory.data) return <FieldMessage>正在整理 Wiki 页面…</FieldMessage>;
  if (!directory.data.items.length)
    return <FieldMessage>{browser.empty}</FieldMessage>;

  return (
    <section
      className="wiki-surface"
      aria-label={surface.title}
      data-page-open={selected ? "true" : "false"}
    >
      <nav className="wiki-directory" aria-label="Wiki 页面目录">
        <header>
          <div>
            <h3 ref={directoryHeading} tabIndex={-1}>
              页面
            </h3>
            <span>本页 {directory.data.items.length} 篇</span>
          </div>
          <BookOpen size={18} aria-hidden="true" />
        </header>
        <ol>
          {directory.data.items.map((page) => {
            const current = active === page.pageId;
            return (
              <li key={page.pageId}>
                <button
                  type="button"
                  aria-pressed={current}
                  onClick={() => {
                    focusDetail.current = true;
                    setSelected(page.pageId);
                  }}
                >
                  <span className="wiki-page-row-heading">
                    {page.pageType === "scope" ? (
                      <UsersRound size={16} aria-hidden="true" />
                    ) : (
                      <UserRound size={16} aria-hidden="true" />
                    )}
                    <strong>{page.title}</strong>
                  </span>
                  <span className="wiki-page-row-meta">
                    {pageTypeLabel(page.pageType)} · v{page.version}
                    {page.dirty ? " · 待更新" : ""}
                  </span>
                  {page.excerpt && (
                    <span className="wiki-page-excerpt">{page.excerpt}</span>
                  )}
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
        <InspectionPager
          cursors={cursors}
          next={directory.data.nextCursor}
          change={(next) => {
            setCursors(next);
            setSelected(undefined);
          }}
        />
      </nav>
      <article
        className="wiki-document"
        aria-busy={!detail.data && !detail.error}
      >
        <Button
          className="wiki-back"
          onClick={() => {
            setSelected(undefined);
            directoryHeading.current?.focus();
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回页面目录
        </Button>
        {detail.error ? (
          <FieldMessage tone="error">
            Wiki 正文读取失败：{detail.error}。请选择其他页面或刷新重试。
          </FieldMessage>
        ) : !detail.data ? (
          <FieldMessage>正在打开 Wiki 页面…</FieldMessage>
        ) : (
          <WikiDocument detail={detail.data} headingRef={detailHeading} />
        )}
      </article>
    </section>
  );
}

function WikiDocument({
  detail,
  headingRef,
}: {
  detail: ReturnType<typeof inspectionWikiPageDetailSchema.parse>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="wiki-article">
      <header className="wiki-document-heading">
        <div>
          <span className="wiki-page-type">
            {pageTypeLabel(detail.page.pageType)}
          </span>
          <h3 ref={headingRef} tabIndex={-1}>
            {detail.page.title}
          </h3>
        </div>
        <span
          className={detail.page.dirty ? "wiki-state is-dirty" : "wiki-state"}
        >
          {detail.page.dirty ? "待更新" : "已整理"}
        </span>
      </header>
      <dl className="wiki-page-meta">
        <div>
          <dt>
            <Clock3 size={14} aria-hidden="true" />
            最近整理
          </dt>
          <dd>{new Date(detail.page.updatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{detail.page.version}</dd>
        </div>
        <div>
          <dt>范围</dt>
          <dd title={detail.page.scopeInformationId}>
            {shortId(detail.page.scopeInformationId)}
          </dd>
        </div>
      </dl>
      {detail.page.dirty && (
        <p className="wiki-dirty-note">
          新证据正在等待整理；下方显示最近一次完成的修订。
        </p>
      )}
      <div className="wiki-sections">
        {detail.sections.length ? (
          detail.sections.map((section, index) => {
            const content = sectionContent(section.content);
            return (
              <section key={`${section.heading}:${index}`}>
                <h4>{readableHeading(section.heading)}</h4>
                <p>{content.body || "暂无正文。"}</p>
                <details>
                  <summary>
                    来源证据 · {section.evidenceSourceInformationIds.length}
                  </summary>
                  {content.context && <p>{content.context}</p>}
                  <ul>
                    {section.evidenceSourceInformationIds.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </details>
              </section>
            );
          })
        ) : (
          <FieldMessage>这个页面目前没有正文。</FieldMessage>
        )}
      </div>
      <details className="wiki-history">
        <summary>
          <History size={15} aria-hidden="true" />
          修订历史 · {detail.history.length}
          {detail.historyTruncated ? "+" : ""}
        </summary>
        <ol>
          {detail.history.map((revision) => (
            <li key={revision.version}>
              <strong>v{revision.version}</strong>
              <span>{new Date(revision.recordedAt).toLocaleString()}</span>
              <span>{revision.sectionCount} 个章节</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
