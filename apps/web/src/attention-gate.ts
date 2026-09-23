/** 只解释已记录的非语义观察事实，不读取正文或重算策略。 */
import type { JsonValue } from "@kaguya/schema";

export interface GateField {
  readonly path?: string | undefined;
  readonly label: string;
  readonly value: JsonValue;
}

export interface GateDecision {
  readonly outcome: string;
  readonly title: string;
  readonly label: string;
  readonly tone: "success" | "warning" | "neutral";
  readonly branch:
    "direct" | "focus" | "recheck" | "awake" | "asleep" | "unknown";
  readonly branchLabel: string;
  readonly summary: string;
  readonly reasons: readonly string[];
}

export interface GateContextStatus {
  readonly tone: "success" | "warning" | "neutral";
  readonly label: string;
  readonly details: readonly string[];
}

const reasonLabels: Readonly<Record<string, string>> = {
  private: "私聊通知",
  web: "Web 会话",
  "mention-self": "@ 自己",
  "mention-all": "@ 全体",
  "reply-self": "回复机器人",
  "focus-active": "Focus 有效",
  "periodic-recheck": "周期复查到期",
  "arousal-awake": "Arousal 正处于唤醒态",
  "arousal-asleep": "Arousal 正处于休眠态",
};

export function gateValue(
  fields: readonly GateField[],
  path: string,
): JsonValue | undefined {
  return fields.find((field) => field.path === path)?.value;
}

export function gateNumber(
  fields: readonly GateField[],
  path: string,
): number | undefined {
  const value = gateValue(fields, path);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function gateText(
  fields: readonly GateField[],
  path: string,
): string | undefined {
  const value = gateValue(fields, path);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordedStrings(fields: readonly GateField[], path: string) {
  const value = gateValue(fields, path);
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((item) =>
    typeof item === "string" ? item : JSON.stringify(item),
  );
}

export function gateDecision(fields: readonly GateField[]): GateDecision {
  const recordedOutcome = gateText(fields, "outcome");
  const outcome = recordedOutcome ?? "unknown";
  const rawReasons = recordedStrings(fields, "reasonCodes");
  const reasons = rawReasons.map(
    (reason) =>
      `${reasonLabels[reason] ?? reason}${reasonLabels[reason] ? `（${reason}）` : ""}`,
  );
  const branch = rawReasons.some((reason) =>
    ["private", "web", "mention-self", "mention-all", "reply-self"].includes(
      reason,
    ),
  )
    ? "direct"
    : rawReasons.includes("focus-active")
      ? "focus"
      : rawReasons.includes("periodic-recheck")
        ? "recheck"
        : rawReasons.includes("arousal-awake")
          ? "awake"
          : rawReasons.includes("arousal-asleep")
            ? "asleep"
            : "unknown";
  const branchLabel = {
    direct: "直接通知",
    focus: "Focus",
    recheck: "周期复查",
    awake: "唤醒态",
    asleep: "休眠态",
    unknown: "触发未确认",
  }[branch];
  const label =
    outcome === "observe"
      ? "查看未读"
      : outcome === "defer"
        ? "延后观察"
        : (recordedOutcome ?? "结果未记录");
  const title =
    outcome === "observe" && branch === "awake"
      ? "唤醒态默认查看"
      : outcome === "observe" && branch === "unknown"
        ? "已查看，触发原因未确认"
        : outcome === "observe"
          ? `${branchLabel}触发查看`
          : outcome === "defer"
            ? "休眠态暂不查看，等待唤醒"
            : "观察结果无法确认";
  const summary =
    outcome === "observe"
      ? "本次允许 Heartflow 按记录的水位读取全部未读；是否参与仍由 Planner 决定。"
      : outcome === "defer"
        ? "本次没有读取或冻结正文，未读水位保持不变。"
        : "记录缺少新协议所需的观察结果，不能推断当时行为。";
  return {
    outcome,
    title,
    label,
    tone:
      outcome === "observe"
        ? "success"
        : outcome === "defer"
          ? "warning"
          : "neutral",
    branch,
    branchLabel,
    summary,
    reasons,
  };
}

export function gateContextStatus(
  fields: readonly GateField[],
): GateContextStatus {
  const state = gateText(fields, "focusState");
  const expiresAt = gateText(fields, "focusExpiresAt");
  return {
    tone: state === "active" ? "success" : state ? "neutral" : "warning",
    label:
      state === "active"
        ? "Focus 有效"
        : state === "inactive"
          ? "Focus 未生效"
          : "Focus 状态缺失",
    details: [`状态：${state ?? "未记录"}`, `到期：${expiresAt ?? "未记录"}`],
  };
}
