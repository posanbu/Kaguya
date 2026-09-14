/**
 * 功能概述：从有界 Inspection Flow 提炼消息阶段与可导出的紧凑 trace，减少手动翻查原子。
 * summarizeFlow 只归类已观察事实，不将缺失节点认定为失败；FlowSummary 展示阶段计数及显式截断状态。
 * 导出仅包含已脱敏 DTO 的节点元数据、引用与截断标记，没有 payload、Prompt 或凭据。
 * DeveloperConsole 在 DAG 前挂载；下载由用户点击触发，创建的临时 URL 随后释放。
 */
import type { InspectionFlow } from "@kaguya/schema";
import { Download } from "lucide-react";
import { Button } from "./components/ui.js";
const stages = [
  { label: "入站", matches: (k: string) => k === "core.message.inbound.text" },
  {
    label: "观察",
    matches: (k: string) =>
      k.startsWith("agent.heartbeat.") || k.startsWith("agent.observation."),
  },
  {
    label: "冻结",
    matches: (k: string) => k === "agent.turn.context.completed",
  },
  { label: "关注", matches: (k: string) => k.startsWith("agent.attention.") },
  { label: "规划", matches: (k: string) => k === "agent.turn.plan.completed" },
  { label: "表达", matches: (k: string) => k.startsWith("agent.expression.") },
  { label: "投递", matches: (k: string) => k.startsWith("core.delivery.") },
  {
    label: "终态",
    matches: (k: string) =>
      /^agent\.turn\.(completed|failed|silent|waiting|superseded)$/.test(k),
  },
];
export function summarizeFlow(flow: InspectionFlow) {
  return stages.map((stage) => ({
    label: stage.label,
    count: flow.nodes.filter((n) => stage.matches(n.kind)).length,
  }));
}
export function FlowSummary({ flow }: { flow: InspectionFlow }) {
  function download() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: 1,
            truncated: flow.truncated,
            externalReferences: flow.externalReferences,
            stages: summarizeFlow(flow),
            nodes: flow.nodes,
            edges: flow.edges,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "kaguya-flow-trace.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="flow-summary" aria-label="消息阶段摘要">
      <ol>
        {summarizeFlow(flow).map((s) => (
          <li key={s.label} data-observed={s.count > 0}>
            <strong>{s.count}</strong>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
      <div>
        <small>
          {flow.truncated ? "部分视图 · 已截断" : "当前查询范围"}
          ；零计数仅表示未观察到该阶段。
        </small>
        <Button onClick={download}>
          <Download size={15} aria-hidden="true" />
          导出诊断
        </Button>
      </div>
    </section>
  );
}
