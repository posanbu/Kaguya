/**
 * 功能概述：验证节点颜色所传达的标签、时间和当前图关联度与原始数据一致。
 * 主要职责：覆盖筛选后颜色稳定、图例计数、时间区间边界、未来时间及多类型边／自环计数。
 * 代码库关系：直接测试 memoryColorEncoding 的纯计算，不加载 canvas 或启动数据库。
 * 输入输出与副作用：使用固定参考时刻和内存快照，无外部 I/O 或全局时钟修改。
 */
import { expect, it } from "vitest";
import type { MemoryGraphSnapshot, MemoryNode } from "@kaguya/schema";
import { memoryColorEncoding } from "./memory-graph-colors.js";
const now = Date.parse("2026-10-17T04:00:00Z");
const day = 86_400_000;
function node(id: string, tags: string[] = ["音乐"], age = 0): MemoryNode {
  return {
    id,
    content: id,
    metadata: { tags, occurredAt: new Date(now - age).toISOString() },
  };
}
function snapshot(
  nodes: MemoryNode[],
  edges: MemoryGraphSnapshot["edges"] = [],
): MemoryGraphSnapshot {
  return { nodes, edges, hasMoreNodes: false, hasMoreEdges: false };
}
it("keeps tag colors stable through filtering and labels the first tag without losing untagged nodes", () => {
  const full = snapshot([
    node("a", ["音乐", "小林"]),
    node("b", ["音乐"]),
    node("c", ["小林"]),
    node("d", []),
    node("e", ["无标签"]),
  ]);
  const all = memoryColorEncoding(full, "tag", now);
  const filtered = memoryColorEncoding(
    snapshot([full.nodes[2]!, full.nodes[0]!]),
    "tag",
    now,
  );
  expect(all.nodes.get("a")?.label).toBe("音乐");
  expect(all.nodes.get("a")?.color).toBe(all.nodes.get("b")?.color);
  expect(filtered.nodes.get("a")?.color).toBe(all.nodes.get("a")?.color);
  expect(filtered.nodes.get("c")?.color).toBe(all.nodes.get("c")?.color);
  expect(all.nodes.get("d")?.key).not.toBe(all.nodes.get("e")?.key);
  expect(all.groups.reduce((sum, group) => sum + group.count, 0)).toBe(
    full.nodes.length,
  );
  const many = memoryColorEncoding(
    snapshot(
      Array.from({ length: 12 }, (_, i) => node(String(i), [`标签${i}`])),
    ),
    "tag",
    now,
  );
  expect(many.groups).toHaveLength(9);
  expect(many.groups.find((group) => group.key === "other-tags")?.count).toBe(
    4,
  );
});
it("uses occurrence time with exact rolling-day boundaries and a distinct future group", () => {
  const data = snapshot([
    node("recent", [], day),
    node("week", [], day + 1),
    node("month", [], 7 * day + 1),
    node("old", [], 30 * day + 1),
    node("future", [], -1),
  ]);
  const encoding = memoryColorEncoding(data, "time", now);
  expect([...encoding.nodes.values()].map((group) => group.label)).toEqual([
    "24 小时内",
    "1–7 天",
    "7–30 天",
    "30 天前",
    "未来时间",
  ]);
  expect(encoding.groups.map((group) => group.count)).toEqual([1, 1, 1, 1, 1]);
});
it("counts directional typed relationships while counting each self-loop once", () => {
  const edge = (sourceId: string, targetId: string, relation: string) => ({
    sourceId,
    targetId,
    relation,
    metadata: {},
  });
  const data = snapshot(
    [node("a"), node("b"), node("c"), node("d")],
    [
      edge("a", "a", "自环"),
      edge("a", "b", "引用"),
      ...Array.from({ length: 6 }, (_, i) => edge("b", "c", `类型${i}`)),
    ],
  );
  const encoding = memoryColorEncoding(data, "degree", now);
  expect([...encoding.nodes.values()].map((group) => group.label)).toEqual([
    "1–2 条",
    "6 条及以上",
    "6 条及以上",
    "0 条",
  ]);
  expect(encoding.groups.map((group) => group.count)).toEqual([1, 1, 0, 2]);
});
