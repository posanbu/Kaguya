/**
 * 功能概述：将声明式 record-browser 渲染为查询目录与内容优先的详情，命中原文直接展示，检索条件按需展开。
 * 主要职责：RecordSurface 管理搜索、分页、选择与原始来源弹层；RecordStatus 以状态灯标识结果，含义由悬停提示和无障碍标签提供；QueryHeading/RecordSection 展示长查询、排名和来源缺失状态；SourceFields 区分正文与时间。
 * 代码库关系：ModuleSurface 按组件协议分派；useInspection 负责认证 GET/取消，字段与分组文案由 Manifest 提供。
 * 输入输出与副作用：只读查询；搜索改变时清空游标，刷新保留仍存在的选择，桌面切换记录后重置详情滚动，窄容器选择后聚焦详情；弹层关闭回到触发按钮。
 */
import {
  inspectionSurfaceEntitySchema,
  inspectionRecordPageSchema,
  type InspectionModule,
  type InspectionSurfaceEntity,
  type ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
import {
  ArrowLeft,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleMinus,
  CircleX,
  Clock3,
  Search,
  RefreshCw,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";
import { Button, Dialog, FieldMessage } from "./components/ui.js";
import {
  InspectionFields,
  InspectionStatus,
  ReadableValue,
} from "./InspectionFields.js";
import {
  InspectionPager,
  type InspectionDetailProps,
} from "./ModuleRuntimeSection.js";
import { useInspection } from "./use-inspection.js";
import "./record-surface.css";
type Browser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "record-browser" }
>;
export function RecordSurface({
  module,
  browser,
  token,
  revision,
  DetailComponent,
}: {
  module: InspectionModule;
  browser: Browser;
  token: string;
  revision: number;
  DetailComponent: ComponentType<InspectionDetailProps>;
}) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [trace, setTrace] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const traceTrigger = useRef<HTMLButtonElement | null>(null);
  const openTrace = (id: string, trigger?: HTMLButtonElement) => {
    if (trigger) traceTrigger.current = trigger;
    setTrace(id);
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const directory = useRef<HTMLHeadingElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const focusSelection = useRef(false);
  const base = `modules/${encodeURIComponent(module.definitionId)}/surfaces/${encodeURIComponent(module.inspection!.surface!.id)}`;
  const params = new URLSearchParams({ limit: "12" });
  if (query) params.set("q", query);
  if (cursors.length) params.set("cursor", cursors.at(-1)!);
  const page = useInspection(
    token,
    `${base}?${params}`,
    inspectionRecordPageSchema,
    revision + refresh,
  );
  const active =
    page.data?.items.find((item) => item.entityId === selected)?.entityId ??
    page.data?.items[0]?.entityId;
  const detail = useInspection(
    token,
    active ? `${base}/entities/${encodeURIComponent(active)}` : undefined,
    inspectionSurfaceEntitySchema,
    revision + refresh,
  );
  const focusDetail = () => {
    detailPane.current?.scrollTo({ top: 0 });
    if (backButton.current && backButton.current.offsetParent !== null) {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "start", behavior: "instant" });
    }
  };
  useEffect(() => {
    if (detail.data && focusSelection.current) {
      focusSelection.current = false;
      focusDetail();
    }
  }, [detail.data]);
  const apply = (value: string) => {
    setQuery(value.trim());
    setCursors([]);
    setSelected(undefined);
    setTrace(undefined);
  };
  return (
    <Dialog.Root
      open={Boolean(trace)}
      onOpenChange={(open) => {
        if (!open) setTrace(undefined);
      }}
    >
      <section
        className="record-surface"
        aria-label={module.inspection!.surface!.title}
      >
        <form
          className="record-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            apply(draft);
          }}
        >
          <label>
            <span>{browser.labels.search}</span>
            <span className="record-search">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={browser.labels.placeholder}
                maxLength={100}
              />
            </span>
          </label>
          <Button type="submit" variant="primary">
            查找
          </Button>
          <Button
            onClick={() => setRefresh((value) => value + 1)}
            aria-label="刷新联想记录"
          >
            <RefreshCw size={16} />
            刷新
          </Button>
        </form>
        {query && (
          <div className="record-filter" role="status">
            搜索：{query}
            <Button
              onClick={() => {
                setDraft("");
                apply("");
              }}
            >
              清除搜索
            </Button>
          </div>
        )}
        {page.error ? (
          <FieldMessage tone="error">
            记录读取失败：{page.error}。可点击刷新重试。
          </FieldMessage>
        ) : !page.data ? (
          <FieldMessage>正在加载{browser.labels.directory}…</FieldMessage>
        ) : !page.data.items.length ? (
          <div className="record-empty">
            <Search size={28} aria-hidden="true" />
            <h3>{query ? "没有符合条件的联想记录" : "尚无联想记录"}</h3>
            <p>
              {query
                ? "试试查询中的其他词，或清除搜索查看全部记录。"
                : browser.labels.empty}
            </p>
          </div>
        ) : (
          <>
            <div className="record-browser">
              <section
                className="record-directory"
                aria-label={browser.labels.directory}
              >
                <header>
                  <h3 ref={directory} tabIndex={-1}>
                    {browser.labels.directory}
                  </h3>
                  <span>本页 {page.data.items.length} 条</span>
                </header>
                <p className="record-order">按查询时间 · 最新在前</p>
                <ol>
                  {page.data.items.map((item) => (
                    <li key={item.entityId}>
                      <button
                        type="button"
                        aria-pressed={active === item.entityId}
                        onClick={() => {
                          if (active === item.entityId && detail.data) {
                            focusDetail();
                          } else {
                            focusSelection.current = true;
                            setSelected(item.entityId);
                          }
                        }}
                      >
                        <span className="record-row-meta">
                          <time dateTime={item.occurredAt}>
                            {new Date(item.occurredAt).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                          <RecordStatus value={item.status} />
                        </span>
                        <strong>
                          {item.title === "<empty>" ? "空查询" : item.title}
                        </strong>
                        <ChevronRight
                          className="record-row-arrow"
                          size={16}
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  ))}
                </ol>
                <InspectionPager
                  cursors={cursors}
                  next={page.data.nextCursor}
                  change={(next) => {
                    setCursors(next);
                    setSelected(undefined);
                  }}
                />
              </section>
              <article
                ref={detailPane}
                className="record-detail"
                aria-busy={!detail.data && !detail.error}
              >
                <Button
                  ref={backButton}
                  className="record-back"
                  onClick={() => {
                    directory.current?.focus();
                    directory.current?.scrollIntoView({ block: "start" });
                  }}
                >
                  <ArrowLeft size={16} />
                  返回联想记录
                </Button>
                {detail.error ? (
                  <FieldMessage tone="error">
                    详情读取失败：{detail.error}。可刷新重试或选择其他记录。
                  </FieldMessage>
                ) : !detail.data ? (
                  <FieldMessage>正在加载查询详情…</FieldMessage>
                ) : (
                  <>
                    <header className="record-heading">
                      <QueryHeading
                        key={detail.data.entity.entityId}
                        value={detail.data.entity.title}
                        headingRef={heading}
                      />
                      <div className="record-query-meta">
                        <time dateTime={detail.data.entity.occurredAt}>
                          {new Date(
                            detail.data.entity.occurredAt,
                          ).toLocaleString("zh-CN")}
                        </time>
                        <TraceButton
                          id={detail.data.entity.entityId}
                          onTrace={openTrace}
                        >
                          查询原始记录
                        </TraceButton>
                      </div>
                    </header>
                    {detail.data.sections
                      .slice()
                      .sort(
                        (a, b) =>
                          Number(
                            b.presentation === "ranked-list" &&
                              b.items.length > 0,
                          ) -
                          Number(
                            a.presentation === "ranked-list" &&
                              a.items.length > 0,
                          ),
                      )
                      .map((section) => (
                        <RecordSection
                          key={section.id}
                          section={section}
                          declaration={browser.relations.find(
                            (item) => item.id === section.id,
                          )}
                          onTrace={openTrace}
                        />
                      ))}
                    <details
                      key={detail.data.entity.entityId}
                      className="record-scope"
                    >
                      <summary>检索条件</summary>
                      <InspectionFields
                        fields={detail.data.entity.fields.map((item) =>
                          item.label === "截止时间" &&
                          typeof item.value === "string"
                            ? {
                                ...item,
                                value: new Date(item.value).toLocaleString(
                                  "zh-CN",
                                ),
                              }
                            : item,
                        )}
                      />
                    </details>
                    {browser.notice && (
                      <p className="record-notice">{browser.notice}</p>
                    )}
                  </>
                )}
              </article>
            </div>
          </>
        )}
        {module.inspection?.surface?.components.some(
          (component) => component.type === "mechanism-steps",
        ) && (
          <details className="record-mechanism">
            <summary>{browser.labels.mechanism}</summary>
            <ol>
              {module.inspection.mechanism.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        )}
      </section>
      <Dialog.Portal>
        <Dialog.Overlay className="record-overlay" />
        <Dialog.Content
          className="record-trace"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            traceTrigger.current?.focus();
          }}
        >
          <header>
            <div>
              <Dialog.Title>来源追溯</Dialog.Title>
              <Dialog.Description>
                沿引用查看原始记录；关闭后继续当前查询。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button aria-label="关闭来源追溯">
                <X size={18} />
              </Button>
            </Dialog.Close>
          </header>
          {trace && (
            <DetailComponent
              token={token}
              selected={trace}
              select={setTrace}
              revision={revision + refresh}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function TraceButton({
  id,
  onTrace,
  children,
}: {
  id: string;
  onTrace: (id: string, trigger?: HTMLButtonElement) => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      className="record-trace-button"
      aria-haspopup="dialog"
      onClick={(event) => onTrace(id, event.currentTarget)}
    >
      {children}
      <ArrowUpRight size={14} aria-hidden="true" />
    </Button>
  );
}
function RecordSection({
  section,
  declaration,
  onTrace,
}: {
  section: InspectionSurfaceEntity["sections"][number];
  declaration: Browser["relations"][number] | undefined;
  onTrace: (id: string, trigger?: HTMLButtonElement) => void;
}) {
  return (
    <section
      className={`record-section record-section-${section.presentation}`}
    >
      <header>
        <h4>{section.title}</h4>
        {section.presentation === "field-grid" &&
          section.items.length === 1 &&
          section.items[0]?.status && (
            <RecordStatus value={section.items[0].status} />
          )}
        {section.presentation === "ranked-list" && (
          <span>{section.items.length} 条</span>
        )}
      </header>
      {!section.items.length ? (
        <p className="record-muted">{declaration?.empty ?? "尚无相关记录。"}</p>
      ) : (
        <ol>
          {section.items.map((item) => (
            <li key={item.id}>
              {item.rank !== undefined && (
                <span
                  className="record-rank"
                  aria-label={`排名 ${item.rank + 1}`}
                >
                  {String(item.rank + 1).padStart(2, "0")}
                </span>
              )}
              <div className="record-section-body">
                {item.status &&
                  !(
                    section.presentation === "field-grid" &&
                    section.items.length === 1
                  ) && <RecordStatus value={item.status} />}
                {item.relatedSource &&
                  (item.relatedSource.available ? (
                    <SourceFields fields={item.relatedSource.fields} />
                  ) : (
                    <div className="record-source-missing">
                      <CircleAlert size={20} aria-hidden="true" />
                      <div>
                        <strong>命中记录的原文不可用</strong>
                        <p>
                          来源记录不可用，无法展示具体内容。当前仅能查看候选回执。
                        </p>
                      </div>
                    </div>
                  ))}
                <InspectionFields fields={item.fields} />
                <div className="record-actions">
                  {item.relatedSource?.informationId && (
                    <TraceButton
                      id={item.relatedSource.informationId}
                      onTrace={onTrace}
                    >
                      查看来源
                    </TraceButton>
                  )}
                  {item.sourceInformationId && (
                    <TraceButton
                      id={item.sourceInformationId}
                      onTrace={onTrace}
                    >
                      {section.presentation === "ranked-list"
                        ? "候选回执"
                        : "结果原始记录"}
                    </TraceButton>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {section.truncated && (
        <p role="status">
          本组记录超过展示上限，已截断；可查看原始记录继续追溯。
        </p>
      )}
    </section>
  );
}

const recordStatuses: Record<
  string,
  {
    label: string;
    tone: "success" | "warning" | "error" | "neutral";
    icon: LucideIcon;
  }
> = {
  matched: { label: "已召回", tone: "success", icon: CheckCircle2 },
  empty: { label: "未召回", tone: "warning", icon: CircleMinus },
  failed: { label: "失败", tone: "error", icon: CircleX },
  unavailable: { label: "不可用", tone: "error", icon: CircleX },
  "policy-filtered": { label: "策略过滤", tone: "neutral", icon: Ban },
};

function RecordStatus({ value }: { value: string | undefined }) {
  const status = value
    ? recordStatuses[value]
    : { label: "未见终态", tone: "neutral", icon: Clock3 };
  if (!status) return <InspectionStatus value={value!} />;
  const Icon = status.icon;
  return (
    <span
      className={`wb-status record-status record-status-${status.tone}`}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      <Icon size={16} strokeWidth={2.5} aria-hidden="true" />
    </span>
  );
}

/** 长查询保留全文，在有限详情空间中先展示前三行；显式展开不会改变已选查询。 */
function QueryHeading({
  value,
  headingRef,
}: {
  value: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > 120;
  return (
    <div className="record-query-title">
      <h3
        ref={headingRef}
        tabIndex={-1}
        className={long && !expanded ? "record-query-collapsed" : undefined}
      >
        {value === "<empty>" ? "空查询" : value}
      </h3>
      {long && (
        <Button
          className="record-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "收起查询" : "展开完整查询"}
        </Button>
      )}
    </div>
  );
}
/** 来源正文与时间按字段角色排版，缺少时间时不会将唯一的正文字段误当成末尾元数据。 */
function SourceFields({
  fields,
}: {
  fields: InspectionSurfaceEntity["entity"]["fields"];
}) {
  return (
    <dl className="record-source-fields">
      {fields.map((field, index) => {
        const isTime = field.label === "来源时间";
        const value =
          isTime && typeof field.value === "string"
            ? new Date(field.value).toLocaleString("zh-CN")
            : field.value;
        return (
          <div
            key={index}
            className={isTime ? "record-source-meta" : "record-source-content"}
          >
            <dt>{field.label}</dt>
            <dd>
              <ReadableValue value={value} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
