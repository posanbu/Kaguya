import { expect, it } from "vitest";
import { featurePresentation } from "./feature-status.js";
const feature = {
  id: "adapter.napcat" as const,
  enabled: true,
  active: false,
  lifecycle: "starting",
  blocker: "restart_required",
};
it.each([
  ["starting", "启动中", "warning"],
  ["stopping", "停止中", "warning"],
  ["failed", "运行失败", "error"],
  ["retrying", "已开启，重连中", "warning"],
  ["pending_restart", "待重启生效", "warning"],
])(
  "shows %s instead of inferring restart from enabled/active mismatch",
  (lifecycle, label, tone) => {
    expect(featurePresentation({ ...feature, lifecycle })).toEqual({
      label,
      tone,
    });
  },
);
it("prioritizes recovery failure even when the old instance remains active", () => {
  expect(
    featurePresentation({
      ...feature,
      active: true,
      lifecycle: "running",
      blocker: "recovery_failed",
    }),
  ).toEqual({ label: "恢复失败", tone: "error" });
});
it("distinguishes unavailable reads from initial loading", () => {
  expect(featurePresentation(undefined)).toEqual({
    label: "读取中",
    tone: "neutral",
  });
  expect(featurePresentation(undefined, false, true)).toEqual({
    label: "状态未知",
    tone: "error",
  });
  expect(
    featurePresentation(
      { ...feature, active: true, lifecycle: "running" },
      false,
      true,
    ).label,
  ).toBe("状态未知");
});
it("preserves normal and locally pending states", () => {
  expect(
    featurePresentation({
      ...feature,
      active: true,
      lifecycle: "running",
      blocker: "",
    }).label,
  ).toBe("运行中");
  expect(
    featurePresentation({
      ...feature,
      enabled: false,
      lifecycle: "disabled",
      blocker: "",
    }).label,
  ).toBe("已关闭");
  expect(featurePresentation(feature, true).label).toBe("切换中");
});
