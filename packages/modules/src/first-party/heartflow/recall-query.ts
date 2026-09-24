/**
 * 功能概述：为观察后的 Planner 记忆检索构造有界查询，避免长批次首条正文占满检索预算。
 * 主要职责：buildRecallQuery 从最近八条不同的非空输入分配字符配额，长消息同时保留首尾；
 * mergeRecallLanes 轮流取各召回路径的原文并按 ID 去重，使角色设定、话题和人物背景共享预算。
 * 代码库关系：Heartflow sparse 与 Knowledge selector 共用；这里只选择检索输入和证据，
 * 不判断消息是否值得回复，不修改原始输入、持久化事实或 Planner 的完整会话。
 * 输入输出与副作用：纯函数，查询最多 512 个 Unicode 字符；空输入返回空串，合并顺序确定。
 */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";

export function buildRecallQuery(texts: readonly string[]): string {
  const selected = [...new Set(texts.map((text) => text.trim()).reverse())]
    .filter(Boolean)
    .slice(0, 8);
  if (selected.length === 0) return "";
  const quota = Math.floor((512 - selected.length + 1) / selected.length);
  return selected
    .map((text) => {
      const points = Array.from(text);
      if (points.length <= quota) return text;
      const head = Math.ceil((quota - 1) / 2);
      return `${points.slice(0, head).join("")}…${points.slice(-(quota - head - 1)).join("")}`;
    })
    .join("\n");
}

export function mergeRecallLanes(
  lanes: readonly (readonly DeepReadonly<InformationAtom>[])[],
  limit: number,
): readonly DeepReadonly<InformationAtom>[] {
  const selected = new Map<string, DeepReadonly<InformationAtom>>();
  const width = Math.max(0, ...lanes.map((lane) => lane.length));
  for (let index = 0; index < width && selected.size < limit; index++) {
    for (const lane of lanes) {
      const atom = lane[index];
      if (atom) selected.set(atom.informationId, atom);
      if (selected.size >= limit) break;
    }
  }
  return [...selected.values()];
}
