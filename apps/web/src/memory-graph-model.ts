/**
 * 功能概述：将不可变的 Memory 快照适配为力导向图使用的独立节点和边。
 * 主要职责：生成摘要、无歧义边 ID、平行边曲率及节点邻接集合；模拟器可修改副本坐标。
 * 代码库关系：MemoryGraphCanvas 和 MemoryGraph 共享此模型，避免图引擎改写领域对象。
 * 输入输出与副作用：纯函数，不执行 I/O，不修改传入快照。
 */
import type { MemoryGraphSnapshot, MemoryNode } from "@kaguya/schema";
export interface MemoryGraphDot {
  id: string;
  title: string;
  tags: string[];
  x?: number;
  y?: number;
}
export interface MemoryGraphLine {
  id: string;
  source: string | MemoryGraphDot;
  target: string | MemoryGraphDot;
  relation: string;
  curvature: number;
}
export const graphEndpointId = (endpoint: string | MemoryGraphDot) =>
  typeof endpoint === "string" ? endpoint : endpoint.id;
export function memoryTitle(node: MemoryNode): string {
  return (
    node.content
      .split("\n")
      .find((line) => line.trim())
      ?.replace(/^#+\s*/, "")
      .trim()
      .slice(0, 64) || "未命名记忆"
  );
}
export function memoryEdgeId(edge: {
  sourceId: string;
  targetId: string;
  relation: string;
}): string {
  return JSON.stringify([edge.sourceId, edge.targetId, edge.relation]);
}
export function memoryForceData(snapshot: MemoryGraphSnapshot): {
  nodes: MemoryGraphDot[];
  links: MemoryGraphLine[];
} {
  const groups = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const pair = JSON.stringify([edge.sourceId, edge.targetId].sort());
    groups.set(pair, [...(groups.get(pair) ?? []), memoryEdgeId(edge)]);
  }
  return {
    nodes: snapshot.nodes.map((node, index) => ({
      id: node.id,
      title: memoryTitle(node),
      tags: [...node.metadata.tags],
      x: Math.cos(index * 2.39996) * Math.sqrt(index + 1) * 44,
      y: Math.sin(index * 2.39996) * Math.sqrt(index + 1) * 44,
    })),
    links: snapshot.edges.map((edge) => {
      const group = groups.get(
        JSON.stringify([edge.sourceId, edge.targetId].sort()),
      )!;
      const index = group.indexOf(memoryEdgeId(edge));
      return {
        id: memoryEdgeId(edge),
        source: edge.sourceId,
        target: edge.targetId,
        relation: edge.relation,
        curvature:
          edge.sourceId === edge.targetId
            ? 0.5 + index * 0.2
            : (index - (group.length - 1) / 2) *
              0.3 *
              (edge.sourceId < edge.targetId ? 1 : -1),
      };
    }),
  };
}
