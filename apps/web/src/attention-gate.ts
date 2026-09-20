/**
 * 功能概述：把门控历史字段解释为可读的结果与判定分支，供开发者控制台展示历史证据。
 * 主要职责：gateValue 按服务端声明的 path 读取字段；gateNumber 与 gateText 保留缺失值，
 * 仅返回有效数字或非空字符串；gateDecision 依据已记录的 outcome 和 reasonCodes 归类，返回短标题与详细解释。
 * gateContextStatus 仅汇总冻结上下文的静音、安全、目标和频率检查；明确拦截优先，四项完整通过才显示通过。
 * 代码库关系：接收 Inspection API 的已脱敏 JsonValue 字段，供 DeveloperConsole 使用；
 * 原因码对应 attention-arousal 的实际分支，schema 仅作为类型依赖，不调用 Runtime。
 * 输入输出与副作用：纯函数不修改输入、不重算分数或读取当前策略；缺失、未知或互相冲突
 * 的原因降级为未确认分支并保留原码。放行仅表示进入规划，不表示回复已经发送；等待预算
 * 按次数解释，历史 dueAt 不用于推断仍在运行的任务或生成倒计时。
 * 上下文状态不替代已记录的门控结果，focusActive 不属于硬门禁；未知、缺失或无效条件不能视为通过。
 */
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
    | "hard-gate"
    | "direct-conversation"
    | "direct-trigger"
    | "score"
    | "budget"
    | "unknown";
  readonly branchLabel: string;
  readonly summary: string;
  readonly scoreDecisive: boolean;
  readonly reasons: readonly string[];
}

export interface GateContextStatus {
  readonly tone: "success" | "danger" | "warning" | "neutral";
  readonly label: string;
  readonly details: readonly string[];
}

type RecordedReason = {
  readonly label: string;
  readonly branch: Exclude<GateDecision["branch"], "unknown">;
  readonly outcome: "attend" | "defer" | "ignore";
};

const recordedReasons: Readonly<Record<string, RecordedReason>> = {
  muted: { label: "已静音", branch: "hard-gate", outcome: "ignore" },
  unsafe: { label: "安全检查未通过", branch: "hard-gate", outcome: "ignore" },
  "no-destination": {
    label: "发送目标不可用",
    branch: "hard-gate",
    outcome: "ignore",
  },
  "frequency-zero": {
    label: "发言频率为零",
    branch: "hard-gate",
    outcome: "ignore",
  },
  "private-conversation": {
    label: "直接会话输入",
    branch: "direct-conversation",
    outcome: "attend",
  },
  "mentioned-self": {
    label: "消息提及自己",
    branch: "direct-trigger",
    outcome: "attend",
  },
  "replied-to-self": {
    label: "消息回复自己",
    branch: "direct-trigger",
    outcome: "attend",
  },
  "named-self": {
    label: "消息包含自己的称呼",
    branch: "direct-trigger",
    outcome: "attend",
  },
  "score-threshold-met": {
    label: "分数达到当时阈值",
    branch: "score",
    outcome: "attend",
  },
  "score-below-threshold": {
    label: "分数未达到当时阈值",
    branch: "score",
    outcome: "defer",
  },
  "wait-budget-exhausted": {
    label: "等待次数预算已用尽",
    branch: "budget",
    outcome: "ignore",
  },
};

const branchLabels: Record<GateDecision["branch"], string> = {
  "hard-gate": "硬门禁",
  "direct-conversation": "直接会话",
  "direct-trigger": "直接唤醒",
  score: "分数判断",
  budget: "等待预算耗尽",
  unknown: "判定依据未确认",
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

export function gateContextStatus(
  fields: readonly GateField[],
): GateContextStatus {
  const checks = [
    {
      path: "muted",
      label: "静音状态",
      passValue: false,
      passLabel: "未静音",
      blockLabel: "已静音",
    },
    {
      path: "safe",
      label: "安全检查",
      passValue: true,
      passLabel: "安全检查通过",
      blockLabel: "安全检查未通过",
    },
    {
      path: "destinationAvailable",
      label: "目标状态",
      passValue: true,
      passLabel: "目标可用",
      blockLabel: "目标不可用",
    },
  ].map((check) => {
    const value = gateValue(fields, check.path);
    const valid = typeof value === "boolean";
    const passed = valid && value === check.passValue;
    return {
      passed,
      blocked: valid && !passed,
      detail: valid
        ? passed
          ? check.passLabel
          : check.blockLabel
        : `${check.label}${value === undefined || value === null ? "未记录" : "无效"}`,
    };
  });
  const frequency = gateValue(fields, "frequency");
  const validFrequency =
    typeof frequency === "number" &&
    Number.isFinite(frequency) &&
    frequency >= 0 &&
    frequency <= 1;
  checks.push({
    passed: validFrequency && frequency > 0,
    blocked: validFrequency && frequency === 0,
    detail: validFrequency
      ? frequency === 0
        ? "频率为零"
        : `有效频率：${frequency}`
      : `频率${frequency === undefined || frequency === null ? "未记录" : "无效"}`,
  });
  const blocked = checks.some((check) => check.blocked);
  const passed = checks.every((check) => check.passed);
  return {
    tone: blocked ? "danger" : passed ? "success" : "warning",
    label: blocked ? "门禁拦截" : passed ? "门禁通过" : "信息不全",
    details: checks.map((check) => check.detail),
  };
}

export function gateDecision(fields: readonly GateField[]): GateDecision {
  const recordedOutcome = gateText(fields, "outcome");
  const outcome = recordedOutcome ?? "unknown";
  const rawReasons = gateValue(fields, "reasonCodes");
  const reasonValues = Array.isArray(rawReasons)
    ? rawReasons
    : rawReasons === undefined || rawReasons === null
      ? []
      : [rawReasons];
  const reasons = reasonValues.map((value) => {
    if (typeof value !== "string") return JSON.stringify(value);
    const known = Object.hasOwn(recordedReasons, value)
      ? recordedReasons[value]
      : undefined;
    return known ? `${known.label}（${value}）` : value;
  });
  const definitions = reasonValues.map((value) =>
    typeof value === "string" && Object.hasOwn(recordedReasons, value)
      ? recordedReasons[value]
      : undefined,
  );
  const first = definitions[0];
  const consistent =
    Array.isArray(rawReasons) &&
    first !== undefined &&
    definitions.every(
      (reason) =>
        reason !== undefined &&
        reason.branch === first.branch &&
        reason.outcome === outcome,
    );
  const branch = consistent ? first.branch : "unknown";
  const label =
    outcome === "attend"
      ? "放行至规划"
      : outcome === "defer"
        ? "延后观察"
        : outcome === "ignore"
          ? "本次忽略"
          : recordedOutcome === undefined
            ? "结果未记录"
            : outcome;
  let title: string;
  let summary: string;
  switch (branch) {
    case "hard-gate":
      title =
        definitions.length === 1 && first
          ? `${first.label}，本次输入被忽略`
          : "命中多项硬门禁，本次输入被忽略";
      summary = "本次命中硬门禁并忽略，分数不参与放行判定。";
      break;
    case "direct-conversation":
      title = "直接会话，放行至规划";
      summary =
        "本次由直接会话分支放行至规划，分数不参与放行判定；是否回复仍由后续规划与执行决定。";
      break;
    case "direct-trigger":
      title = "触发直接唤醒，放行至规划";
      summary =
        "本次由直接唤醒分支放行至规划，分数不参与放行判定；记录中的线索不代表对应配置均已开启，是否回复仍由后续规划与执行决定。";
      break;
    case "score":
      title =
        outcome === "attend" ? "评分达到当时阈值" : "评分未达阈值，继续观察";
      summary =
        outcome === "attend"
          ? "当时分数达到阈值，放行至规划；是否回复仍由后续规划与执行决定。"
          : "当时分数未达到阈值且仍有等待次数预算，因此记录为延后观察。";
      break;
    case "budget":
      title = "等待次数已用尽";
      summary = "当时分数未达到阈值且等待次数预算已用尽，因此本次忽略。";
      break;
    default:
      title = "无法确认本次判断依据";
      summary =
        "历史原因缺失、未知或与结果不一致，无法确认实际判定分支；保留记录结果，不根据分数或当前配置推断。";
  }
  return {
    outcome,
    title,
    label,
    tone:
      outcome === "attend"
        ? "success"
        : outcome === "defer"
          ? "warning"
          : "neutral",
    branch,
    branchLabel: branchLabels[branch],
    summary,
    scoreDecisive: branch === "score" || branch === "budget",
    reasons,
  };
}
