/**
 * 功能概述：独立的联想设计预览入口，以演示状态承载生产 ModuleSurface，便于用户实时引导。
 * 外壳保持紧凑的页标题，避免预览面包屑和说明层级挤占实际工作区。
 * 主要职责：Preview 加载正式 Manifest 并切换正常、空库、错误与加载场景；PreviewTrace 用生产只读 API 展示来源及引用。
 * 代码库关系：只由 preview-association.html 加载，不进入正式 main.tsx；前端源码修改通过 Vite HMR 更新。
 * 输入输出与副作用：请求同源预览进程，所有内容明确标注演示；不保存令牌或连接生产服务。
 */
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  inspectionModuleSchema,
  inspectionDetailSchema,
  type InspectionModule,
} from "@kaguya/schema";
import { ModuleSurface } from "../ModuleSurface.js";
import { InspectionFields, ReadableValue } from "../InspectionFields.js";
import { useInspection } from "../use-inspection.js";
import type { InspectionDetailProps } from "../ModuleRuntimeSection.js";
import { Button, FieldMessage } from "../components/ui.js";
import "../styles.css";
import "../components/workbench.css";
import "../developer.css";
import "./association.css";
function Preview() {
  const [module, setModule] = useState<InspectionModule>();
  const [error, setError] = useState("");
  const [state, setState] = useState("normal");
  useEffect(() => {
    void fetch("/__preview/module")
      .then((response) => response.json())
      .then((value) => setModule(inspectionModuleSchema.parse(value)))
      .catch((reason) => setError(String(reason)));
  }, []);
  return (
    <div className="association-preview">
      <div className="preview-bar">
        <span>
          <strong>设计预览</strong> · 演示数据
        </span>
        <fieldset>
          <legend>预览状态</legend>
          {[
            ["normal", "正常记录"],
            ["empty", "空库"],
            ["error", "读取失败"],
            ["loading", "持续加载"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={state === value}
              onClick={() => setState(value!)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <span className="preview-live">保存代码后自动更新</span>
      </div>
      <main>
        <header className="preview-header">
          <h1>记忆联想</h1>
          <p>检查一次查询召回了什么，以及材料来自哪里。</p>
        </header>
        {error && <FieldMessage tone="error">{error}</FieldMessage>}
        {module && (
          <ModuleSurface
            key={state}
            module={module}
            token={`preview-${state}`}
            revision={0}
            DetailComponent={PreviewTrace}
          />
        )}
      </main>
    </div>
  );
}
function PreviewTrace({
  token,
  selected,
  select,
  revision,
}: InspectionDetailProps) {
  const state = useInspection(
    token,
    selected ? `atoms/${encodeURIComponent(selected)}` : undefined,
    inspectionDetailSchema,
    revision,
  );
  if (state.error)
    return <FieldMessage tone="error">{state.error}</FieldMessage>;
  if (!state.data) return <FieldMessage>正在读取来源…</FieldMessage>;
  const { atom } = state.data;
  return (
    <div className="preview-trace">
      <p>
        <code>{atom.informationId}</code>
      </p>
      <p>{atom.kind}</p>
      <InspectionFields fields={atom.presentation?.fields ?? []} />
      <details>
        <summary>完整字段</summary>
        <ReadableValue value={atom.payload} />
      </details>
      <h3>引用的记录</h3>
      {!atom.references.length && <p>无</p>}
      {atom.references.map((ref) => (
        <Button
          key={`${ref.relation}:${ref.informationId}`}
          onClick={() => select(ref.informationId)}
        >
          {ref.relation} → {ref.informationId}
        </Button>
      ))}
      <h3>引用此记录</h3>
      {state.data.referencedBy.map((item) => (
        <Button
          key={item.informationId}
          onClick={() => select(item.informationId)}
        >
          {item.presentation?.title ?? item.kind}
        </Button>
      ))}
    </div>
  );
}
// 入口模块自身热更新时复用 Root，避免同一个 DOM 容器重复 createRoot。
const root: Root =
  (import.meta.hot?.data.previewRoot as Root | undefined) ??
  createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.previewRoot = root;
root.render(<Preview />);
