/**
 * 功能概述：开发者控制台的只读 Module、Atom 与 Ingress/Turn Flow 页面，沿用顶层内存 Token。
 * 主要职责：DeveloperConsole 维护页面导航及手动刷新；Modules 展示 Manifest/activation；
 * Atoms 提供过滤、游标页和详情；Flows 按 runtime context 展示可点击 DAG 或时间列表；
 * Detail 支持完整脱敏 payload/Prompt、正反引用导航及复制 ID；useInspection 取消过期请求。
 * 代码库关系：App.tsx 处理 history 与锁屏，api.ts 复用 Gateway 认证并用 schema 包验证 DTO；
 * developer.css 定义响应式布局，模块和 Kind 名称完全由 Manifest 提供。
 * 输入输出与副作用：仅 GET 请求、history 导航和用户触发的剪贴板写入；无轮询、编辑或重放；
 * 卸载清理异步任务，加载/失败时隐藏旧数据，明确显示空结果、分页和图截断。
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  inspectionModulesSchema,
  inspectionPageSchema,
  inspectionDetailSchema,
  inspectionFlowSchema,
  type InspectionAtom,
  type InspectionFlow,
  type InspectionModule,
} from "@kaguya/schema";
import { getInspection } from "./api.js";
import "./developer.css";

type Page = "modules" | "atoms" | "flows";
export function developerPage(path: string): Page | undefined {
  return /^\/developer(?:\/modules)?\/?$/.test(path)
    ? "modules"
    : /^\/developer\/atoms\/?$/.test(path)
      ? "atoms"
      : /^\/developer\/flows\/?$/.test(path)
        ? "flows"
        : undefined;
}
function useInspection<T>(
  token: string,
  path: string | undefined,
  schema: { parse(value: unknown): T },
  revision: number,
) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(
    { key: "" },
  );
  const key = `${path}:${revision}:${token}`;
  useEffect(() => {
    if (path === undefined) return;
    const controller = new AbortController();
    void getInspection({ token }, path, schema, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error: error instanceof Error ? error.message : "读取失败",
          });
      },
    );
    return () => controller.abort();
  }, [token, path, schema, revision, key]);
  return state.key === key ? state : { key };
}
function Status({ state }: { state: { data?: unknown; error?: string } }) {
  return state.error ? (
    <p role="alert" className="error-banner">
      {state.error}
    </p>
  ) : state.data === undefined ? (
    <p role="status">正在加载…</p>
  ) : null;
}
export function DeveloperConsole({
  token,
  page,
  navigate,
}: {
  token: string;
  page: Page;
  navigate: (path: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const modules = useInspection(
    token,
    "modules",
    inspectionModulesSchema,
    revision,
  );
  const names = useMemo(
    () =>
      new Map(
        modules.data?.modules
          .flatMap((m) => [...m.consumes, ...m.produces])
          .map((k) => [k.kind, k.displayName]),
      ),
    [modules.data],
  );
  return (
    <div className="app-shell developer-shell">
      <header className="topbar">
        <strong>Kaguya · 开发者</strong>
        <span className="topbar-spacer" />
        <button className="secondary-button" onClick={() => navigate("/")}>
          返回消息
        </button>
      </header>
      <main className="developer-main">
        <div className="developer-heading">
          <div>
            <p className="eyebrow">运行时检查</p>
            <h1>开发者控制台</h1>
            <p>查看模块契约与消息流。消息和 Prompt 已执行秘密脱敏。</p>
          </div>
          <button
            className="secondary-button"
            onClick={() => setRevision((r) => r + 1)}
          >
            刷新
          </button>
        </div>
        <nav className="developer-tabs" aria-label="开发者导航">
          {(["modules", "atoms", "flows"] as const).map((p, i) => (
            <a
              key={p}
              href={`/developer/${p}`}
              aria-current={page === p ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/developer/${p}`);
              }}
            >
              {["Module 模块", "Atom 消息", "Ingress / Turn 流"][i]}
            </a>
          ))}
        </nav>
        {page === "modules" ? (
          <>
            <Status state={modules} />
            {modules.data && <Modules modules={modules.data.modules} />}
          </>
        ) : page === "atoms" ? (
          <Atoms key="atoms" token={token} revision={revision} names={names} />
        ) : (
          <Flows key="flows" token={token} revision={revision} names={names} />
        )}
      </main>
    </div>
  );
}
function Modules({ modules }: { modules: InspectionModule[] }) {
  const [search, setSearch] = useState("");
  const visible = modules.filter((m) =>
    `${m.definitionId} ${m.displayName} ${m.summary}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <label className="developer-search">
        查找模块
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="名称或 definition ID"
        />
      </label>
      <p>{visible.length} 个模块定义</p>
      {!visible.length && <p>没有匹配的模块。</p>}
      <div className="module-grid">
        {visible.map((m) => (
          <article className="developer-card" key={m.definitionId}>
            <h2>{m.displayName}</h2>
            <code>{m.definitionId}</code>
            <p>{m.summary}</p>
            <p>{m.description}</p>
            <dl>
              <dt>版本 / 协议</dt>
              <dd>
                {m.moduleVersion} / {m.protocolVersion}
              </dd>
              <dt>Activation</dt>
              <dd>
                {m.bindings.length
                  ? m.bindings.map((b) => b.instanceId).join("、")
                  : "未激活"}
              </dd>
            </dl>
            {(["consumes", "produces"] as const).map((field, i) => (
              <section key={field}>
                <h3>{i ? "输出 Kind" : "输入 Kind"}</h3>
                {m[field].length ? (
                  m[field].map((k) => (
                    <p key={k.kind} title={k.description}>
                      {k.displayName}
                      <br />
                      <code>{k.kind}</code>
                    </p>
                  ))
                ) : (
                  <p>无</p>
                )}
              </section>
            ))}
            <h3>Prompt renderer</h3>
            {m.promptRenderers.length ? (
              m.promptRenderers.map((p) => (
                <section key={p.rendererId}>
                  <strong>{p.displayName}</strong>
                  <p>{p.description}</p>
                  <code>{p.rendererId}</code>
                  <p>{p.kinds.join("、")}</p>
                </section>
              ))
            ) : (
              <p>无</p>
            )}
            <details>
              <summary>Selector、Capability 与绑定</summary>
              <pre>
                {JSON.stringify(
                  {
                    selectors: m.selectors,
                    requires: m.requires,
                    provides: m.provides,
                    bindings: m.bindings,
                    diagnostics: m.diagnostics,
                    settingsSchemaFingerprint: m.settingsSchemaFingerprint,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </article>
        ))}
      </div>
    </>
  );
}
function Filters({
  onApply,
  contexts = false,
}: {
  onApply: (query: string) => void;
  contexts?: boolean;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams();
    for (const key of ["kind", "source", "after", "before"]) {
      const value = String(form.get(key) ?? "").trim();
      if (value)
        query.set(
          key,
          key === "after" || key === "before"
            ? new Date(value).toISOString()
            : value,
        );
    }
    onApply(query.toString());
  };
  return (
    <form className="developer-filters" onSubmit={submit}>
      {!contexts && (
        <label>
          Kind
          <input name="kind" placeholder="完整 Kind" />
        </label>
      )}
      <label>
        Source
        <input name="source" placeholder="完整来源 ID" />
      </label>
      <label>
        开始时间
        <input name="after" type="datetime-local" />
      </label>
      <label>
        结束时间
        <input name="before" type="datetime-local" />
      </label>
      <button className="secondary-button">筛选</button>
    </form>
  );
}
function AtomList({
  atoms,
  select,
  names,
  selected,
}: {
  atoms: InspectionAtom[];
  select: (id: string) => void;
  names: Map<string, string>;
  selected: string | undefined;
}) {
  return (
    <ol className="atom-list">
      {atoms.map((a) => (
        <li key={a.informationId}>
          <button
            aria-pressed={selected === a.informationId}
            onClick={() => select(a.informationId)}
          >
            <strong>{names.get(a.kind) ?? a.kind}</strong>
            <code>{a.kind}</code>
            <time>{new Date(a.occurredAt).toLocaleString()}</time>
            <span>{a.source}</span>
            <code>{a.informationId}</code>
          </button>
        </li>
      ))}
    </ol>
  );
}
function Pager({
  next,
  cursors,
  setCursors,
}: {
  next: string | null;
  cursors: string[];
  setCursors: (value: string[]) => void;
}) {
  return (
    <div className="developer-pager">
      <button
        className="secondary-button"
        disabled={!cursors.length}
        onClick={() => setCursors(cursors.slice(0, -1))}
      >
        上一页
      </button>
      <span>第 {cursors.length + 1} 页</span>
      <button
        className="secondary-button"
        disabled={!next}
        onClick={() => next && setCursors([...cursors, next])}
      >
        下一页
      </button>
    </div>
  );
}
function Atoms({
  token,
  revision,
  names,
}: {
  token: string;
  revision: number;
  names: Map<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, select] = useState<string>();
  const state = useInspection(
    token,
    `atoms?${query}&cursor=${encodeURIComponent(cursors.at(-1) ?? "")}`.replace(
      /&cursor=$/,
      "",
    ),
    inspectionPageSchema,
    revision,
  );
  return (
    <>
      <Filters
        onApply={(q) => {
          setQuery(q);
          setCursors([]);
          select(undefined);
        }}
      />
      <div className="developer-split">
        <section>
          <Status state={state} />
          {state.data && (
            <>
              {!state.data.items.length && <p>没有匹配的消息。</p>}
              <AtomList
                atoms={state.data.items}
                select={select}
                names={names}
                selected={selected}
              />
              {state.data.truncated && <p>还有更多消息，请翻页查看。</p>}
              <Pager
                next={state.data.nextCursor}
                cursors={cursors}
                setCursors={(c) => {
                  setCursors(c);
                  select(undefined);
                }}
              />
            </>
          )}
        </section>
        <Detail
          key={selected ?? "empty"}
          token={token}
          selected={selected}
          select={select}
          revision={revision}
        />
      </div>
    </>
  );
}
function Detail({
  token,
  selected,
  select,
  revision,
}: {
  token: string;
  selected: string | undefined;
  select: (id: string) => void;
  revision: number;
}) {
  const state = useInspection(
    token,
    selected === undefined
      ? undefined
      : `atoms/${encodeURIComponent(selected)}`,
    inspectionDetailSchema,
    revision,
  );
  const [copied, setCopied] = useState("");
  if (selected === undefined)
    return <aside className="developer-card">选择消息或图节点查看详情。</aside>;
  const detail = state.data;
  const payload = detail?.atom.payload;
  const prompt =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload.prompt
      : undefined;
  const promptText =
    prompt &&
    typeof prompt === "object" &&
    !Array.isArray(prompt) &&
    typeof prompt.text === "string"
      ? prompt.text
      : undefined;
  return (
    <aside className="developer-card atom-detail">
      <h2>消息详情</h2>
      <Status state={state} />
      {detail && (
        <>
          <code>{detail.atom.informationId}</code>
          <button
            className="secondary-button"
            onClick={() => {
              void navigator.clipboard
                .writeText(detail.atom.informationId)
                .then(
                  () => setCopied("已复制"),
                  () => setCopied("复制失败，请手动复制 ID"),
                );
            }}
          >
            复制 information ID
          </button>
          <span role="status">{copied}</span>
          <p>
            {detail.atom.kind} · {detail.atom.source}
          </p>
          <time>{new Date(detail.atom.occurredAt).toLocaleString()}</time>
          {promptText !== undefined && (
            <section>
              <h3>编译 Prompt</h3>
              <pre>{promptText}</pre>
            </section>
          )}
          <h3>完整消息</h3>
          <pre>{JSON.stringify(detail.atom.payload, null, 2)}</pre>
          <h3>引用的消息</h3>
          {!detail.atom.references.length && <p>无</p>}
          {detail.atom.references.map((r, i) => (
            <button
              className="reference-link"
              key={i}
              onClick={() => select(r.informationId)}
            >
              {r.relation} → {r.informationId}
            </button>
          ))}
          {detail.referencesTruncated && (
            <p role="status">正向引用超过 100 条，已截断。</p>
          )}
          <h3>引用此消息</h3>
          {!detail.referencedBy.length && <p>无</p>}
          {detail.referencedBy.map((a) => (
            <button
              className="reference-link"
              key={a.informationId}
              onClick={() => select(a.informationId)}
            >
              {a.kind} · {a.informationId}
            </button>
          ))}
          {detail.reverseReferencesTruncated && (
            <p role="status">反向引用超过 100 条，已截断。</p>
          )}
        </>
      )}
    </aside>
  );
}
function Flows({
  token,
  revision,
  names,
}: {
  token: string;
  revision: number;
  names: Map<string, string>;
}) {
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [context, setContext] = useState<string>();
  const [selected, select] = useState<string>();
  const [graph, setGraph] = useState(true);
  const contexts = useInspection(
    token,
    `flows?${query}${cursors.length ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ""}`,
    inspectionPageSchema,
    revision,
  );
  const flow = useInspection(
    token,
    context ? `flows/${encodeURIComponent(context)}` : undefined,
    inspectionFlowSchema,
    revision,
  );
  return (
    <>
      <Filters
        contexts
        onApply={(q) => {
          setQuery(q);
          setCursors([]);
          setContext(undefined);
          select(undefined);
        }}
      />
      <label className="developer-search">
        Runtime context
        <select
          value={context ?? ""}
          onChange={(e) => {
            setContext(e.target.value || undefined);
            select(undefined);
          }}
        >
          <option value="">选择一次 Ingress / Turn 流</option>
          {contexts.data?.items.map((a) => (
            <option key={a.informationId} value={a.informationId}>
              {new Date(a.occurredAt).toLocaleString()} · {a.source} ·{" "}
              {a.informationId}
            </option>
          ))}
        </select>
      </label>
      <Status state={contexts} />
      {contexts.data && (
        <>
          {!contexts.data.items.length && <p>没有匹配的 runtime context。</p>}
          {contexts.data.truncated && <p>还有更多消息流，请翻页查看。</p>}
          <Pager
            next={contexts.data.nextCursor}
            cursors={cursors}
            setCursors={(c) => {
              setCursors(c);
              setContext(undefined);
              select(undefined);
            }}
          />
        </>
      )}
      {context && (
        <>
          <Status state={flow} />
          {flow.data && (
            <>
              <div className="developer-heading">
                <p>
                  {flow.data.nodes.length} 个节点 · {flow.data.edges.length}{" "}
                  条引用
                </p>
                <button
                  className="secondary-button"
                  onClick={() => setGraph((g) => !g)}
                >
                  {graph ? "切换时间列表" : "切换图形视图"}
                </button>
              </div>
              {flow.data.truncated && (
                <p role="status">消息流超过节点或引用上限，当前视图已截断。</p>
              )}
              {flow.data.externalReferences > 0 && (
                <p>
                  {flow.data.externalReferences}{" "}
                  条引用指向图外消息，可在节点详情中继续查看。
                </p>
              )}
              <div className="developer-split">
                <section>
                  {graph ? (
                    <FlowGraph
                      flow={flow.data}
                      select={select}
                      names={names}
                      selected={selected}
                    />
                  ) : (
                    <AtomList
                      atoms={flow.data.nodes}
                      names={names}
                      select={select}
                      selected={selected}
                    />
                  )}
                </section>
                <Detail
                  key={selected ?? "empty"}
                  token={token}
                  selected={selected}
                  select={select}
                  revision={revision}
                />
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
function FlowGraph({
  flow,
  select,
  names,
  selected,
}: {
  flow: InspectionFlow;
  select: (id: string) => void;
  names: Map<string, string>;
  selected: string | undefined;
}) {
  const positions = new Map(
    flow.nodes.map((a, i) => [
      a.informationId,
      { x: 70 + (i % 2) * 320, y: 35 + i * 95 },
    ]),
  );
  return (
    <div className="flow-viewport">
      <svg
        role="group"
        aria-label="Information DAG，箭头指向被引用消息"
        width="730"
        height={Math.max(180, flow.nodes.length * 95 + 35)}
        viewBox={`0 0 730 ${Math.max(180, flow.nodes.length * 95 + 35)}`}
      >
        <defs>
          <marker
            id="reference-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L8,3 z" fill="currentColor" />
          </marker>
        </defs>
        {flow.edges.map((edge, i) => {
          const a = positions.get(edge.from)!;
          const b = positions.get(edge.to)!;
          return (
            <path
              className="flow-edge"
              key={i}
              d={`M${a.x},${a.y + 24} C${20 + (i % 4) * 8},${a.y + 24} ${20 + (i % 4) * 8},${b.y + 24} ${b.x},${b.y + 24}`}
              markerEnd="url(#reference-arrow)"
            >
              <title>
                {edge.relation}: {edge.from} → {edge.to}
              </title>
            </path>
          );
        })}
        {flow.nodes.map((a) => {
          const p = positions.get(a.informationId)!;
          return (
            <g
              key={a.informationId}
              role="button"
              tabIndex={0}
              aria-label={`${names.get(a.kind) ?? a.kind} ${a.informationId}`}
              aria-pressed={selected === a.informationId}
              className="flow-node"
              transform={`translate(${p.x},${p.y})`}
              onClick={() => select(a.informationId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(a.informationId);
                }
              }}
            >
              <title>
                {a.kind} · {a.informationId}
              </title>
              <rect width="285" height="62" rx="8" />
              <text x="12" y="24">
                {(names.get(a.kind) ?? a.kind).slice(0, 32)}
              </text>
              <text x="12" y="46" className="flow-id">
                {a.informationId.slice(0, 30)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
