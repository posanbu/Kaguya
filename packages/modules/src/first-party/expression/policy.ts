/**
 * 功能概述：表达学习来源过滤、输出核验与去重投影，纯函数不写账本或调用模型。
 * humanText 拒绝机器人、自身、媒体占位、系统内容与噪声；validateHabits 要求每个模型引用来自冻结真人批次。
 * projectHabits 按稳定 ID 合并已验证批次，以唯一真实来源计数，重复批次和重复模式不会累计。
 * 受限 situation/style 枚举确保表达只能描述语言表面形式，不保存任意原文或目标信息。
 */
import { type DeepReadonly, type InformationAtom } from "@kaguya/schema";
import { inboundTextInformationKind } from "../information-kinds.js";
import {
  expressionLearned,
  habitId,
  learningOutputSchema,
  type Habit,
} from "./facts.js";
export function humanText(atom: DeepReadonly<InformationAtom>): boolean {
  if (atom.kind !== inboundTextInformationKind.kind) return false;
  const parsed = inboundTextInformationKind.payloadSchema.safeParse(
    atom.payload,
  );
  if (!parsed.success) return false;
  const { text, source } = parsed.data;
  if (source.sender?.isSelf || source.senderId === source.selfId) return false;
  const clean = text.trim();
  return (
    clean.length >= 4 &&
    clean.length <= 1000 &&
    /[\p{L}]/u.test(clean) &&
    !/\[(?:image|file|voice|face|video|图片|文件|语音)[^\]]*\]|<\/?(?:system|assistant|tool|think)>|(?:system|assistant|tool)\s*:|系统提示|工具结果|模型推理/iu.test(
      clean,
    )
  );
}
export function validateHabits(
  output: unknown,
  scope: string,
  sources: readonly DeepReadonly<InformationAtom>[],
): Habit[] | undefined {
  const result = learningOutputSchema.safeParse(output);
  if (!result.success) return undefined;
  const ids = new Set(sources.filter(humanText).map((a) => a.informationId));
  if (
    result.data.patterns.some((p) =>
      p.sourceInformationIds.some((id) => !ids.has(id)),
    )
  )
    return undefined;
  const habits = new Map<string, Habit>();
  for (const pattern of result.data.patterns) {
    const id = habitId(scope, pattern.situation, pattern.style);
    const unique = [
      ...new Set([
        ...(habits.get(id)?.sourceInformationIds ?? []),
        ...pattern.sourceInformationIds,
      ]),
    ].sort();
    habits.set(id, {
      ...pattern,
      sourceInformationIds: unique,
      habitId: id,
      scopeInformationId: scope,
      occurrences: unique.length,
      reviewStatus: "validated",
      version: 1,
    });
  }
  return [...habits.values()];
}
export function projectHabits(
  atoms: readonly DeepReadonly<InformationAtom>[],
  scope: string,
): Habit[] {
  const result = new Map<string, Habit>();
  for (const atom of atoms) {
    if (atom.kind !== expressionLearned.kind) continue;
    const parsed = expressionLearned.payloadSchema.safeParse(atom.payload);
    if (
      !parsed.success ||
      parsed.data.status !== "completed" ||
      parsed.data.scopeInformationId !== scope
    )
      continue;
    for (const habit of parsed.data.habits) {
      if (
        habit.scopeInformationId !== scope ||
        habit.habitId !== habitId(scope, habit.situation, habit.style)
      )
        continue;
      const ids = [
        ...new Set([
          ...(result.get(habit.habitId)?.sourceInformationIds ?? []),
          ...habit.sourceInformationIds,
        ]),
      ].sort();
      result.set(habit.habitId, {
        ...habit,
        sourceInformationIds: ids,
        occurrences: ids.length,
      });
    }
  }
  return [...result.values()]
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences || a.habitId.localeCompare(b.habitId),
    )
    .slice(0, 24)
    .map((h) => ({
      ...h,
      sourceInformationIds: h.sourceInformationIds.slice(-24),
    }));
}
