/**
 * 功能概述：注意力门控的声明式记录视图，围绕一次历史判断解释放行、延后或忽略。
 * 主要职责：GateSurface 管理有界搜索、结果/时间过滤、分页和选择；GateExplanation 区分决策评分与参考评分；
 * ScoreBreakdown 展示已记录的分项而不重算历史；GateTrace 保留来源跳转栈和返回评估入口。
 * 代码库关系：ModuleSurface 按 record-browser.presentation 分派，字段以 Schema 返回的 path 识别；
 * attention-gate 只解释已记录的原因，useInspection 负责认证 GET、取消旧请求及隔离刷新结果。
 * 输入输出与副作用：不修改配置、不重放门控、不根据当前配置推断历史开关；窄屏切换详情保留列表位置，
 * 缺失字段显示未记录，来源不可用不补造检查通过；所有未知历史原因仍可从技术记录核查。
 */
import {
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
  type InspectionModule,
  type InspectionSurfaceEntity,
  type JsonValue,
  type ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Search,
  ShieldCheck,
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
import { ScoreRuleDialog } from "./ScoreRuleDialog.js";
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
const emptyFilters: Filters = { q: "", status: "", after: "", before: "" };
type Trace = { id: string; label: string };
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
const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
function scopeLabel(fields: readonly GateField[]) {
  const source = object(gateValue(fields, "source"));
  const target = object(source.destination);
  const platform = typeof source.platform === "string" ? source.platform : "";
  const targetId = target.groupId ?? target.userId;
  return (
    [
      platform,
      target.kind === "group"
        ? "群聊"
        : target.kind === "private"
          ? "直接会话"
          : "",
      typeof targetId === "string" ? targetId : "",
    ]
      .filter(Boolean)
      .join(" · ") || "会话未记录"
  );
}
function DecisionStatus({
  decision,
  compact = false,
}: {
  decision: GateDecision;
  compact?: boolean;
}) {
  const Icon =
    decision.outcome === "attend"
      ? Check
      : decision.outcome === "defer"
        ? Clock3
        : ShieldCheck;
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
  useEffect(() => {
    setTrail([]);
  }, [active, revision]);
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
          <span>会话或输入</span>
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
          <span>评估结果</span>
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
            评估记录读取失败：{page.error}
          </FieldMessage>
          <Button onClick={() => setRefresh((value) => value + 1)}>
            重新读取
          </Button>
        </div>
      ) : !page.data ? (
        <FieldMessage>正在加载评估记录…</FieldMessage>
      ) : !page.data.items.length ? (
        <div className="gate-empty">
          <Search size={28} aria-hidden="true" />
          <h3>{changed ? "没有符合条件的评估" : "尚无注意力评估记录"}</h3>
          <p>
            {changed
              ? "调整会话、结果或时间范围，或清空筛选。"
              : "冻结回合完成注意力评估后，结果会出现在这里。未观察到记录不等于评估失败。"}
          </p>
          {changed ? (
            <Button onClick={clear}>清空筛选</Button>
          ) : (
            <Button onClick={() => setRefresh((value) => value + 1)}>
              刷新记录
            </Button>
          )}
        </div>
      ) : (
        <div className="gate-browser" data-detail={mobileDetail}>
          <section className="gate-directory" aria-label="评估记录">
            <header>
              <h3>评估记录</h3>
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
                          requestAnimationFrame(() => heading.current?.focus());
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
                          {item.title || "未记录输入文本"}
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
              返回评估列表
            </Button>
            {trace && (
              <section className="gate-trace">
                <header>
                  <Button ref={traceBack} onClick={() => setTrail([])}>
                    <ArrowLeft size={16} aria-hidden="true" />
                    返回本次评估
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
                <>
                  <FieldMessage tone="error">
                    评估详情读取失败：{detail.error}
                  </FieldMessage>
                  <Button onClick={() => setRefresh((value) => value + 1)}>
                    重新读取
                  </Button>
                </>
              ) : !detail.data ? (
                <FieldMessage>正在读取判断依据…</FieldMessage>
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

/** 根据历史原因标出决定结果的步骤，不因保存了分数而把评分阶段标作放行依据。 */
function DecisionPath({ decision }: { decision: GateDecision }) {
  if (decision.branch === "unknown")
    return (
      <p className="gate-note">
        历史记录未提供可确定的判断路径；以下保留原始原因供核查。
      </p>
    );
  const final =
    decision.branch === "hard-gate"
      ? 0
      : decision.branch.startsWith("direct-")
        ? 1
        : decision.branch === "budget" || decision.outcome === "defer"
          ? 3
          : 2;
  const names = ["硬门禁", "直接关注规则", "评分阈值", "等待预算"];
  const descriptions = [
    final === 0 ? "命中拦截条件" : "未拦截",
    final === 1 ? "本次放行依据" : "未触发",
    final === 2 ? "达到当时阈值" : "未达到阈值",
    decision.outcome === "defer" ? "仍有等待余量" : "已耗尽",
  ];
  return (
    <ol className="gate-path" aria-label="本次判断路径">
      {names.slice(0, final + 1).map((name, index) => (
        <li key={name} data-final={index === final}>
          <span>
            {index === final ? (
              <span className="gate-path-dot" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            {name}
          </span>
          <small>{descriptions[index]}</small>
        </li>
      ))}
    </ol>
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
  const context = data.sections.find((section) => section.id === "context")
    ?.items[0];
  const [expanded, setExpanded] = useState(false);
  const input = gateText(fields, "text") ?? data.entity.title;
  const dueAt = gateText(fields, "dueAt");
  const technical = [
    ...fields.filter((field) =>
      ["policyDigest", "settingsDigest", "turnContextInformationId"].includes(
        field.path ?? "",
      ),
    ),
    ...(context?.fields.filter((field) =>
      ["scopeKey", "asOf"].includes(field.path ?? ""),
    ) ?? []),
  ];
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
      <DecisionPath decision={decision} />
      {decision.scoreDecisive ? (
        <ScoreBreakdown fields={fields} decisive />
      ) : (
        <details className="gate-reference-score" open>
          <summary>
            {decision.branch === "unknown" ? "已记录评分" : "参考评分"}
            <span>
              {decision.branch === "unknown"
                ? "无法确认是否参与本次判定"
                : "未作为本次结果的决定依据"}
            </span>
          </summary>
          <ScoreBreakdown fields={fields} decisive={false} />
        </details>
      )}
      {(decision.outcome === "defer" || decision.branch === "budget") && (
        <section className="gate-wait">
          <h4>当时的等待安排</h4>
          <dl>
            <div>
              <dt>等待次数 / 预算上限</dt>
              <dd>
                {gateNumber(fields, "attempt") ?? "未记录"} /{" "}
                {gateNumber(fields, "totalWaitBudget") ?? "未记录"} 次
              </dd>
            </div>
            {dueAt && (
              <div>
                <dt>建议复查时间</dt>
                <dd>{stamp(dueAt)}</dd>
              </div>
            )}
          </dl>
          {dueAt && (
            <p className="gate-note">
              这是当时记录的复查建议，不代表当前仍有待执行的预约。
            </p>
          )}
        </section>
      )}
      <section className="gate-input">
        <header>
          <h4>冻结输入</h4>
          {context && (
            <Button
              className="gate-text-action"
              onClick={() => onTrace(context.id, "冻结上下文")}
            >
              查看来源
              <ArrowUpRight size={14} aria-hidden="true" />
            </Button>
          )}
        </header>
        <p>
          {input
            ? expanded || input.length <= 280
              ? input
              : `${input.slice(0, 280)}…`
            : "未记录输入文本"}
        </p>
        {input.length > 280 && (
          <Button
            className="gate-text-action"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起输入" : "展开完整输入"}
          </Button>
        )}
        {!context && (
          <p className="gate-note">
            关联上下文不可用，保留本次评估已记录的输入与结果。
          </p>
        )}
      </section>
      {context && <ContextSignals fields={context.fields} />}
      <details className="gate-technical">
        <summary>技术记录与追溯</summary>
        <div className="gate-reasons">
          <h4>原始原因</h4>
          <ul>
            {decision.reasons.length ? (
              decision.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))
            ) : (
              <li>未记录原因</li>
            )}
          </ul>
        </div>
        <InspectionFields fields={technical} />
        <p className="gate-note">
          策略与配置标识用于核对记录，不能据此还原未保存的配置开关。
        </p>
        <Button onClick={() => onTrace(data.entity.entityId, "评估原始记录")}>
          打开评估原始记录
          <ArrowUpRight size={14} aria-hidden="true" />
        </Button>
      </details>
    </>
  );
}
/** 将冻结条件压成一行状态灯，缺失条件保留为未知，详细证据通过原生 disclosure 展开。 */
function ContextSignals({ fields }: { fields: readonly GateField[] }) {
  const status = gateContextStatus(fields);
  const frequency = gateNumber(fields, "frequency");
  const focused = gateValue(fields, "focusActive");
  return (
    <details className="gate-context">
      <summary>
        <span>当时条件</span>
        <span className={`gate-signal gate-signal-${status.tone}`}>
          <span aria-hidden="true" />
          {status.label}
        </span>
        <span className="gate-condition-value">
          频率 {frequency ?? "未记录"}
        </span>
        <span className="gate-condition-value">
          {focused === true
            ? "关注中"
            : focused === false
              ? "未关注"
              : "关注状态未记录"}
        </span>
      </summary>
      <ul className="gate-condition-details">
        {status.details.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="gate-note">取自当时的冻结快照。</p>
    </details>
  );
}
function ScoreBreakdown({
  fields,
  decisive,
}: {
  fields: readonly GateField[];
  decisive: boolean;
}) {
  const score = gateNumber(fields, "score"),
    threshold = gateNumber(fields, "threshold");
  const components = object(gateValue(fields, "components"));
  const number = (key: string) =>
    typeof components[key] === "number" && Number.isFinite(components[key])
      ? components[key]
      : undefined;
  const parts = (
    [
      ["relevance", "相关性"],
      ["content", "内容"],
      ["pressure", "消息压力"],
      ["recentPresencePenalty", "近期在场惩罚"],
    ] as const
  ).map(([key, label]) => {
    const recorded = number(key!);
    return {
      key: key!,
      label: label!,
      value:
        recorded === undefined
          ? undefined
          : key === "recentPresencePenalty"
            ? -recorded
            : recorded,
    };
  });
  const extent = Math.max(
    100,
    ...parts.map(({ value }) => Math.abs(value ?? 0)),
  );
  return (
    <section
      className="gate-score"
      aria-label={decisive ? "评分依据" : "参考评分"}
    >
      <header>
        <h4>{decisive ? "评分依据" : "已记录的评分"}</h4>
        <span>0–100 分</span>
      </header>
      <div className="gate-score-total">
        <strong>
          {score ?? "未记录"}
          <small>{score !== undefined ? " 分" : ""}</small>
        </strong>
        <span>
          当时阈值 <b>{threshold ?? "未记录"}</b>
          {decisive && score !== undefined && threshold !== undefined && (
            <small>
              {score >= threshold
                ? "达到阈值"
                : `低于阈值 ${Math.round((threshold - score) * 100) / 100} 分`}
            </small>
          )}
        </span>
      </div>
      <div className="gate-contribution-axis" aria-hidden="true">
        <span>分项贡献</span>
        <span>
          <span>−{extent}</span>
          <span>0</span>
          <span>+{extent}</span>
        </span>
        <span>分</span>
      </div>
      <dl className="gate-score-parts">
        {parts.map(({ key, label, value }) => (
          <div key={key}>
            <dt>
              <span>{label}</span>
              <ScoreRuleDialog
                part={key}
                value={value}
                evidence={gateValue(fields, "scoreEvidence")}
              />
            </dt>
            <dd>
              <span
                className="gate-contribution-track"
                aria-hidden="true"
                data-missing={value === undefined}
              >
                {value !== undefined && value !== 0 && (
                  <span
                    className="gate-contribution-bar"
                    data-negative={value < 0}
                    style={{
                      left: `${value < 0 ? 50 - (Math.abs(value) / extent) * 50 : 50}%`,
                      width: `${(Math.abs(value) / extent) * 50}%`,
                    }}
                  />
                )}
              </span>
              <span>
                {value === undefined
                  ? "未记录"
                  : value === 0
                    ? "0"
                    : `${value > 0 ? "+" : "−"}${Math.abs(value)}`}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="gate-score-calculation">
        合计 {number("preFrequencyScore") ?? "未记录"} × 频率因子{" "}
        {number("frequencyFactor") ?? "未记录"}
        <ChevronRight size={14} aria-hidden="true" />
        取整并限制到 0–100
      </p>
    </section>
  );
}
