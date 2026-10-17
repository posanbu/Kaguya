/**
 * 功能概述：把标签、出现时间或当前图关系条数映射为节点颜色和文字图例。
 * 主要职责：memoryColorEncoding 返回逐节点颜色与分组计数；标签颜色由名称稳定生成，
 * 多标签按首个标签分组，最多展开八组，其余归入“其他标签”；时间和关联度使用固定分段。
 * 代码库关系：MemoryGraphCanvas 绘制节点并展示同一份图例；不改变 metadata 或持久化数据。
 * 输入输出与副作用：接收快照、模式、参考时刻和主题，执行纯计算；自环只计为一条关系。
 */
import type { MemoryGraphSnapshot } from "@kaguya/schema";
export type MemoryColorMode = "tag" | "time" | "degree";
export interface MemoryColorGroup {
  key: string;
  label: string;
  color: string;
  count: number;
}
const DAY = 86_400_000;
const neutral = (dark: boolean) => (dark ? "#aaa6b5" : "#807d89");
function tagColor(tag: string, dark: boolean): string {
  let hash = 2166136261;
  for (const character of tag)
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  const hue = (hash / 0x1_0000_0000) * 360;
  return `hsl(${hue.toFixed(2)} 58% ${dark ? 68 : hue >= 40 && hue <= 170 ? 33 : 43}%)`;
}
export function memoryColorEncoding(
  snapshot: MemoryGraphSnapshot,
  mode: MemoryColorMode,
  now: number,
  dark = false,
): {
  groups: MemoryColorGroup[];
  nodes: Map<string, MemoryColorGroup>;
} {
  const groups: MemoryColorGroup[] = [];
  const nodes = new Map<string, MemoryColorGroup>();
  const add = (key: string, label: string, color: string) => {
    const group = { key, label, color, count: 0 };
    groups.push(group);
    return group;
  };
  if (mode === "tag") {
    const counts = new Map<string, number>();
    snapshot.nodes.forEach((node) => {
      const tag = node.metadata.tags[0];
      if (tag !== undefined) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    });
    const tags = [...counts].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const displayed = new Map(
      tags
        .slice(0, 8)
        .map(([tag]) => [tag, add(`tag:${tag}`, tag, tagColor(tag, dark))]),
    );
    const other =
      tags.length > 8
        ? add("other-tags", "其他标签", neutral(dark))
        : undefined;
    const untagged = snapshot.nodes.some(
      (node) => node.metadata.tags.length === 0,
    )
      ? add("untagged", "无标签", dark ? "#77717f" : "#938e99")
      : undefined;
    snapshot.nodes.forEach((node) => {
      const tag = node.metadata.tags[0];
      const group =
        tag === undefined ? untagged! : (displayed.get(tag) ?? other!);
      group.count += 1;
      nodes.set(node.id, group);
    });
  } else if (mode === "time") {
    const colors = dark
      ? ["#70adff", "#9aa9e2", "#aaa0c0", "#8b8792", "#e7bd63"]
      : ["#2563bc", "#5a69a6", "#81739b", "#86808d", "#9c6905"];
    const buckets = [
      "24 小时内",
      "1–7 天",
      "7–30 天",
      "30 天前",
      "未来时间",
    ].map((label, index) => add(`time:${index}`, label, colors[index]!));
    snapshot.nodes.forEach((node) => {
      const age = now - Date.parse(node.metadata.occurredAt);
      const group =
        buckets[
          age < 0
            ? 4
            : age <= DAY
              ? 0
              : age <= 7 * DAY
                ? 1
                : age <= 30 * DAY
                  ? 2
                  : 3
        ]!;
      group.count += 1;
      nodes.set(node.id, group);
    });
    if (buckets[4]!.count === 0) groups.pop();
  } else {
    const colors = dark
      ? ["#aaa6b5", "#73b6aa", "#77d0bd", "#acf0d6"]
      : ["#807d89", "#45867c", "#237868", "#075d4a"];
    const buckets = ["0 条", "1–2 条", "3–5 条", "6 条及以上"].map(
      (label, index) => add(`degree:${index}`, label, colors[index]!),
    );
    const counts = new Map<string, number>();
    snapshot.edges.forEach((edge) => {
      counts.set(edge.sourceId, (counts.get(edge.sourceId) ?? 0) + 1);
      if (edge.targetId !== edge.sourceId)
        counts.set(edge.targetId, (counts.get(edge.targetId) ?? 0) + 1);
    });
    snapshot.nodes.forEach((node) => {
      const degree = counts.get(node.id) ?? 0;
      const group =
        buckets[degree === 0 ? 0 : degree <= 2 ? 1 : degree <= 5 ? 2 : 3]!;
      group.count += 1;
      nodes.set(node.id, group);
    });
  }
  return { groups, nodes };
}
