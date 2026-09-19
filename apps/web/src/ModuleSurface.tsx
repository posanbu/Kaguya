/**
 * 功能概述：渲染模块 Manifest 声明的受控检查 Surface；首版提供状态摘要、实体主从浏览、关系列表、时间线与关系图。
 * record-browser 分派给 RecordSurface；model-request-browser 分派给独立 RequestSurface，实体浏览保持现有身份页面行为。
 * 主要职责：将搜索和筛选转换为只读 Inspection 查询，保持稳定游标；实体选择加载独立详情并允许追溯原始 Atom。
 * 代码库关系：ModulePages 在模块声明 surface 时挂载本组件；布局来自 Manifest，数据由版本化 surface DTO 提供。
 * 输入输出与副作用：只执行认证 GET、history 内页面状态与可访问焦点移动；不执行模块提供的代码，不修改人物事实。
 */
import { RecordSurface } from "./RecordSurface.js";
import { RequestSurface } from "./RequestSurface.js";
import {
  inspectionSurfaceEntitySchema,
  inspectionSurfacePageSchema,
  type InspectionModule,
  type InspectionSurfaceEntity,
} from "@kaguya/schema";
import { Clock3, Network, Search, UserRound, UsersRound } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type RefObject,
} from "react";
import { Button, FieldMessage } from "./components/ui.js";
import { InspectionFields, InspectionStatus } from "./InspectionFields.js";
import {
  InspectionPager,
  type InspectionDetailProps,
} from "./ModuleRuntimeSection.js";
import { useInspection } from "./use-inspection.js";

interface ModuleSurfaceProps {
  module: InspectionModule;
  token: string;
  revision: number;
  DetailComponent: ComponentType<InspectionDetailProps>;
  path?: string;
}
/** 分派组件不持有 Hook，跨模块导航时按 definitionId 隔离搜索、选择和异步详情状态。 */
export function ModuleSurface(props: ModuleSurfaceProps) {
  const surface = props.module.inspection?.surface;
  const requests = surface?.components.find(
    (component) => component.type === "model-request-browser",
  );
  if (requests)
    return (
      <RequestSurface
        key={props.module.definitionId}
        {...props}
        browser={requests}
        path={
          props.path ??
          `/developer/modules/${encodeURIComponent(props.module.definitionId)}`
        }
      />
    );
  const records = surface?.components.find(
    (component) => component.type === "record-browser",
  );
  if (records)
    return (
      <RecordSurface
        key={props.module.definitionId}
        {...props}
        browser={records}
      />
    );
  if (
    !surface?.components.some(
      (component) => component.type === "entity-browser",
    )
  )
    return null;
  return <EntitySurface key={props.module.definitionId} {...props} />;
}
function EntitySurface({
  module,
  token,
  revision,
  DetailComponent,
}: ModuleSurfaceProps) {
  const surface = module.inspection?.surface;
  const browser = surface?.components.find(
    (component) => component.type === "entity-browser",
  );
  const mechanism = surface?.components.find(
    (component) => component.type === "mechanism-steps",
  );
  if (!surface || !browser) return null;
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [trace, setTrace] = useState<string>();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const focusDetailAfterLoad = useRef(false);
  const parameters = new URLSearchParams({ limit: "20" });
  if (query) parameters.set("q", query);
  if (platform) parameters.set("platform", platform);
  if (status) parameters.set("status", status);
  if (cursors.length) parameters.set("cursor", cursors.at(-1)!);
  const basePath = `modules/${encodeURIComponent(module.definitionId)}/surfaces/${encodeURIComponent(surface.id)}`;
  const page = useInspection(
    token,
    `${basePath}?${parameters}`,
    inspectionSurfacePageSchema,
    revision,
  );
  const activeSelected = selected ?? page.data?.items[0]?.entityId;
  useEffect(() => {
    if (selected && page.data?.items.some((item) => item.entityId === selected))
      return;
    setSelected(page.data?.items[0]?.entityId);
    setTrace(undefined);
  }, [page.data, selected]);
  const detail = useInspection(
    token,
    activeSelected
      ? `${basePath}/entities/${encodeURIComponent(activeSelected)}`
      : undefined,
    inspectionSurfaceEntitySchema,
    revision,
  );
  useEffect(() => {
    if (!focusDetailAfterLoad.current || !detail.data) return;
    focusDetailAfterLoad.current = false;
    detailHeading.current?.focus();
  }, [detail.data]);
  const choose = (entityId: string) => {
    focusDetailAfterLoad.current = true;
    setSelected(entityId);
    setTrace(undefined);
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setQuery(String(form.get("q") ?? "").trim());
    setPlatform(String(form.get("platform") ?? ""));
    setStatus(String(form.get("status") ?? ""));
    setCursors([]);
    setSelected(undefined);
    setTrace(undefined);
  };
  return (
    <section className="module-surface" aria-label={surface.title}>
      {page.error ? (
        <FieldMessage tone="error">
          人物资料读取失败：{page.error}。请刷新后重试。
        </FieldMessage>
      ) : !page.data ? (
        <FieldMessage>正在整理人物与身份资料…</FieldMessage>
      ) : (
        <>
          <StatusSummary
            counts={page.data.summary.counts}
            windowHours={page.data.summary.windowHours}
            selected={status}
            onSelect={(next) => {
              setStatus(next === status ? "" : next);
              setCursors([]);
              setSelected(undefined);
            }}
          />
          <form
            className="surface-toolbar"
            onSubmit={apply}
            key={`${query}:${platform}:${status}`}
          >
            <label className="surface-search">
              <span>查找人物</span>
              <span className="surface-input-wrap">
                <Search size={16} aria-hidden="true" />
                <input
                  name="q"
                  type="search"
                  defaultValue={query}
                  placeholder="昵称、群名片或账号 ID"
                />
              </span>
            </label>
            <label>
              平台
              <select name="platform" defaultValue={platform}>
                <option value="">全部平台</option>
                {page.data.platforms.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              识别状态
              <select name="status" defaultValue={status}>
                <option value="">全部状态</option>
                {page.data.statuses.map((value) => (
                  <option key={value} value={value}>
                    {statusText(value)}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="primary">
              筛选
            </Button>
          </form>
          <p className="surface-result-note" role="status">
            本页 {page.data.items.length} 位人物 · 按最近观察时间排序
          </p>
          <div className="surface-browser">
            <PersonDirectory
              items={page.data.items}
              selected={activeSelected}
              onSelect={choose}
            />
            <PersonDetail
              state={detail}
              headingRef={detailHeading}
              onTrace={setTrace}
            />
          </div>
          {!page.data.items.length && (
            <FieldMessage>
              没有符合当前条件的持久人物。Web 临时身份只会出现在识别历史中。
            </FieldMessage>
          )}
          <InspectionPager
            cursors={cursors}
            next={page.data.nextCursor}
            change={(next) => {
              setCursors(next);
              setSelected(undefined);
              setTrace(undefined);
            }}
          />
          {mechanism && module.inspection && (
            <details className="surface-mechanism">
              <summary>人物识别如何工作</summary>
              <ol>
                {module.inspection.mechanism.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          )}
          {trace && (
            <section className="surface-trace" aria-label="原始记录追溯">
              <DetailComponent
                token={token}
                selected={trace}
                select={setTrace}
                revision={revision}
              />
            </section>
          )}
        </>
      )}
    </section>
  );
}

function StatusSummary({
  counts,
  windowHours,
  selected,
  onSelect,
}: {
  counts: { status: string; count: number }[];
  windowHours: number;
  selected: string;
  onSelect: (status: string) => void;
}) {
  return (
    <section className="surface-status-summary" aria-label="最近识别状态">
      <header>
        <div>
          <h3>最近 {windowHours} 小时识别状态</h3>
          <p>点击状态可筛选人物目录；数字只代表该时间窗口。</p>
        </div>
        <Clock3 size={20} aria-hidden="true" />
      </header>
      <div>
        {counts.map(({ status, count }) => (
          <button
            key={status}
            type="button"
            aria-pressed={selected === status}
            onClick={() => onSelect(status)}
          >
            <strong>{count}</strong>
            <span>{statusText(status)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PersonDirectory({
  items,
  selected,
  onSelect,
}: {
  items: NonNullable<
    ReturnType<typeof inspectionSurfacePageSchema.parse>
  >["items"];
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="surface-directory" aria-label="人物目录">
      <header>
        <UsersRound size={18} aria-hidden="true" />
        <h3>人物目录</h3>
      </header>
      <ol>
        {items.map((item) => (
          <li key={item.entityId}>
            <button
              type="button"
              aria-pressed={selected === item.entityId}
              onClick={() => onSelect(item.entityId)}
            >
              <span className="surface-avatar" aria-hidden="true">
                {initial(item.title)}
              </span>
              <span className="surface-person-copy">
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
                <time>{new Date(item.occurredAt).toLocaleString()}</time>
              </span>
              {item.status && <InspectionStatus value={item.status} />}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PersonDetail({
  state,
  headingRef,
  onTrace,
}: {
  state: { data?: InspectionSurfaceEntity; error?: string };
  headingRef: RefObject<HTMLHeadingElement | null>;
  onTrace: (id: string) => void;
}) {
  if (state.error)
    return (
      <section className="surface-detail">
        <FieldMessage tone="error">
          人物详情读取失败：{state.error}。请选择其他人物或刷新页面。
        </FieldMessage>
      </section>
    );
  if (!state.data)
    return (
      <section className="surface-detail">
        <FieldMessage>正在加载人物详情…</FieldMessage>
      </section>
    );
  const { entity, sections } = state.data;
  return (
    <article className="surface-detail">
      <header>
        <span className="surface-detail-icon" aria-hidden="true">
          <UserRound size={22} />
        </span>
        <div>
          <h3 ref={headingRef} tabIndex={-1}>
            {entity.title}
          </h3>
          <p>{entity.subtitle}</p>
        </div>
        {entity.status && <InspectionStatus value={entity.status} />}
      </header>
      <InspectionFields
        fields={entity.fields.map((field) =>
          field.label === "最近观察" && typeof field.value === "string"
            ? { ...field, value: new Date(field.value).toLocaleString() }
            : field,
        )}
      />
      {sections.map((section) => (
        <SurfaceSection key={section.id} section={section} onTrace={onTrace} />
      ))}
    </article>
  );
}

function SurfaceSection({
  section,
  onTrace,
}: {
  section: InspectionSurfaceEntity["sections"][number];
  onTrace: (id: string) => void;
}) {
  const ordered = useMemo(
    () =>
      section.presentation === "timeline"
        ? [...section.items].sort(
            (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
          )
        : section.items,
    [section],
  );
  return (
    <section
      className={`surface-section surface-section-${section.presentation}`}
    >
      <header>
        {section.presentation === "relationship-graph" ? (
          <Network size={17} aria-hidden="true" />
        ) : section.presentation === "timeline" ? (
          <Clock3 size={17} aria-hidden="true" />
        ) : null}
        <h4>{section.title}</h4>
        <span>{ordered.length}</span>
      </header>
      {!ordered.length ? (
        <p className="inspection-muted">尚未记录相关资料。</p>
      ) : section.presentation === "relationship-graph" ? (
        <div className="surface-relationship-map">
          <span>当前人物</span>
          <div>
            {ordered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  item.sourceInformationId && onTrace(item.sourceInformationId)
                }
              >
                <InspectionFields fields={item.fields} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className="surface-section-list">
          {ordered.map((item) => (
            <li key={item.id}>
              <div>
                <time>{new Date(item.occurredAt).toLocaleString()}</time>
                {item.status && <InspectionStatus value={item.status} />}
              </div>
              <InspectionFields fields={item.fields} />
              {item.sourceInformationId && (
                <Button onClick={() => onTrace(item.sourceInformationId!)}>
                  查看原始 Atom
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function initial(value: string) {
  return [...value.trim()][0]?.toUpperCase() ?? "?";
}

function statusText(value: string) {
  const labels: Record<string, string> = {
    complete: "已完成",
    completed: "已完成",
    unresolved: "未解析",
    ambiguous: "存在歧义",
    degraded: "降级",
    failed: "失败",
  };
  return labels[value] ?? value;
}
