import type { FeatureStatus } from "./feature-api.js";
type Presentation = {
  label: string;
  tone: "neutral" | "success" | "warning" | "error";
};
export function featurePresentation(
  feature: FeatureStatus | undefined,
  busy = false,
  failed = false,
): Presentation {
  if (failed) return { label: "状态未知", tone: "error" };
  if (!feature) return { label: "读取中", tone: "neutral" };
  if (busy) return { label: "切换中", tone: "warning" };
  if (feature.blocker === "recovery_failed")
    return { label: "恢复失败", tone: "error" };
  const states: Record<string, Presentation> = {
    starting: { label: "启动中", tone: "warning" },
    stopping: { label: "停止中", tone: "warning" },
    failed: { label: "运行失败", tone: "error" },
    retrying: { label: "已开启，重连中", tone: "warning" },
  };
  if (states[feature.lifecycle]) return states[feature.lifecycle]!;
  if (
    feature.blocker === "restart_required" ||
    feature.lifecycle === "pending_restart"
  )
    return { label: "待重启生效", tone: "warning" };
  if (feature.active) return { label: "运行中", tone: "success" };
  if (
    !feature.enabled &&
    (feature.lifecycle === "disabled" || feature.lifecycle === "stopped")
  )
    return { label: "已关闭", tone: "neutral" };
  return { label: "状态未知", tone: "neutral" };
}
