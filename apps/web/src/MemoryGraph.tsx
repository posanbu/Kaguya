/**
 * 功能概述：Memory 工作台，提供图检视、节点正文／metadata 编辑及有向关系管理。
 * 主要职责：维护有界筛选、游标、单节点邻域、选择与草稿；关系以方向／类型／节点的紧凑行展示。
 * 顶部按当前返回范围显示“回忆”数量；操作成功后重新读取真实快照。
 * 筛选区统一对齐搜索、标签和时间控件；时间范围按需展开，新建有向边的入口称为“新增连结”。
 * 节点新增／编辑与有向连结共用 Radix 模态弹层；编辑载入原数据，图上连线保留端点，关闭经过草稿保护并返回对应入口。
 * 代码库关系：App 在 /memory 挂载；Canvas 复用 react-force-graph 高亮示例，API 对接 PostgresMemoryGraphStore。
 * 输入输出与副作用：只在显式保存／删除时写数据库；失败保留草稿，过期读取取消，离开保护未保存输入。
 * inspect 查询进入正式领域历史并停止读取当前图；证明不可用时不以图正文回退。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import { DomainInspection } from "./DomainInspection.js";
import { useWorkbenchNavigate } from "./components/AppShell.js";
import {
  Plus,
  RefreshCw,
  Network,
  PencilLine,
  Trash2,
  ChevronDown,
  ArrowRight,
  X,
} from "lucide-react";
import {
  memoryNodeInputSchema,
  memoryEdgeInputSchema,
  type MemoryNode,
  type MemoryNodeInput,
  type MemoryEdge,
  type MemoryEdgeInput,
  type MemoryGraphSnapshot,
  type MemoryGraphQuery,
} from "@kaguya/schema";
import {
  AlertDialog,
  Dialog,
  Button,
  FieldMessage,
  PageHeader,
} from "./components/ui.js";
import { useNavigationGuard } from "./components/AppShell.js";
import {
  readMemoryGraph,
  saveMemoryNode,
  deleteMemoryNode,
  saveMemoryEdge,
  deleteMemoryEdge,
} from "./memory-graph-api.js";
import { MemoryGraphCanvas } from "./MemoryGraphCanvas.js";
import { memoryTitle, memoryEdgeId } from "./memory-graph-model.js";
import "./memory-graph.css";
import type { MemoryColorMode } from "./memory-graph-colors.js";

type Editor =
  | { kind: "node"; node?: MemoryNode }
  | { kind: "edge"; sourceId?: string; targetId?: string };
type Deletion =
  { kind: "node"; node: MemoryNode } | { kind: "edge"; edge: MemoryEdge };
const splitTags = (value: string) => [
  ...new Set(
    value
      .split(/[,，\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";

export function MemoryGraph({
  token,
  location = "/memory",
}: {
  token: string;
  location?: string;
}) {
  const inspecting = new URLSearchParams(location.split("?")[1]).has("inspect");
  const [query, setQuery] = useState<MemoryGraphQuery>(() => ({
    limit: 100,
    system: "native-v1",
    status: "active",
    ...(new URLSearchParams(window.location.search).get("ownerId")
      ? { ownerId: new URLSearchParams(window.location.search).get("ownerId")! }
      : {}),
    ...(new URLSearchParams(window.location.search).get("focusId")
      ? { focusId: new URLSearchParams(window.location.search).get("focusId")! }
      : {}),
  }));
  const [filters, setFilters] = useState({
    search: "",
    tags: "",
    from: "",
    before: "",
  });
  const [history, setHistory] = useState<MemoryGraphQuery[]>([]);
  const [snapshot, setSnapshot] = useState<MemoryGraphSnapshot>();
  const [viewKey, setViewKey] = useState("");
  const [colorMode, setColorMode] = useState<MemoryColorMode>("tag");
  const [timeOpen, setTimeOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    query.focusId,
  );
  const [edgeId, setEdgeId] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const newMemoryButtonRef = useRef<HTMLButtonElement>(null);
  const editMemoryButtonRef = useRef<HTMLButtonElement>(null);
  const newMemoryContentRef = useRef<HTMLTextAreaElement>(null);
  const newEdgeButtonRef = useRef<HTMLButtonElement>(null);
  const newEdgeSourceRef = useRef<HTMLSelectElement>(null);
  const newEdgeRelationRef = useRef<HTMLInputElement>(null);
  const createReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [deletion, setDeletion] = useState<Deletion>();
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const canLeave = useCallback(
    () =>
      !busyRef.current &&
      (!dirty || window.confirm("记忆修改尚未保存，放弃修改吗？")),
    [dirty],
  );
  useNavigationGuard(canLeave);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  useEffect(() => {
    if (inspecting) return;
    const controller = new AbortController();
    setLoading(true);
    setReadError("");
    readMemoryGraph(token, query, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setViewKey(JSON.stringify(query));
        setSelectedId((id) =>
          data.nodes.some((node) => node.id === id) ? id : undefined,
        );
        setEdgeId((id) =>
          data.edges.some((edge) => memoryEdgeId(edge) === id) ? id : undefined,
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setReadError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, query, revision, inspecting]);

  const selected = snapshot?.nodes.find((node) => node.id === selectedId);
  const edge = snapshot?.edges.find((item) => memoryEdgeId(item) === edgeId);
  const creatingNode = editor?.kind === "node" && !editor.node;
  const editorOpen = !!editor;
  const locked = busy || loading || !!readError;
  const open = (next?: Editor) => {
    if (!canLeave()) return;
    setEditor(next);
    setDirty(false);
    setError("");
  };
  const choose = (id: string, isEdge = false) => {
    if (!canLeave()) return;
    setEditor(undefined);
    setDirty(false);
    setError("");
    setSelectedId(isEdge ? undefined : id);
    setEdgeId(isEdge ? id : undefined);
  };
  const changeQuery = (next: MemoryGraphQuery) => {
    if (!canLeave()) return false;
    setEditor(undefined);
    setDirty(false);
    setQuery(next);
    setHistory([]);
    setError("");
    return true;
  };
  const focus = (id: string) => {
    if (!changeQuery({ ...query, focusId: id, limit: 100 })) return;
    setFilters({ search: "", tags: "", from: "", before: "" });
    setSelectedId(id);
  };
  const perform = async (operation: () => Promise<void>, message: string) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      setNotice(message);
      setRevision((value) => value + 1);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const saveNode = async (input: MemoryNodeInput) => {
    const succeeded = await perform(async () => {
      const saved = await saveMemoryNode(token, input);
      setQuery({ focusId: saved.id, limit: 100 });
      setHistory([]);
      setFilters({ search: "", tags: "", from: "", before: "" });
      setSelectedId(saved.id);
      setEdgeId(undefined);
    }, "节点已保存。");
    if (succeeded) {
      setEditor(undefined);
      setDirty(false);
    }
  };
  const saveEdge = async (input: MemoryEdgeInput) => {
    const succeeded = await perform(async () => {
      const saved = await saveMemoryEdge(
        token,
        input,
        Object.fromEntries(
          (snapshot?.nodes ?? []).map((n) => [
            n.id,
            Number(n.metadata.revision),
          ]),
        ),
      );
      setQuery({ focusId: saved.sourceId, limit: 100 });
      setHistory([]);
      setFilters({ search: "", tags: "", from: "", before: "" });
      setEdgeId(memoryEdgeId(saved));
      setSelectedId(undefined);
    }, "关系已保存。");
    if (succeeded) {
      setEditor(undefined);
      setDirty(false);
    }
  };
  const remove = async () => {
    if (!deletion) return;
    const succeeded = await perform(
      async () => {
        if (deletion.kind === "node") {
          await deleteMemoryNode(token, deletion.node);
          setSelectedId(undefined);
          if (query.focusId === deletion.node.id) setQuery({ limit: 100 });
        } else {
          await deleteMemoryEdge(
            token,
            deletion.edge,
            Object.fromEntries(
              (snapshot?.nodes ?? []).map((n) => [
                n.id,
                Number(n.metadata.revision),
              ]),
            ),
          );
          setEdgeId(undefined);
        }
      },
      deletion.kind === "node" ? "节点已归档。" : "关系已删除。",
    );
    if (succeeded) setDeletion(undefined);
  };
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    changeQuery({
      ...query,
      limit: 100,
      search: filters.search,
      tags: splitTags(filters.tags),
      ...(filters.from
        ? { occurredFrom: new Date(filters.from).toISOString() }
        : {}),
      ...(filters.before
        ? { occurredBefore: new Date(filters.before).toISOString() }
        : {}),
    });
  };
  if (inspecting)
    return (
      <main className="memory-workspace">
        <PageHeader title="记忆" />
        <DomainInspection token={token} location={location} />
      </main>
    );
  return (
    <main className="memory-workspace">
      <PageHeader
        title="记忆"
        actions={
          <>
            <Button
              disabled={busy}
              onClick={() => {
                if (canLeave()) {
                  setEditor(undefined);
                  setDirty(false);
                  setRevision((value) => value + 1);
                }
              }}
            >
              <RefreshCw size={16} />
              刷新
            </Button>
            <Button
              ref={newMemoryButtonRef}
              variant="primary"
              aria-haspopup="dialog"
              disabled={locked}
              onClick={() => open({ kind: "node" })}
            >
              <Plus size={16} />
              新增记忆
            </Button>
          </>
        }
      />
      <nav className="memory-type-tabs" aria-label="记忆类型">
        {(
          [
            [undefined, "全部"],
            ["person", "人物"],
            ["conversation", "会话"],
            ["self", "自身"],
            ["experience", "经历"],
            ["expression", "表达"],
          ] as const
        ).map(([kind, label]) => (
          <Button
            key={label}
            aria-pressed={query.kind === kind}
            onClick={() =>
              changeQuery({
                ...query,
                kind,
                expressionType: undefined,
                focusId: undefined,
                afterId: undefined,
              })
            }
          >
            {label}
          </Button>
        ))}
        <label>
          状态
          <select
            value={query.status ?? ""}
            onChange={(e) =>
              changeQuery({
                ...query,
                status: e.target.value as "active" | "invalidated" | "archived",
              })
            }
          >
            <option value="active">有效</option>
            <option value="invalidated">待整理</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <label>
          层级
          <input
            type="number"
            min="0"
            placeholder="全部"
            value={query.level ?? ""}
            onChange={(e) =>
              changeQuery({
                ...query,
                level:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
        {query.ownerId && (
          <Button onClick={() => changeQuery({ ...query, ownerId: undefined })}>
            清除对象筛选
          </Button>
        )}
        {query.kind === "expression" && (
          <label>
            表达内容
            <select
              value={query.expressionType ?? ""}
              onChange={(e) =>
                changeQuery({
                  ...query,
                  expressionType: (e.target.value ||
                    undefined) as MemoryGraphQuery["expressionType"],
                })
              }
            >
              <option value="">全部表达</option>
              <option value="habit">表达习惯</option>
              <option value="example">文本示例</option>
              <option value="qq-resource">QQ 表情资源</option>
            </select>
          </label>
        )}
        <a href="/developer/modules/memory.native">运行检查与配置</a>
      </nav>
      <form
        className={`memory-filters${timeOpen ? " memory-filters-expanded" : ""}`}
        onSubmit={applyFilters}
      >
        <label className="field memory-filter-search">
          搜索正文
          <input
            type="search"
            value={filters.search}
            onChange={(event) =>
              setFilters({ ...filters, search: event.target.value })
            }
            placeholder="查找记忆内容"
          />
        </label>
        <label className="field memory-filter-tags">
          标签
          <input
            value={filters.tags}
            onChange={(event) =>
              setFilters({ ...filters, tags: event.target.value })
            }
            placeholder="例如：xxx用户，音乐"
          />
        </label>
        <div className="field memory-time-filter">
          <span id="memory-time-label">出现时间</span>
          <Button
            className="memory-time-toggle"
            aria-labelledby="memory-time-label memory-time-value"
            aria-expanded={timeOpen}
            aria-controls="memory-time-range"
            onClick={() => setTimeOpen(!timeOpen)}
          >
            <span id="memory-time-value">
              {filters.from || filters.before ? "已设置时间范围" : "不限时间"}
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
        </div>
        {timeOpen && (
          <div
            className="memory-time-range"
            id="memory-time-range"
            role="group"
            aria-label="出现时间范围"
          >
            <label className="field">
              开始时间
              <input
                type="datetime-local"
                autoFocus
                value={filters.from}
                onChange={(event) =>
                  setFilters({ ...filters, from: event.target.value })
                }
              />
            </label>
            <label className="field">
              结束时间（不含）
              <input
                type="datetime-local"
                value={filters.before}
                onChange={(event) =>
                  setFilters({ ...filters, before: event.target.value })
                }
              />
            </label>
          </div>
        )}
        <div className="memory-filter-actions">
          <Button type="submit" disabled={busy}>
            筛选
          </Button>
          {(query.focusId ||
            query.search ||
            query.tags?.length ||
            query.occurredFrom ||
            query.occurredBefore) && (
            <Button
              disabled={busy}
              onClick={() => {
                if (changeQuery({ limit: 100 }))
                  setFilters({ search: "", tags: "", from: "", before: "" });
              }}
            >
              全部记忆
            </Button>
          )}
        </div>
      </form>
      {notice && <FieldMessage tone="success">{notice}</FieldMessage>}
      {error && !editorOpen && (
        <FieldMessage tone="error">{error}</FieldMessage>
      )}
      {readError ? (
        <FieldMessage tone="error">{readError} 使用“刷新”重试。</FieldMessage>
      ) : snapshot ? (
        <>
          <div className="memory-view-bar">
            <span aria-live="polite">
              {loading ? "正在加载…" : `${snapshot.nodes.length} 个回忆`}
            </span>
            <div className="memory-actions">
              <Button
                ref={newEdgeButtonRef}
                aria-haspopup="dialog"
                disabled={locked || !snapshot.nodes.length}
                onClick={() =>
                  open({
                    kind: "edge",
                    ...(selectedId ? { sourceId: selectedId } : {}),
                  })
                }
              >
                <Plus size={15} />
                新增连结
              </Button>
              {history.length > 0 && (
                <Button
                  disabled={locked}
                  onClick={() => {
                    if (!canLeave()) return;
                    setEditor(undefined);
                    setDirty(false);
                    setQuery(history.at(-1)!);
                    setHistory(history.slice(0, -1));
                  }}
                >
                  上一批
                </Button>
              )}
              {snapshot.hasMoreNodes && !query.focusId && (
                <Button
                  disabled={locked}
                  onClick={() => {
                    if (!canLeave()) return;
                    setEditor(undefined);
                    setDirty(false);
                    setHistory([...history, query]);
                    setQuery({ ...query, afterId: snapshot.nodes.at(-1)!.id });
                  }}
                >
                  下一批
                </Button>
              )}
            </div>
          </div>
          {(snapshot.hasMoreNodes || snapshot.hasMoreEdges) && (
            <FieldMessage>
              当前图已截取：最多显示 100 个节点和 1000 条关系。可缩小筛选范围
              {!query.focusId ? "，或查看下一批" : ""}。
            </FieldMessage>
          )}
          <div className="memory-layout" aria-busy={loading}>
            <section className="memory-graph-region">
              {snapshot.nodes.length ? (
                <MemoryGraphCanvas
                  key={viewKey}
                  snapshot={snapshot}
                  colorMode={colorMode}
                  onColorMode={setColorMode}
                  disabled={locked}
                  {...(selectedId ? { selectedId } : {})}
                  {...(edgeId ? { selectedEdgeId: edgeId } : {})}
                  onNode={(id) => choose(id)}
                  onEdge={(id) => choose(id, true)}
                  onConnect={(connection) =>
                    open({
                      kind: "edge",
                      sourceId: connection.source,
                      targetId: connection.target,
                    })
                  }
                />
              ) : (
                <div className="memory-empty">
                  <Network size={36} aria-hidden="true" />
                  <h2>
                    {query.search ||
                    query.tags?.length ||
                    query.occurredFrom ||
                    query.occurredBefore
                      ? "没有匹配的记忆"
                      : "还没有记忆节点"}
                  </h2>
                  <p>
                    {query.search || query.tags?.length
                      ? "调整搜索或标签后重新筛选。"
                      : "新增一条记忆，再建立节点之间的关系。"}
                  </p>
                  <Button
                    disabled={locked}
                    onClick={() => open({ kind: "node" })}
                  >
                    新增记忆
                  </Button>
                </div>
              )}
              <p className="memory-canvas-help">
                拖动画布平移，滚轮缩放；选择“连线”后依次点选起点和终点。
              </p>
            </section>
            <aside className="memory-inspector" aria-label="记忆检视与编辑">
              {selected ? (
                <>
                  <div className="memory-panel-heading">
                    <h2>记忆节点</h2>
                    <Button
                      ref={editMemoryButtonRef}
                      aria-haspopup="dialog"
                      disabled={locked}
                      onClick={() => open({ kind: "node", node: selected })}
                    >
                      <PencilLine size={15} />
                      编辑
                    </Button>
                  </div>
                  <div className="memory-tags">
                    {selected.metadata.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <p className="memory-date">
                    {new Date(selected.metadata.occurredAt).toLocaleString()}
                  </p>
                  <NativeMemoryDetails node={selected} token={token} />
                  <pre className="memory-content">{selected.content}</pre>
                  <details>
                    <summary>完整 metadata 与 ID</summary>
                    <code className="memory-id">{selected.id}</code>
                    <pre className="memory-json">
                      {JSON.stringify(selected.metadata, null, 2)}
                    </pre>
                  </details>
                  <div className="memory-actions">
                    <Button
                      disabled={locked}
                      onClick={() => focus(selected.id)}
                    >
                      <Network size={15} />
                      查看一跳关联
                    </Button>
                    <Button
                      variant="danger"
                      disabled={locked}
                      onClick={() =>
                        setDeletion({ kind: "node", node: selected })
                      }
                    >
                      <Trash2 size={15} />
                      归档节点
                    </Button>
                  </div>
                  <h3 className="memory-relations-heading">当前图中的关系</h3>
                  <div className="memory-relations">
                    {snapshot.edges
                      .filter(
                        (item) =>
                          item.sourceId === selected.id ||
                          item.targetId === selected.id,
                      )
                      .map((item) => {
                        const self = item.sourceId === item.targetId;
                        const direction = self
                          ? "自环"
                          : item.sourceId === selected.id
                            ? "出边"
                            : "入边";
                        const target = snapshot.nodes.find(
                          (node) =>
                            node.id ===
                            (item.sourceId === selected.id
                              ? item.targetId
                              : item.sourceId),
                        )!;
                        const title = `${direction} · ${item.relation} · ${memoryTitle(target)}`;
                        return (
                          <button
                            key={memoryEdgeId(item)}
                            type="button"
                            title={title}
                            aria-label={title}
                            onClick={() => choose(memoryEdgeId(item), true)}
                          >
                            <span className="memory-relation-direction">
                              {direction}
                            </span>
                            <span className="memory-relation-type">
                              {item.relation}
                            </span>
                            <span className="memory-relation-node">
                              {self ? "本节点" : memoryTitle(target)}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </>
              ) : edge ? (
                <>
                  <h2>有向关系</h2>
                  <div className="memory-edge-endpoints">
                    <button type="button" onClick={() => choose(edge.sourceId)}>
                      {memoryTitle(
                        snapshot.nodes.find(
                          (node) => node.id === edge.sourceId,
                        )!,
                      )}
                    </button>
                    <span>
                      <ArrowRight size={17} />
                      {edge.relation}
                    </span>
                    <button type="button" onClick={() => choose(edge.targetId)}>
                      {memoryTitle(
                        snapshot.nodes.find(
                          (node) => node.id === edge.targetId,
                        )!,
                      )}
                    </button>
                  </div>
                  <h3>关系 metadata</h3>
                  <pre className="memory-json">
                    {JSON.stringify(edge.metadata, null, 2)}
                  </pre>
                  <Button
                    variant="danger"
                    disabled={locked}
                    onClick={() => setDeletion({ kind: "edge", edge })}
                  >
                    <Trash2 size={15} />
                    删除关系
                  </Button>
                </>
              ) : (
                <div className="memory-inspector-empty">
                  <h2>检视记忆</h2>
                  <p>选择节点查看正文、时间与标签，选择连线查看关系类型。</p>
                </div>
              )}
              {!editor && snapshot.nodes.length > 0 && (
                <details className="memory-node-list" open={!selected && !edge}>
                  <summary>节点列表（{snapshot.nodes.length}）</summary>
                  <ul>
                    {snapshot.nodes.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          aria-pressed={node.id === selectedId}
                          onClick={() => choose(node.id)}
                        >
                          {memoryTitle(node)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </aside>
          </div>
        </>
      ) : (
        <FieldMessage>正在加载记忆…</FieldMessage>
      )}
      <Dialog.Root
        open={editorOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) open();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="wb-overlay" />
          <Dialog.Content
            className="wb-dialog memory-create-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              createReturnFocusRef.current =
                editor?.kind === "node"
                  ? editor.node
                    ? editMemoryButtonRef.current
                    : newMemoryButtonRef.current
                  : newEdgeButtonRef.current;
              if (editor?.kind === "node") newMemoryContentRef.current?.focus();
              else if (
                editor?.kind === "edge" &&
                editor.sourceId &&
                editor.targetId
              )
                newEdgeRelationRef.current?.focus();
              else newEdgeSourceRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              createReturnFocusRef.current?.focus();
            }}
          >
            <Dialog.Description className="wb-sr-only">
              {creatingNode
                ? "填写记忆正文、出现时间和标签，保存后加入记忆图。"
                : editor?.kind === "node"
                  ? "修改记忆正文、出现时间、标签或其他 metadata，保存后更新此记忆。"
                  : "选择起点、终点和关系类型，保存有向连结。"}
            </Dialog.Description>
            {error && <FieldMessage tone="error">{error}</FieldMessage>}
            {editor?.kind === "edge" && snapshot ? (
              <MemoryEdgeEditor
                key={`${editor.sourceId}:${editor.targetId}`}
                nodes={snapshot.nodes}
                initial={editor}
                sourceRef={newEdgeSourceRef}
                relationRef={newEdgeRelationRef}
                busy={busy}
                onDirty={setDirty}
                onSave={saveEdge}
                onCancel={() => open()}
              />
            ) : (
              <MemoryNodeEditor
                key={
                  editor?.kind === "node" ? (editor.node?.id ?? "new") : "new"
                }
                node={editor?.kind === "node" ? editor.node : undefined}
                contentRef={newMemoryContentRef}
                busy={busy}
                onDirty={setDirty}
                onSave={saveNode}
                onCancel={() => open()}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <AlertDialog.Root
        open={!!deletion}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setDeletion(undefined);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="wb-overlay" />
          <AlertDialog.Content className="wb-dialog">
            <AlertDialog.Title>
              {deletion?.kind === "node"
                ? "归档这个记忆节点？"
                : "删除这条关系？"}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {deletion?.kind === "node"
                ? `归档“${memoryTitle(deletion.node)}”后，它将退出在线记忆。历史版本与关联仍会保留。`
                : "只删除选中的有向关系，两端的记忆节点继续保留。"}
            </AlertDialog.Description>
            {error && <FieldMessage tone="error">{error}</FieldMessage>}
            <div className="memory-actions">
              <AlertDialog.Cancel asChild>
                <Button disabled={busy}>取消</Button>
              </AlertDialog.Cancel>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? "正在删除…" : "确认删除"}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </main>
  );
}

function toLocalInput(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 23);
}
function MemoryNodeEditor({
  node,
  contentRef,
  busy,
  onDirty,
  onSave,
  onCancel,
}: {
  node: MemoryNode | undefined;
  contentRef?: Ref<HTMLTextAreaElement>;
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: MemoryNodeInput) => Promise<void>;
  onCancel: () => void;
}) {
  const initial = useRef(
    (() => {
      const { occurredAt, tags, ...extra } = node?.metadata ?? {
        occurredAt: new Date().toISOString(),
        tags: [],
        system: "native-v1",
        kind: "self",
        ownerId: "self:kaguya",
        scope: "shared",
        level: 1,
        revision: 0,
        status: "active",
        locked: false,
        sourceIds: [],
        aliases: [],
      };
      return {
        content: node?.content ?? "",
        time: toLocalInput(occurredAt),
        tags: tags.join("，"),
        extra: JSON.stringify(extra, null, 2),
        kind: String(extra.kind ?? "self"),
        expressionType: String(extra.expressionType ?? "habit"),
        ownerId: String(extra.ownerId ?? "self:kaguya"),
        scope: String(extra.scope ?? "shared"),
        level: Number(extra.level ?? 1),
        locked: extra.locked === true,
        status: String(extra.status ?? "active"),
      };
    })(),
  );
  const [draft, setDraft] = useState(initial.current);
  const [error, setError] = useState("");
  useEffect(() => {
    onDirty(JSON.stringify(draft) !== JSON.stringify(initial.current));
  }, [draft, onDirty]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const extra: unknown = JSON.parse(draft.extra);
      if (!extra || typeof extra !== "object" || Array.isArray(extra))
        throw new Error("其他 metadata 必须是 JSON 字典。");
      const input = memoryNodeInputSchema.parse({
        ...(node ? { id: node.id } : {}),
        content: draft.content,
        metadata: {
          ...extra,
          system: "native-v1",
          revision: Number(node?.metadata.revision ?? 0),
          kind: draft.kind,
          ...(draft.kind === "expression"
            ? { expressionType: draft.expressionType }
            : {}),
          ownerId: draft.ownerId,
          scope: draft.scope,
          level: draft.level,
          locked: draft.locked,
          status: draft.status,
          occurredAt: new Date(draft.time).toISOString(),
          tags: splitTags(draft.tags),
        },
      });
      void onSave(input);
    } catch {
      setError(
        "请填写有效的出现时间、非空正文，并检查其他 metadata 是否为 JSON 字典。",
      );
    }
  };
  return (
    <form className="memory-editor" onSubmit={submit}>
      <div className="memory-panel-heading">
        <Dialog.Title asChild>
          <h2>{node ? "编辑记忆" : "新增记忆"}</h2>
        </Dialog.Title>
        <Button disabled={busy} onClick={onCancel} aria-label="关闭节点编辑">
          <X size={17} />
        </Button>
      </div>
      <label className="field">
        类型
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          disabled={busy}
        >
          <option value="person">人物</option>
          <option value="conversation">会话</option>
          <option value="self">自身</option>
          <option value="experience">经历</option>
          <option value="expression">表达</option>
        </select>
      </label>
      {draft.kind === "expression" && (
        <label className="field">
          表达内容
          <select
            value={draft.expressionType}
            onChange={(e) =>
              setDraft({ ...draft, expressionType: e.target.value })
            }
          >
            <option value="habit">表达习惯</option>
            <option value="example">文本示例</option>
            <option value="qq-resource">QQ 表情资源</option>
          </select>
        </label>
      )}
      <label className="field">
        对象 ID
        <input
          required
          value={draft.ownerId}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, ownerId: e.target.value })}
        />
      </label>
      <label className="field">
        适用范围
        <input
          required
          value={draft.scope}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
        />
      </label>
      <label className="field">
        抽象层级 level
        <input
          required
          type="number"
          min="0"
          step="1"
          value={draft.level}
          disabled={busy}
          onChange={(e) =>
            setDraft({ ...draft, level: Number(e.target.value) })
          }
        />
      </label>
      <p>level 0 是适用范围内的唯一固定摘要。其他层级按需召回。</p>
      <label>
        <input
          type="checkbox"
          checked={draft.locked}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
        />
        锁定，禁止自动修改
      </label>
      <label className="field">
        状态
        <select
          value={draft.status}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
        >
          <option value="active">有效</option>
          <option value="invalidated">待整理</option>
          <option value="archived">已归档</option>
        </select>
      </label>
      <label className="field">
        出现时间（本地时区）
        <input
          required
          type="datetime-local"
          step="0.001"
          value={draft.time}
          onChange={(event) => setDraft({ ...draft, time: event.target.value })}
          disabled={busy}
        />
      </label>
      <label className="field">
        标签
        <input
          value={draft.tags}
          onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
          disabled={busy}
          placeholder="用逗号分隔，例如：xxx用户，音乐"
        />
      </label>
      <label className="field">
        内容（文本或 Markdown）
        <textarea
          ref={contentRef}
          required
          rows={8}
          value={draft.content}
          onChange={(event) =>
            setDraft({ ...draft, content: event.target.value })
          }
          disabled={busy}
        />
      </label>
      <details>
        <summary>其他 metadata</summary>
        <label className="field">
          JSON 字典
          <textarea
            className="memory-json-input"
            rows={7}
            value={draft.extra}
            onChange={(event) =>
              setDraft({ ...draft, extra: event.target.value })
            }
            disabled={busy}
          />
        </label>
      </details>
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      <div className="memory-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "正在保存…" : "保存节点"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function MemoryEdgeEditor({
  nodes,
  initial,
  sourceRef,
  relationRef,
  busy,
  onDirty,
  onSave,
  onCancel,
}: {
  nodes: MemoryNode[];
  initial: Extract<Editor, { kind: "edge" }>;
  sourceRef: Ref<HTMLSelectElement>;
  relationRef: Ref<HTMLInputElement>;
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: MemoryEdgeInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [sourceId, setSourceId] = useState(
    initial.sourceId ?? nodes[0]?.id ?? "",
  );
  const [targetId, setTargetId] = useState(
    initial.targetId ??
      nodes.find((node) => node.id !== sourceId)?.id ??
      sourceId,
  );
  const [relation, setRelation] = useState("related");
  const [metadata, setMetadata] = useState("{}");
  const [error, setError] = useState("");
  const initialKey = useRef(
    JSON.stringify([sourceId, targetId, relation, metadata]),
  );
  useEffect(() => {
    onDirty(
      JSON.stringify([sourceId, targetId, relation, metadata]) !==
        initialKey.current,
    );
  }, [sourceId, targetId, relation, metadata, onDirty]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      void onSave(
        memoryEdgeInputSchema.parse({
          sourceId,
          targetId,
          relation,
          metadata: JSON.parse(metadata),
        }),
      );
    } catch {
      setError(
        "请选择两个有效节点，填写关系类型，并检查 metadata 是否为 JSON 字典。",
      );
    }
  };
  return (
    <form className="memory-editor" onSubmit={submit}>
      <div className="memory-panel-heading">
        <Dialog.Title asChild>
          <h2>新增连结</h2>
        </Dialog.Title>
        <Button disabled={busy} onClick={onCancel} aria-label="关闭关系编辑">
          <X size={17} />
        </Button>
      </div>
      <label className="field">
        起点
        <select
          ref={sourceRef}
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          disabled={busy}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {memoryTitle(node)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        终点
        <select
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
          disabled={busy}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {memoryTitle(node)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        关系类型
        <input
          ref={relationRef}
          required
          value={relation}
          onChange={(event) => setRelation(event.target.value)}
          disabled={busy}
          list="memory-relation-types"
        />
        <datalist id="memory-relation-types">
          {["related", "补充", "引用", "支持", "矛盾", "后续"].map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </label>
      <details>
        <summary>按节点 ID 指定两端</summary>
        <label className="field">
          起点 ID
          <input
            required
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          终点 ID
          <input
            required
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            disabled={busy}
          />
        </label>
      </details>
      <details>
        <summary>关系 metadata</summary>
        <label className="field">
          JSON 字典
          <textarea
            rows={5}
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
            disabled={busy}
          />
        </label>
      </details>
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      <div className="memory-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "正在保存…" : "保存连结"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function NativeMemoryDetails({
  node,
  token,
}: {
  node: MemoryNode;
  token: string;
}) {
  const navigate = useWorkbenchNavigate();
  return (
    <section aria-label="记忆层级与来源">
      {node.metadata.kind === "expression" && (
        <p>
          {node.metadata.expressionType === "qq-resource"
            ? "QQ 表情资源"
            : node.metadata.expressionType === "habit"
              ? "表达习惯"
              : node.metadata.expressionType === "example"
                ? "文本示例"
                : "表达内容（未分类）"}
        </p>
      )}
      <dl>
        <dt>层级</dt>
        <dd>
          level {String(node.metadata.level)}
          {node.metadata.level === 0 ? " · 固定注入" : " · 按需召回"}
        </dd>
        <dt>对象</dt>
        <dd>{String(node.metadata.ownerId)}</dd>
        <dt>范围</dt>
        <dd>{String(node.metadata.scope)}</dd>
        <dt>版本</dt>
        <dd>
          {String(node.metadata.revision)} ·{" "}
          {node.metadata.status === "active"
            ? "有效"
            : node.metadata.status === "archived"
              ? "已归档"
              : "待整理"}
          {node.metadata.locked ? " · 手动锁定" : ""}
        </dd>
      </dl>
      <details>
        <summary>来源</summary>
        <pre>{JSON.stringify(node.metadata.sourceIds, null, 2)}</pre>
      </details>
      <p>
        <a
          href={`/memory?inspect=memory&selected=${encodeURIComponent(node.id)}`}
          onClick={(event) => {
            if (
              event.button ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            void navigate(
              `/memory?inspect=memory&selected=${encodeURIComponent(node.id)}`,
            );
          }}
        >
          按原观察查看精确修订与来源
        </a>
      </p>
    </section>
  );
}
