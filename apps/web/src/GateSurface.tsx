/** 注意力观察的主从记录视图；仅呈现唤醒状态、通知、Focus、水位和未读数量。 */
import {
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
  type InspectionModule,
  type InspectionSurfaceEntity,
  type ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Clock3,
  Eye,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
} from "react";
import { Button, FieldMessage } from "./components/ui.js";
import { InspectionFields } from "./InspectionFields.js";
import {
  InspectionPager,
  type InspectionDetailProps,
} from "./ModuleRuntimeSection.js";
import { useInspection } from "./use-inspection.js";
import {
  gateContextStatus,
  gateDecision,
  gateNumber,
  gateText,
  gateValue,
  type GateDecision,
  type GateField,
} from "./attention-gate.js";
import "./gate-surface.css";
import "./gate-trace.css";

type Browser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "record-browser" }
>;
type Filters = { q: string; status: string; after: string; before: string };
type Trace = { id: string; label: string };
const emptyFilters: Filters = { q: "", status: "", after: "", before: "" };

const signalLabels: Record<string, string> = {
  private: "私聊",
  web: "Web",
  "mention-self": "@ 自己",
  "mention-all": "@ 全体",
  "reply-self": "回复机器人",
  passive: "普通消息",
  recheck: "周期复查",
};

const stamp = (value: string, compact = false) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(
    "zh-CN",
    compact
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : undefined,
  );
};

function recordedStrings(fields: readonly GateField[], path: string) {
  const value = gateValue(fields, path);
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(
    (item) => (typeof item === "string" ? item : JSON.stringify(item)),
  );
}

function scopeLabel(fields: readonly GateField[]) {
  return gateText(fields, "scopeKey") ?? "会话范围未记录";
}

function DecisionStatus({
  decision,
  compact = false,
}: {
  decision: GateDecision;
  compact?: boolean;
}) {
  const Icon = decision.outcome === "observe" ? Eye : Clock3;
  return (
    <span
      className={`gate-status gate-status-${decision.tone}`}
      role={compact ? "img" : undefined}
      aria-label={compact ? decision.label : undefined}
      title={compact ? decision.label : undefined}
    >
      <Icon size={14} aria-hidden="true" />
      {!compact && decision.label}
    </span>
  );
}

export function GateSurface({
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
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [filterError, setFilterError] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [trail, setTrail] = useState<Trace[]>([]);
  const list = useRef<HTMLOListElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const traceBack = useRef<HTMLButtonElement>(null);
  const traceOrigin = useRef<HTMLElement | null>(null);
  const traceScroll = useRef(0);
  const selectionFocus = useRef(false);

  const query = new URLSearchParams({ limit: "12" });
  for (const key of ["q", "status", "after", "before"] as const)
    if (filters[key]) query.set(key, filters[key]);
  if (cursors.length) query.set("cursor", cursors.at(-1)!);
  const base = `modules/${encodeURIComponent(module.definitionId)}/surfaces/${encodeURIComponent(module.inspection!.surface!.id)}`;
  const page = useInspection(
    token,
    `${base}?${query}`,
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

  useEffect(() => setTrail([]), [active, revision]);
  useEffect(() => {
    if (!detail.data || !selectionFocus.current) return;
    selectionFocus.current = false;
    detailPane.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
    if (
      detailPane.current &&
      detailPane.current.getBoundingClientRect().width >=
        detailPane.current.parentElement!.getBoundingClientRect().width - 2
    )
      detailPane.current.scrollIntoView({ block: "start" });
  }, [detail.data, mobileDetail]);
  const resetSelection = () => {
    setSelected(undefined);
    setTrail([]);
    setMobileDetail(false);
    setCursors([]);
  };
  const clear = () => {
    setDraft(emptyFilters);
    setFilters(emptyFilters);
    setFilterError("");
    resetSelection();
  };
  const changed = Boolean(
    filters.q || filters.status || filters.after || filters.before,
  );
  const trace = trail.at(-1);
  useEffect(() => {
    if (trace) {
      detailPane.current?.scrollTo({ top: 0 });
      traceBack.current?.focus({ preventScroll: true });
    } else if (traceOrigin.current) {
      detailPane.current?.scrollTo({ top: traceScroll.current });
      traceOrigin.current.focus({ preventScroll: true });
      traceOrigin.current = null;
    }
  }, [trace]);

  return (
    <section
      className="gate-surface"
      aria-label={module.inspection!.surface!.title}
    >
      <form
        className="gate-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const after = draft.after ? new Date(draft.after).toISOString() : "";
          const before = draft.before
            ? new Date(draft.before).toISOString()
            : "";
          if (after && before && after >= before) {
            setFilterError("结束时间应晚于开始时间。");
            return;
          }
          setFilterError("");
          setFilters({ ...draft, q: draft.q.trim(), after, before });
          resetSelection();
        }}
      >
        <label className="gate-search">
          <span>会话或触发</span>
          <span>
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={draft.q}
              maxLength={100}
              placeholder={browser.labels.placeholder}
              onChange={(event) =>
                setDraft({ ...draft, q: event.target.value })
              }
            />
          </span>
        </label>
        <label>
          <span>观察结果</span>
          <select
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value })
            }
          >
            <option value="">全部结果</option>
            {browser.status?.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" className="gate-apply">
          筛选
        </Button>
        <Button
          onClick={clear}
          disabled={!changed && !Object.values(draft).some(Boolean)}
        >
          清空
        </Button>
        <details className="gate-time-filter">
          <summary>
            <SlidersHorizontal size={16} aria-hidden="true" />
            时间范围
          </summary>
          <div>
            <label>
              开始时间
              <input
                type="datetime-local"
                value={draft.after}
                onChange={(event) =>
                  setDraft({ ...draft, after: event.target.value })
                }
              />
            </label>
            <label>
              结束时间
              <input
                type="datetime-local"
                value={draft.before}
                onChange={(event) =>
                  setDraft({ ...draft, before: event.target.value })
                }
                aria-invalid={Boolean(filterError)}
                aria-describedby={filterError ? "gate-filter-error" : undefined}
              />
            </label>
            <span>选择后点击筛选</span>
          </div>
        </details>
      </form>
      {filterError && (
        <FieldMessage id="gate-filter-error" tone="error">
          {filterError}
        </FieldMessage>
      )}
      {changed && (
        <p className="gate-applied" role="status">
          当前筛选：
          {[
            filters.q,
            browser.status?.options.find(
              (option) => option.value === filters.status,
            )?.label,
            filters.after && `${stamp(filters.after)} 之后`,
            filters.before && `${stamp(filters.before)} 之前`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {page.error ? (
        <div className="gate-empty">
          <FieldMessage tone="error">
            观察记录读取失败：{page.error}
          </FieldMessage>
          <Button onClick={() => setRefresh((value) => value + 1)}>
            重新读取
          </Button>
        </div>
      ) : !page.data ? (
        <FieldMessage>正在加载观察记录…</FieldMessage>
      ) : !page.data.items.length ? (
        <div className="gate-empty">
          <Search size={28} aria-hidden="true" />
          <h3>{changed ? "没有符合条件的观察" : "尚无注意力观察记录"}</h3>
          <p>
            {changed
              ? "调整会话、结果或时间范围，或清空筛选。"
              : "Heartbeat 产生观察机会后，observe 或 defer 会出现在这里。"}
          </p>
          <Button
            onClick={changed ? clear : () => setRefresh((value) => value + 1)}
          >
            {changed ? "清空筛选" : "刷新记录"}
          </Button>
        </div>
      ) : (
        <div className="gate-browser" data-detail={mobileDetail}>
          <section className="gate-directory" aria-label="观察记录">
            <header>
              <h3>观察记录</h3>
              <span>本页 {page.data.items.length} 条</span>
            </header>
            <p>最新在前 · 非全库统计</p>
            <ol ref={list}>
              {page.data.items.map((item) => {
                const decision = gateDecision(item.fields);
                return (
                  <li key={item.entityId}>
                    <button
                      type="button"
                      aria-pressed={active === item.entityId}
                      onClick={() => {
                        selectionFocus.current = true;
                        setTrail([]);
                        setSelected(item.entityId);
                        setMobileDetail(true);
                        if (active === item.entityId && detail.data) {
                          detailPane.current?.scrollTo({ top: 0 });
                          heading.current?.focus({ preventScroll: true });
                        }
                      }}
                    >
                      <span className="gate-row-meta">
                        <span className="gate-row-reason">
                          <DecisionStatus decision={decision} compact />
                          <strong>{decision.branchLabel}</strong>
                        </span>
                        <span
                          className="gate-row-scope"
                          title={scopeLabel(item.fields)}
                        >
                          {scopeLabel(item.fields)}
                        </span>
                        <time dateTime={item.occurredAt}>
                          {stamp(item.occurredAt, true)}
                        </time>
                      </span>
                      <span className="gate-row-content">
                        <span className="gate-row-input">
                          未读 {gateNumber(item.fields, "unreadCount") ?? "—"}{" "}
                          条
                        </span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <InspectionPager
              cursors={cursors}
              next={page.data.nextCursor}
              change={(next) => {
                setCursors(next);
                setSelected(undefined);
                setMobileDetail(false);
                setTrail([]);
              }}
            />
          </section>
          <article
            className="gate-detail"
            ref={detailPane}
            aria-busy={!detail.data && !detail.error}
          >
            <Button
              className="gate-back"
              onClick={() => {
                setMobileDetail(false);
                setTrail([]);
                requestAnimationFrame(() =>
                  list.current
                    ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
                    ?.focus(),
                );
              }}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              返回观察列表
            </Button>
            {trace && (
              <section className="gate-trace">
                <header>
                  <Button ref={traceBack} onClick={() => setTrail([])}>
                    <ArrowLeft size={16} aria-hidden="true" />
                    返回本次观察
                  </Button>
                  {trail.length > 1 && (
                    <Button
                      onClick={() => setTrail((items) => items.slice(0, -1))}
                    >
                      上一条来源
                    </Button>
                  )}
                </header>
                <nav aria-label="来源追溯路径">
                  {trail.map((item, index) => (
                    <button
                      key={`${item.id}-${index}`}
                      type="button"
                      aria-current={
                        index === trail.length - 1 ? "page" : undefined
                      }
                      onClick={() =>
                        setTrail((items) => items.slice(0, index + 1))
                      }
                    >
                      {item.label} · {item.id.slice(0, 8)}
                    </button>
                  ))}
                </nav>
                <DetailComponent
                  token={token}
                  selected={trace.id}
                  select={(id) =>
                    setTrail((items) =>
                      items.at(-1)?.id === id
                        ? items
                        : [...items, { id, label: "关联记录" }],
                    )
                  }
                  revision={revision + refresh}
                />
              </section>
            )}
            <div hidden={Boolean(trace)}>
              {detail.error ? (
                <FieldMessage tone="error">
                  观察详情读取失败：{detail.error}
                </FieldMessage>
              ) : !detail.data ? (
                <FieldMessage>正在读取观察事实…</FieldMessage>
              ) : (
                <GateExplanation
                  key={detail.data.entity.entityId}
                  data={detail.data}
                  headingRef={heading}
                  onTrace={(id, label) => {
                    traceOrigin.current =
                      document.activeElement instanceof HTMLElement
                        ? document.activeElement
                        : null;
                    traceScroll.current = detailPane.current?.scrollTop ?? 0;
                    setTrail([{ id, label }]);
                  }}
                />
              )}
            </div>
          </article>
        </div>
      )}
      <details className="gate-mechanism">
        <summary>{browser.labels.mechanism}</summary>
        <ol>
          {module.inspection?.mechanism.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function GateExplanation({
  data,
  headingRef,
  onTrace,
}: {
  data: InspectionSurfaceEntity;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onTrace: (id: string, label: string) => void;
}) {
  const fields = data.entity.fields;
  const decision = gateDecision(fields);
  const focus = gateContextStatus(fields);
  const signals = recordedStrings(fields, "signals");
  const technical = fields.filter((field) =>
    [
      "candidateInformationId",
      "arousalStateInformationId",
      "unreadAfterInformationId",
      "unreadThroughInformationId",
      "policyVersion",
    ].includes(field.path ?? ""),
  );
  return (
    <>
      <header className="gate-heading">
        <div>
          <DecisionStatus decision={decision} />
          <time dateTime={data.entity.occurredAt}>
            {stamp(data.entity.occurredAt)}
          </time>
        </div>
        <h3 ref={headingRef} tabIndex={-1}>
          {decision.title}
        </h3>
        <p>{scopeLabel(fields)}</p>
        <p className="gate-explanation">{decision.summary}</p>
      </header>
      <section className="gate-wait">
        <h4>本次观察事实</h4>
        <dl>
          <div>
            <dt>未读数量</dt>
            <dd>{gateNumber(fields, "unreadCount") ?? "未记录"} 条</dd>
          </div>
          <div>
            <dt>Arousal</dt>
            <dd>
              {gateText(fields, "arousalState") === "awake"
                ? "唤醒态"
                : gateText(fields, "arousalState") === "asleep"
                  ? "休眠态"
                  : "未记录"}
            </dd>
          </div>
          <div>
            <dt>唤醒信号</dt>
            <dd>
              {gateValue(fields, "wakeSignal") === true
                ? "已触发"
                : gateValue(fields, "wakeSignal") === false
                  ? "无需触发"
                  : "未记录"}
            </dd>
          </div>
          <div>
            <dt>Focus</dt>
            <dd>{focus.label}</dd>
          </div>
          <div>
            <dt>Focus 到期</dt>
            <dd>
              {gateText(fields, "focusExpiresAt")
                ? stamp(gateText(fields, "focusExpiresAt")!)
                : "未记录"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="gate-input">
        <header>
          <h4>触发信号</h4>
        </header>
        <p>
          {signals.length
            ? signals
                .map((signal) => signalLabels[signal] ?? signal)
                .join(" · ")
            : "未记录触发信号"}
        </p>
        <p className="gate-note">本视图不查询或展示消息正文。</p>
      </section>
      {data.sections.map((section) => (
        <section className="gate-input" key={section.id}>
          <header>
            <h4>{section.title}</h4>
            {section.items[0] && (
              <Button
                className="gate-text-action"
                onClick={() => onTrace(section.items[0]!.id, section.title)}
              >
                追踪关系
                <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            )}
          </header>
          {section.items.length ? (
            <InspectionFields fields={section.items[0]!.fields} />
          ) : (
            <p className="gate-note">没有已记录的关联事实。</p>
          )}
        </section>
      ))}
      <details className="gate-technical">
        <summary>水位与技术记录</summary>
        <div className="gate-reasons">
          <h4>记录原因</h4>
          <ul>
            {decision.reasons.length ? (
              decision.reasons.map((reason) => <li key={reason}>{reason}</li>)
            ) : (
              <li>未记录原因</li>
            )}
          </ul>
        </div>
        <InspectionFields fields={technical} />
        <Button onClick={() => onTrace(data.entity.entityId, "观察原始记录")}>
          打开观察原始记录
          <ArrowUpRight size={14} aria-hidden="true" />
        </Button>
      </details>
    </>
  );
}
