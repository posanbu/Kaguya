/**
 * 功能概述：表情插件的纯策略，隔离会话、Unicode 字素和保守发送限额。
 * scopeKey 固定平台/适配器/目标边界；stripEmoji 按完整字素清理，不拆散肤色、国旗或 ZWJ。
 * rateAllowed 同时要求时间与普通回复间隔；prepared 结果即占用额度，失败投递也不归还，避免故障时连发。
 * 无 I/O；图片/QQ face 与 Unicode emoji 共用一个额度，每条消息至多一个表情。
 */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const emojiPattern =
  /\p{Emoji_Presentation}|\u20e3|(?:\p{Extended_Pictographic}\uFE0F)/u;
export function emojiParts(text: string): string[] {
  return [...segmenter.segment(text)]
    .map((part) => part.segment)
    .filter((s) => emojiPattern.test(s));
}
export function stripEmoji(text: string): string {
  return [...segmenter.segment(text)]
    .filter((s) => !emojiPattern.test(s.segment))
    .map((s) => s.segment)
    .join("")
    .trim();
}
export function scopeKey(source: {
  platform: string;
  adapterId: string;
  destination: unknown;
}): string {
  return JSON.stringify([
    source.platform,
    source.adapterId,
    source.destination,
  ]);
}
export function rateAllowed(
  history: readonly DeepReadonly<InformationAtom>[],
  now: number,
  settings: { cooldownSeconds: number; minMessagesBetween: number },
): boolean {
  const index = history.findIndex(
    (a) =>
      a.payload.expression || emojiParts(String(a.payload.text ?? "")).length,
  );
  if (index < 0)
    return (
      history.length >= settings.minMessagesBetween &&
      // 历史截断不能把窗口外的一次表情误当作从未使用，保守等待可见窗口跨过冷却期。
      (history.length < 101 ||
        now - Date.parse(history.at(-1)!.occurredAt) >=
          settings.cooldownSeconds * 1000)
    );
  return (
    index >= settings.minMessagesBetween &&
    now - Date.parse(history[index]!.occurredAt) >=
      settings.cooldownSeconds * 1000
  );
}
