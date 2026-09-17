/**
 * 功能概述：验证诊断视图由真实 Manifest/Flow DTO 推导，不混淆定义、激活和已观察事实。
 * 拓扑测试覆盖方向与去重；阶段摘要不把缺失节点判定为失败，诊断导出不得夹带正文摘要。
 * 使用静态渲染检查语义和字段，浏览器视口布局由单独截图验证，无网络或平台副作用。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { InspectionModule, InspectionFlow } from "@kaguya/schema";
import { moduleConnections, ModuleTopology } from "./ModuleTopology.js";
import { summarizeFlow, FlowSummary, diagnosticTrace } from "./FlowSummary.js";
const kind = {
  kind: "test.input",
  displayName: "输入事实",
  description: "可供下游读取的事实",
};
const base: InspectionModule = {
  definitionId: "source",
  displayName: "来源模块",
  summary: "来源",
  description: "产生输入事实",
  moduleVersion: "1",
  protocolVersion: 1,
  settingsSchemaFingerprint: "test",
  consumes: [],
  produces: [kind, kind],
  selectors: [],
  promptRenderers: [],
  diagnostics: [],
  requires: [],
  provides: [],
  bindings: [],
};
it("derives directional connections once and distinguishes inactive definitions", () => {
  const modules = [
    base,
    {
      ...base,
      definitionId: "sink",
      displayName: "下游模块",
      produces: [],
      consumes: [kind],
    },
  ];
  expect(moduleConnections(modules)).toEqual([
    { from: "source", to: "sink", kinds: [kind.kind] },
  ]);
  const html = renderToStaticMarkup(<ModuleTopology modules={modules} />);
  expect(html).toContain("未激活");
  expect(html).toContain("0 个激活实例");
  expect(html).toContain("不代表本次消息已执行");
});
it("summarizes observed stages without interpreting missing or truncated data as failure", () => {
  const flow = {
    version: 1,
    contextInformationId: "context",
    nodes: [
      {
        informationId: "in",
        kind: "core.message.inbound.text",
        occurredAt: "2026-09-14T00:00:00Z",
        source: "test",
        presentation: {
          title: "入站",
          fields: [{ label: "正文", value: "private-message" }],
        },
      },
    ],
    edges: [],
    truncated: true,
    externalReferences: 2,
  } as InspectionFlow;
  expect(summarizeFlow(flow).find((s) => s.label === "入站")?.count).toBe(1);
  expect(summarizeFlow(flow).find((s) => s.label === "终态")?.count).toBe(0);
  const html = renderToStaticMarkup(<FlowSummary flow={flow} />);
  expect(html).toContain("部分视图");
  expect(html).toContain("零计数仅表示未观察到该阶段");
  const trace = diagnosticTrace(flow);
  expect(trace.nodes[0]).toEqual({
    informationId: "in",
    kind: "core.message.inbound.text",
    occurredAt: "2026-09-14T00:00:00Z",
    source: "test",
  });
  expect(JSON.stringify(trace)).not.toContain("private-message");
});
