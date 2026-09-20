/**
 * 功能概述：验证门控历史的纯展示语义，防止 UI 用分数覆盖真实的硬门禁或直接唤醒结果。
 * 主要职责：覆盖三种结果、全部判定分支、直接唤醒的并存线索、冲突或未知原因，以及缺失值；
 * 验证冻结上下文红绿灯只有四项明确通过才显示绿灯，且不会把 focusActive 当作硬门禁。
 * 代码库关系：只调用 attention-gate.ts 导出的字段读取器与决策解释器，不加载 Runtime、
 * 现行配置、调度器或数据库，也不重复实现门控算法。
 * 输入输出与副作用：使用历史字段 fixture 断言结果和解释边界；全部为同步纯函数测试，
 * 无网络、定时器或持久化副作用，不把已记录的 dueAt 当作仍在运行的等待任务。
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@kaguya/schema";
import {
  gateContextStatus,
  gateDecision,
  gateNumber,
  gateText,
  gateValue,
  type GateField,
} from "./attention-gate.js";

function fields(values: Record<string, JsonValue>): GateField[] {
  return Object.entries(values).map(([path, value]) => ({
    path,
    label: path,
    value,
  }));
}

describe("gateDecision", () => {
  it("keeps every hard gate decisive even when the recorded score is high", () => {
    const decision = gateDecision(
      fields({
        outcome: "ignore",
        reasonCodes: ["muted", "unsafe", "no-destination", "frequency-zero"],
        score: 100,
        threshold: 80,
      }),
    );
    expect(decision).toMatchObject({
      outcome: "ignore",
      label: "本次忽略",
      tone: "neutral",
      title: "命中多项硬门禁，本次输入被忽略",
      branch: "hard-gate",
      scoreDecisive: false,
    });
    expect(decision.reasons).toHaveLength(4);
    expect(decision.reasons.join(" ")).toContain("no-destination");
    expect(decision.summary).toContain("分数不参与放行判定");
    expect(
      gateDecision(fields({ outcome: "ignore", reasonCodes: ["muted"] })).title,
    ).toBe("已静音，本次输入被忽略");
  });

  it.each([
    ["private-conversation", "direct-conversation"],
    ["mentioned-self", "direct-trigger"],
    ["replied-to-self", "direct-trigger"],
    ["named-self", "direct-trigger"],
  ])("explains %s as direct passage even at a low score", (reason, branch) => {
    const decision = gateDecision(
      fields({
        outcome: "attend",
        reasonCodes: [reason],
        score: 0,
        threshold: 80,
      }),
    );
    expect(decision).toMatchObject({
      label: "放行至规划",
      tone: "success",
      branch,
      scoreDecisive: false,
    });
    expect(decision.summary).toContain("是否回复仍由后续规划与执行决定");
    expect(decision.title).toBe(
      branch === "direct-conversation"
        ? "直接会话，放行至规划"
        : "触发直接唤醒，放行至规划",
    );
  });

  it("preserves all direct cues without claiming every associated setting was enabled", () => {
    const decision = gateDecision(
      fields({
        outcome: "attend",
        reasonCodes: ["mentioned-self", "replied-to-self", "named-self"],
      }),
    );
    expect(decision.branch).toBe("direct-trigger");
    expect(decision.reasons).toEqual([
      "消息提及自己（mentioned-self）",
      "消息回复自己（replied-to-self）",
      "消息包含自己的称呼（named-self）",
    ]);
    expect(decision.summary).toContain("不代表对应配置均已开启");
  });

  it.each([
    [
      "attend",
      "score-threshold-met",
      "score",
      "放行至规划",
      "评分达到当时阈值",
    ],
    [
      "defer",
      "score-below-threshold",
      "score",
      "延后观察",
      "评分未达阈值，继续观察",
    ],
    ["ignore", "wait-budget-exhausted", "budget", "本次忽略", "等待次数已用尽"],
  ])(
    "explains recorded %s decisions from %s",
    (outcome, reason, branch, label, title) => {
      const decision = gateDecision(
        fields({
          outcome,
          reasonCodes: [reason],
          attempt: branch === "budget" ? 3 : 2,
          totalWaitBudget: 3,
        }),
      );
      expect(decision).toMatchObject({
        outcome,
        branch,
        label,
        title,
        scoreDecisive: true,
      });
      if (branch === "budget") {
        expect(decision.summary).toContain("等待次数预算已用尽");
      }
    },
  );

  it.each([
    ["ignore", ["future-policy-rule"]],
    ["ignore", ["muted", "future-policy-rule"]],
    ["attend", ["private-conversation", "mentioned-self"]],
    ["ignore", ["muted", "wait-budget-exhausted"]],
    ["attend", ["score-threshold-met", "score-below-threshold"]],
    ["attend", ["muted"]],
    ["ignore", ["score-threshold-met"]],
    ["defer", ["score-below-threshold", null]],
    ["ignore", ["constructor"]],
  ])(
    "does not invent a branch for inconsistent %s reasons %j",
    (outcome, reasons) => {
      const decision = gateDecision(
        fields({ outcome, reasonCodes: reasons, score: 100, threshold: 80 }),
      );
      expect(decision).toMatchObject({
        outcome,
        branch: "unknown",
        scoreDecisive: false,
      });
      for (const reason of reasons) {
        expect(decision.reasons.join(" ")).toContain(String(reason));
      }
    },
  );

  it.each([undefined, [], "score-threshold-met", {}])(
    "requires a nonempty array of historical reasons, received %j",
    (reasonCodes) => {
      const decision = gateDecision(
        fields({
          outcome: "attend",
          score: 100,
          threshold: 80,
          ...(reasonCodes === undefined ? {} : { reasonCodes }),
        }),
      );
      expect(decision.branch).toBe("unknown");
      expect(decision.label).toBe("放行至规划");
    },
  );

  it("preserves an unknown outcome and its original reason without coercion", () => {
    expect(
      gateDecision(
        fields({ outcome: "future-outcome", reasonCodes: ["future-rule"] }),
      ),
    ).toMatchObject({
      outcome: "future-outcome",
      label: "future-outcome",
      branch: "unknown",
      title: "无法确认本次判断依据",
      reasons: ["future-rule"],
    });
    expect(gateDecision([])).toMatchObject({
      label: "结果未记录",
      branch: "unknown",
      reasons: [],
    });
    expect(gateDecision(fields({ outcome: "unknown" })).label).toBe("unknown");
  });

  it("does not treat a historical due time as evidence of an active wait", () => {
    const record = { outcome: "defer", reasonCodes: ["score-below-threshold"] };
    expect(
      gateDecision(fields({ ...record, dueAt: "2020-01-01T00:00:00.000Z" })),
    ).toEqual(gateDecision(fields(record)));
  });
});

describe("gateContextStatus", () => {
  const passing = {
    muted: false,
    safe: true,
    destinationAvailable: true,
    frequency: 0.5,
  };

  it("shows passed only when all four frozen hard-gate checks explicitly pass", () => {
    expect(gateContextStatus(fields(passing))).toEqual({
      tone: "success",
      label: "门禁通过",
      details: ["未静音", "安全检查通过", "目标可用", "有效频率：0.5"],
    });
  });

  it.each([
    ["muted", true, "已静音"],
    ["safe", false, "安全检查未通过"],
    ["destinationAvailable", false, "目标不可用"],
    ["frequency", 0, "频率为零"],
  ])(
    "shows blocked when %s has a recorded blocking condition",
    (path, value, detail) => {
      const status = gateContextStatus(fields({ ...passing, [path]: value }));
      expect(status).toMatchObject({ tone: "danger", label: "门禁拦截" });
      expect(status.details).toContain(detail);
    },
  );

  it("retains a definite block even when other conditions are missing", () => {
    expect(gateContextStatus(fields({ muted: true }))).toEqual({
      tone: "danger",
      label: "门禁拦截",
      details: ["已静音", "安全检查未记录", "目标状态未记录", "频率未记录"],
    });
  });

  it.each(["muted", "safe", "destinationAvailable", "frequency"])(
    "does not assume a missing %s passes",
    (path) => {
      const input = fields(passing).filter((field) => field.path !== path);
      const status = gateContextStatus(input);
      expect(status).toMatchObject({ tone: "warning", label: "信息不全" });
      expect(
        status.details.filter((detail) => detail.includes("未记录")),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["muted", "false"],
    ["safe", 1],
    ["destinationAvailable", {}],
    ["frequency", "0.5"],
    ["frequency", -0.1],
    ["frequency", 1.1],
    ["frequency", Infinity],
  ])(
    "does not coerce an invalid %s value %j into a passing check",
    (path, value) => {
      const status = gateContextStatus(fields({ ...passing, [path]: value }));
      expect(status).toMatchObject({ tone: "warning", label: "信息不全" });
      expect(status.details.some((detail) => detail.includes("无效"))).toBe(
        true,
      );
    },
  );

  it("keeps empty and null snapshots incomplete rather than green", () => {
    const expected = {
      tone: "warning",
      label: "信息不全",
      details: [
        "静音状态未记录",
        "安全检查未记录",
        "目标状态未记录",
        "频率未记录",
      ],
    };
    expect(gateContextStatus([])).toEqual(expected);
    expect(
      gateContextStatus(
        fields({
          muted: null,
          safe: null,
          destinationAvailable: null,
          frequency: null,
        }),
      ),
    ).toEqual(expected);
  });

  it.each([true, false, null, "unknown"])(
    "does not use focusActive=%j to change the frozen hard-gate checks",
    (focusActive) => {
      expect(gateContextStatus(fields({ ...passing, focusActive }))).toEqual(
        gateContextStatus(fields(passing)),
      );
      expect(gateContextStatus(fields({ focusActive })).tone).toBe("warning");
    },
  );
});

describe("gate field readers", () => {
  it("uses stable paths instead of translated display labels", () => {
    const input = [
      { label: "score", value: 99 },
      { path: undefined, label: "旧版字段", value: 88 },
      { path: "score", label: "当时分数", value: 12 },
    ] satisfies GateField[];
    expect(gateValue(input, "score")).toBe(12);
    expect(gateValue(input, "threshold")).toBeUndefined();
  });

  it("keeps missing and invalid numbers absent while preserving an actual zero", () => {
    const input = fields({
      score: 0,
      threshold: null,
      attempt: "2",
      totalWaitBudget: Infinity,
    });
    expect(gateNumber(input, "score")).toBe(0);
    expect(gateNumber(input, "threshold")).toBeUndefined();
    expect(gateNumber(input, "attempt")).toBeUndefined();
    expect(gateNumber(input, "totalWaitBudget")).toBeUndefined();
    expect(gateNumber(input, "missing")).toBeUndefined();
  });

  it("keeps non-text and empty values absent without changing historical text", () => {
    const input = fields({ outcome: "attend", empty: " ", score: 80 });
    expect(gateText(input, "outcome")).toBe("attend");
    expect(gateText(input, "empty")).toBeUndefined();
    expect(gateText(input, "score")).toBeUndefined();
    expect(gateText(input, "missing")).toBeUndefined();
  });
});
