/**
 * 功能概述：将模块声明的真实持久化存储展示为可扫描的一行式表格，并按需追溯来源消息。
 * 主要职责：按声明列选择字段、压缩会话等结构化值并稳定分页；原始记忆表只承担浏览，不展开 Atom 技术详情。
 * 代码库关系：ModuleSurface 分派 storage-browser 到本组件；数据复用既有模块 storage API 与 DTO。
 * 输入输出与副作用：只执行认证 GET 和页内选择，不修改存储；正文仅作为文本渲染并在单元格截断。
 */
import {
  inspectionStorageSchema,
  type InspectionModule,
  type JsonValue,
  type ModuleInspectionSurfaceV1,
} from "@kaguya/schema";
import { useState } from "react";
import { statusLabel } from "./InspectionFields.js";
import { InspectionPager } from "./ModuleRuntimeSection.js";
import { useInspection } from "./use-inspection.js";
import { FieldMessage } from "./components/ui.js";

type StorageBrowser = Extract<
  ModuleInspectionSurfaceV1["components"][number],
  { type: "storage-browser" }
>;

export function compactStorageValue(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" && !value.trim()) return "—";
  if (Array.isArray(value))
    return value.map((item) => compactStorageValue(item)).join("、") || "—";
  if (typeof value === "object")
    return (
      Object.entries(value)
        .map(([key, item]) =>
          key === "kind" && typeof item === "string"
            ? statusLabel(item)
            : compactStorageValue(item),
        )
        .filter(Boolean)
        .join(" · ") || "—"
    );
  return String(value);
}

function cellValue(label: string, value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  const compact = compactStorageValue(value);
  if (!label.includes("时间") || typeof value !== "string") return compact;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? compact
    : new Date(timestamp).toLocaleString();
}

export function StorageSurface({
  module,
  browser,
  token,
  revision,
}: {
  module: InspectionModule;
  browser: StorageBrowser;
  token: string;
  revision: number;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const state = useInspection(
    token,
    `modules/${encodeURIComponent(module.definitionId)}/storage?limit=20${
      cursors.length ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ""
    }`,
    inspectionStorageSchema,
    revision,
  );
  if (state.error)
    return (
      <FieldMessage tone="error">
        原始记忆读取失败：{state.error}。请刷新后重试。
      </FieldMessage>
    );
  if (!state.data) return <FieldMessage>正在加载原始记忆…</FieldMessage>;
  if (!state.data.available)
    return <FieldMessage>原始记忆存储尚未建立。</FieldMessage>;

  return (
    <section className="module-surface storage-surface" aria-label="原始记忆">
      <p className="surface-result-note" role="status">
        本页 {state.data.items.length} 条
      </p>
      {state.data.items.length ? (
        <div className="storage-table" role="table" aria-label="原始记忆列表">
          <div className="storage-table-grid storage-table-header" role="row">
            {browser.columns.map((column) => (
              <span key={column} role="columnheader">
                {column}
              </span>
            ))}
          </div>
          <ol>
            {state.data.items.map((item) => {
              const fields = new Map(
                item.fields.map((field) => [field.label, field.value]),
              );
              return (
                <li
                  key={item.id}
                  className="storage-table-grid storage-table-row"
                  title={item.id}
                >
                  {browser.columns.map((column) => (
                    <span
                      key={column}
                      role="cell"
                      title={cellValue(column, fields.get(column))}
                    >
                      {cellValue(column, fields.get(column))}
                    </span>
                  ))}
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <FieldMessage>{browser.empty}</FieldMessage>
      )}
      <InspectionPager
        cursors={cursors}
        next={state.data.nextCursor}
        change={(next) => {
          setCursors(next);
        }}
      />
    </section>
  );
}
