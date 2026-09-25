import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";

export const FEATURE_CHANGED_EVENT = "kaguya:features-changed";
export const FEATURE_IDS = [
  "memory.writeback",
  "memory.knowledge",
  "memory.index",
  "memory.cognition",
  "adapter.napcat",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
export interface FeatureStatus {
  id: FeatureId;
  enabled: boolean;
  active: boolean;
  lifecycle: string;
  blocker?: string;
}
export interface FeatureView {
  revision: string;
  features: FeatureStatus[];
}
function isFeatureView(value: unknown): value is FeatureView {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.revision === "string" &&
    Array.isArray(record.features) &&
    record.features.every((item) => {
      if (!item || typeof item !== "object") return false;
      const feature = item as Record<string, unknown>;
      return (
        FEATURE_IDS.includes(feature.id as FeatureId) &&
        typeof feature.enabled === "boolean" &&
        typeof feature.active === "boolean" &&
        typeof feature.lifecycle === "string" &&
        (feature.blocker === undefined || typeof feature.blocker === "string")
      );
    })
  );
}
async function request(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<FeatureView> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = (payload as { error?: { code?: string } })?.error?.code;
    throw new Error(
      error === "feature_configuration_changed"
        ? "配置已变化，请刷新后重试。"
        : error === "memory_writeback_required"
          ? "请先开启原始记忆。"
          : error === "memory_configuration_invalid"
            ? "请先填写该记忆模块的提供方配置。"
            : "切换失败，请检查模块状态并重试。",
    );
  }
  const data = (payload as { data?: unknown }).data;
  if (!isFeatureView(data)) throw new Error("功能状态响应无效");
  return data;
}
export const getFeatures = (token: string) =>
  request(token, "/api/v1/features");
export const putFeature = (
  token: string,
  id: FeatureId,
  enabled: boolean,
  revision: string,
) =>
  request(token, `/api/v1/features/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, revision }),
  });
