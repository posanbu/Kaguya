/**
 * 功能概述：直接使用 Inspection Manifest 绘制可聚焦的模块信息流，不维护另一份架构清单。
 * moduleConnections 按 produces/consumes 的稳定 Kind 计算有向边；ModuleTopology 选中模块后展示上下游。
 * 每个模块按钮可键盘操作，激活状态来自 bindings；同名 Kind 和重复边去重，外部平台不伪装为本地模块。
 * 由 ModuleOverview 挂载；无额外请求或运行状态推断，接口只反映当前返回的 Catalog 与 activation。
 */
import { useState } from "react";
import { ArrowRight, Boxes, GitBranch } from "lucide-react";
import type { InspectionModule } from "@kaguya/schema";
import { StatusBadge } from "./components/ui.js";
export function moduleConnections(modules: readonly InspectionModule[]) {
  return modules.flatMap((from) =>
    modules
      .filter((to) => to.definitionId !== from.definitionId)
      .flatMap((to) => {
        const kinds = [
          ...new Set(
            from.produces
              .filter((k) => to.consumes.some((c) => c.kind === k.kind))
              .map((k) => k.kind),
          ),
        ];
        return kinds.length
          ? [{ from: from.definitionId, to: to.definitionId, kinds }]
          : [];
      }),
  );
}
export function ModuleTopology({
  modules,
}: {
  modules: readonly InspectionModule[];
}) {
  const [selected, setSelected] = useState("");
  const current =
    modules.find((m) => m.definitionId === selected) ?? modules[0];
  if (!current) return null;
  const connections = moduleConnections(modules);
  const upstream = connections.filter((c) => c.to === current.definitionId);
  const downstream = connections.filter((c) => c.from === current.definitionId);
  const render = (items: typeof connections, side: "from" | "to") =>
    items.length ? (
      items.map((edge) => {
        const module = modules.find((m) => m.definitionId === edge[side])!;
        return (
          <div className="topology-node" key={edge[side]}>
            <button
              type="button"
              onClick={() => setSelected(module.definitionId)}
            >
              <Boxes size={16} aria-hidden="true" />
              {module.displayName}
            </button>
            <StatusBadge tone={module.bindings.length ? "success" : "neutral"}>
              {module.bindings.length ? "已激活" : "未激活"}
            </StatusBadge>
            <details>
              <summary>{edge.kinds.length} 种信息</summary>
              {edge.kinds.map((kind) => (
                <code key={kind}>{kind}</code>
              ))}
            </details>
          </div>
        );
      })
    ) : (
      <p className="topology-empty">没有已声明的本地连接</p>
    );
  return (
    <section className="module-topology" aria-label="模块信息流拓扑">
      <div className="topology-toolbar">
        <h2>
          <GitBranch size={18} aria-hidden="true" /> 模块信息流
        </h2>
        <label>
          聚焦模块
          <select
            value={current.definitionId}
            onChange={(e) => setSelected(e.target.value)}
          >
            {modules.map((m) => (
              <option key={m.definitionId} value={m.definitionId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="topology-grid">
        <section>
          <h3>上游输入</h3>
          {render(upstream, "from")}
        </section>
        <div className="topology-focus">
          <ArrowRight aria-hidden="true" />
          <strong>{current.displayName}</strong>
          <StatusBadge tone={current.bindings.length ? "success" : "neutral"}>
            {current.bindings.length} 个激活实例
          </StatusBadge>
          <span>
            {current.selectors.length} 个 Selector · {current.requires.length}{" "}
            项能力依赖
          </span>
          <ArrowRight aria-hidden="true" />
        </div>
        <section>
          <h3>下游消费</h3>
          {render(downstream, "to")}
        </section>
      </div>
      <p className="topology-note">
        连线来自当前 Manifest；表示信息契约，不代表本次消息已执行。
      </p>
    </section>
  );
}
