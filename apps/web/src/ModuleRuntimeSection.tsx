/**
 * 功能概述：以模块自描述视图浏览运行历史和真实存储，机制说明与可编辑配置分开。
 * ModuleRuntimeSection 提供领域标签、实例/时间/Kind 过滤和游标分页；StorageRecords 浏览全局持久库。
 * 详情组件由 DeveloperConsole 注入以复用引用导航；useInspection 取消过期请求，切换过滤清空选择。
 * 仅 GET；页内计数明确不代表全库，inactive 保留历史入口，可选库不可用与空库区分。
 */
import { useState, type ComponentType, type FormEvent } from "react";
import {
  inspectionPageSchema,
  inspectionStorageSchema,
  type InspectionModule,
} from "@kaguya/schema";
import { useInspection } from "./use-inspection.js";
import { InspectionFields, InspectionStatus } from "./InspectionFields.js";
import { Button, FieldMessage } from "./components/ui.js";
export interface InspectionDetailProps {
  token: string;
  selected: string | undefined;
  select: (id: string) => void;
  revision: number;
}
export function ModuleRuntimeSection({
  module,
  token,
  revision,
  DetailComponent,
}: {
  module: InspectionModule;
  token: string;
  revision: number;
  DetailComponent: ComponentType<InspectionDetailProps>;
}) {
  const views = module.inspection?.views ?? [];
  const [viewId, setViewId] = useState(
    module.inspection?.storage ? "storage" : (views[0]?.id ?? ""),
  );
  const [filters, setFilters] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, select] = useState<string>();
  const view = views.find((v) => v.id === viewId);
  const query = new URLSearchParams(filters);
  query.set("definitionId", module.definitionId);
  query.set("view", viewId);
  query.set("limit", "20");
  if (cursors.length) query.set("cursor", cursors.at(-1)!);
  const state = useInspection(
    token,
    view ? `atoms?${query}` : undefined,
    inspectionPageSchema,
    revision,
  );
  function change(id: string) {
    setViewId(id);
    setFilters("");
    setCursors([]);
    select(undefined);
  }
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget),
      params = new URLSearchParams();
    for (const key of ["source", "kind", "after", "before"]) {
      const value = String(data.get(key) ?? "");
      if (value)
        params.set(
          key,
          key === "after" || key === "before"
            ? new Date(value).toISOString()
            : value,
        );
    }
    setFilters(params.toString());
    setCursors([]);
    select(undefined);
  }
  return (
    <section aria-label="模块运行检查" className="module-runtime">
      {!module.bindings.length && (
        <FieldMessage>
          当前未激活。下方仍可查看持久化历史与共享数据。
        </FieldMessage>
      )}
      <div className="inspection-tabs" aria-label="模块数据视图">
        {module.inspection?.storage && (
          <Button
            aria-pressed={viewId === "storage"}
            onClick={() => change("storage")}
          >
            数据存储
          </Button>
        )}
        {views.map((v) => (
          <Button
            key={v.id}
            aria-pressed={viewId === v.id}
            onClick={() => change(v.id)}
          >
            {v.title}
          </Button>
        ))}
      </div>
      {module.inspection && (
        <details className="developer-card inspection-mechanism">
          <summary>运行机制</summary>
          <ol>
            {module.inspection.mechanism.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ol>
        </details>
      )}
      {viewId === "storage" ? (
        <StorageRecords
          key={module.definitionId}
          module={module}
          token={token}
          revision={revision}
          DetailComponent={DetailComponent}
        />
      ) : (
        view && (
          <>
            <h3>{view.title}</h3>
            <p className="inspection-muted">{view.description}</p>
            <form className="developer-filters" onSubmit={apply} key={viewId}>
              <label>
                记录类型
                <select name="kind">
                  <option value="">全部类型</option>
                  {view.kinds.map((k) => (
                    <option key={k} value={k}>
                      {[...module.produces, ...module.consumes].find(
                        (v) => v.kind === k,
                      )?.displayName ?? k}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                来源实例
                <select name="source">
                  <option value="">全部来源（含历史）</option>
                  {module.bindings.map((b) => (
                    <option key={b.instanceId} value={`module:${b.instanceId}`}>
                      {b.instanceId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                开始时间
                <input type="datetime-local" name="after" />
              </label>
              <label>
                结束时间
                <input type="datetime-local" name="before" />
              </label>
              <Button type="submit">筛选</Button>
            </form>
            {state.error ? (
              <FieldMessage tone="error">读取失败：{state.error}</FieldMessage>
            ) : !state.data ? (
              <FieldMessage>正在加载运行记录…</FieldMessage>
            ) : (
              <>
                <p className="inspection-muted">
                  本页 {state.data.items.length} 条 · 按发生时间倒序 ·
                  非全库统计{state.data.truncated ? " · 还有更多记录" : ""}
                </p>
                <div className="developer-split">
                  <ol className="inspection-records">
                    {!state.data.items.length && (
                      <li>
                        <FieldMessage>
                          此查询范围没有记录。未观察到结果不等于执行失败。
                        </FieldMessage>
                      </li>
                    )}
                    {state.data.items.map((a) => (
                      <li
                        key={a.informationId}
                        className="developer-card"
                        data-selected={a.informationId === selected}
                      >
                        <header>
                          <h4>{a.presentation?.title ?? a.kind}</h4>
                          {a.presentation?.status && (
                            <InspectionStatus value={a.presentation.status} />
                          )}
                        </header>
                        <time>{new Date(a.occurredAt).toLocaleString()}</time>
                        <InspectionFields
                          fields={(a.presentation?.fields ?? [])
                            .filter((f) => f.label !== "结果")
                            .slice(0, 4)}
                        />
                        <Button
                          onClick={() => select(a.informationId)}
                          aria-pressed={selected === a.informationId}
                        >
                          查看详情与来源
                        </Button>
                        <small title={a.informationId}>
                          {a.source} · {a.informationId.slice(0, 8)}
                        </small>
                      </li>
                    ))}
                  </ol>
                  <DetailComponent
                    token={token}
                    selected={selected}
                    select={select}
                    revision={revision}
                  />
                </div>
                <InspectionPager
                  cursors={cursors}
                  next={state.data.nextCursor}
                  change={(c) => {
                    setCursors(c);
                    select(undefined);
                  }}
                />
              </>
            )}
          </>
        )
      )}
    </section>
  );
}
export function InspectionPager({
  cursors,
  next,
  change,
}: {
  cursors: string[];
  next: string | null;
  change: (c: string[]) => void;
}) {
  return (
    <div className="developer-pager">
      <Button
        disabled={!cursors.length}
        onClick={() => change(cursors.slice(0, -1))}
      >
        上一页
      </Button>
      <span>第 {cursors.length + 1} 页</span>
      <Button
        disabled={!next}
        onClick={() => next && change([...cursors, next])}
      >
        下一页
      </Button>
    </div>
  );
}
function StorageRecords({
  module,
  token,
  revision,
  DetailComponent,
}: {
  module: InspectionModule;
  token: string;
  revision: number;
  DetailComponent: ComponentType<InspectionDetailProps>;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, select] = useState<string>();
  const state = useInspection(
    token,
    `modules/${encodeURIComponent(module.definitionId)}/storage?limit=20${cursors.length ? "&cursor=" + encodeURIComponent(cursors.at(-1)!) : ""}`,
    inspectionStorageSchema,
    revision,
  );
  if (state.error)
    return (
      <FieldMessage tone="error">数据读取失败：{state.error}</FieldMessage>
    );
  if (!state.data) return <FieldMessage>正在加载存储记录…</FieldMessage>;
  const data = state.data;
  return (
    <>
      <h3>{data.title}</h3>
      <p className="inspection-muted">{data.description}</p>
      {!data.available ? (
        <FieldMessage>此存储尚未建立，当前不可检查。</FieldMessage>
      ) : (
        <>
          <p className="inspection-muted">
            本页 {data.items.length} 条 · 非全库统计
          </p>
          <div className="developer-split">
            <ol className="inspection-records">
              {!data.items.length && (
                <li>
                  <FieldMessage>此页没有存储记录。</FieldMessage>
                </li>
              )}
              {data.items.map((item) => (
                <li key={item.id} className="developer-card">
                  <InspectionFields fields={item.fields} />
                  <code>{item.id}</code>
                  {item.sourceInformationId && (
                    <Button onClick={() => select(item.sourceInformationId)}>
                      追溯来源消息
                    </Button>
                  )}
                </li>
              ))}
            </ol>
            <DetailComponent
              token={token}
              selected={selected}
              select={select}
              revision={revision}
            />
          </div>
          <InspectionPager
            cursors={cursors}
            next={data.nextCursor}
            change={(c) => {
              setCursors(c);
              select(undefined);
            }}
          />
        </>
      )}
    </>
  );
}
