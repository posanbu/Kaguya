/**
 * 功能概述：验证力导向适配器隔离领域快照并保留有向、多类型和自环关系。
 * 主要职责：模拟图引擎改写坐标及端点，断言原始 metadata／关系不被改写；检查边标识和曲线不混淆。
 * 代码库关系：测试 memory-graph-model，避免加载依赖浏览器 canvas 的图引擎。
 * 输入输出与副作用：仅纯内存对象，无浏览器、网络或数据库。
 */
import { expect, it } from "vitest";
import type { MemoryGraphSnapshot } from "@kaguya/schema";
import { memoryForceData, memoryEdgeId } from "./memory-graph-model.js";

function snapshot(): MemoryGraphSnapshot {
  return {
    nodes: ["a", "b"].map((id) => ({
      id,
      metadata: { occurredAt: "2026-10-17T04:00:00Z", tags: ["音乐"] },
      content: `# ${id}\n\n正文`,
    })),
    edges: [
      { sourceId: "a", targetId: "b", relation: "补充", metadata: {} },
      { sourceId: "a", targetId: "b", relation: "支持", metadata: {} },
      { sourceId: "b", targetId: "a", relation: "引用", metadata: {} },
      { sourceId: "a", targetId: "a", relation: "复习", metadata: {} },
    ],
    hasMoreNodes: false,
    hasMoreEdges: false,
  };
}
it("allows force-engine mutations without modifying the source snapshot", () => {
  const source = snapshot();
  const before = structuredClone(source);
  const data = memoryForceData(source);
  data.nodes[0]!.x = 1000;
  data.nodes[0]!.tags.push("视图标签");
  data.links[0]!.source = data.nodes[0]!;
  expect(source).toEqual(before);
});
it("preserves directional relation identities and gives parallel links distinct visible curves", () => {
  const source = snapshot();
  const data = memoryForceData(source);
  expect(new Set(data.links.map((edge) => edge.id)).size).toBe(4);
  expect(
    data.links.map((edge) => [edge.source, edge.target, edge.relation]),
  ).toEqual(
    source.edges.map((edge) => [edge.sourceId, edge.targetId, edge.relation]),
  );
  const parallel = data.links
    .slice(0, 3)
    .map((edge) => edge.curvature * (edge.source < edge.target ? 1 : -1));
  expect(new Set(parallel).size).toBe(3);
  expect(data.links[3]!.curvature).toBeGreaterThan(0);
  expect(
    memoryEdgeId({ sourceId: "a:b", targetId: "c", relation: "d" }),
  ).not.toBe(memoryEdgeId({ sourceId: "a", targetId: "b:c", relation: "d" }));
});
