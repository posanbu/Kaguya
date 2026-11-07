/**
 * 功能概述：现有工作台页内领域检视的 URL 合同，不新增顶层路由。
 * readInspectionLocation 校验已知领域并恢复范围、消费者、选择、冻结上下文和整段游标栈；
 * inspectionLocation 生成原生可分享链接，inspectionApiPath 只发送服务端接受的查询。
 * SituationPage、DeveloperConsole、MemoryGraph 与 InspectionReference 共用；Token/正文不进入 URL。
 * 过滤与领域变化由调用方清游标；Memory 历史必须携带原 observation，不能回退到当前节点。
 */
export const inspectionDomains = {
  observation: "观察",
  progress: "消费进度",
  run: "模型与工具",
  action: "行动回执",
  "gui-task": "桌面任务",
  memory: "冻结记忆",
  atom: "原始来源",
  environment: "桌面控制",
} as const;
export type InspectionDomain = keyof typeof inspectionDomains;
export interface InspectionLocation {
  domain: InspectionDomain;
  scope: string;
  consumer: string;
  selected: string;
  observation: string;
  step: string;
  cursors: string[];
}
export function inspectionPage(
  value: InspectionLocation,
  cursors: string[],
): InspectionLocation {
  return {
    ...value,
    cursors,
    selected: value.domain === "memory" ? value.selected : "",
  };
}
export function readInspectionLocation(
  location: string,
  defaultScope = "",
): InspectionLocation {
  const params = new URLSearchParams(location.split("?")[1] ?? "");
  const domain = params.get("inspect") ?? "observation";
  return {
    domain: Object.hasOwn(inspectionDomains, domain)
      ? (domain as InspectionDomain)
      : "observation",
    scope: params.get("scope") ?? defaultScope,
    consumer: params.get("consumer") ?? "",
    selected: params.get("selected") ?? "",
    observation: params.get("observation") ?? "",
    step: params.get("step") ?? "",
    cursors: params.getAll("cursor").slice(0, 100),
  };
}
export function inspectionLocation(
  base: string,
  value: InspectionLocation,
): string {
  const params = new URLSearchParams(base.split("?")[1] ?? "");
  for (const key of [
    "inspect",
    "scope",
    "consumer",
    "selected",
    "observation",
    "step",
    "cursor",
  ])
    params.delete(key);
  params.set("inspect", value.domain);
  for (const key of [
    "scope",
    "consumer",
    "selected",
    "observation",
    "step",
  ] as const)
    if (value[key]) params.set(key, value[key]);
  for (const cursor of value.cursors) params.append("cursor", cursor);
  return `${base.split("?")[0]}?${params}`;
}
export function inspectionApiPath(
  value: InspectionLocation,
  detail = false,
): string | undefined {
  if (!value.scope) return undefined;
  const params = new URLSearchParams({ scope: value.scope });
  const endpoint = {
    observation: "observations",
    progress: "progress",
    run: "runs",
    action: "actions",
    "gui-task": "gui-tasks",
    memory: "memory",
    atom: "sources",
    environment: "environments",
  }[value.domain];
  if (value.domain === "memory") {
    if (!value.selected || !value.observation) return undefined;
    params.set("observationId", value.observation);
    if (value.step) params.set("stepInformationId", value.step);
  } else if (
    detail ||
    value.domain === "atom" ||
    value.domain === "environment"
  ) {
    if (!value.selected || value.domain === "progress") return undefined;
    return `${endpoint}/${encodeURIComponent(value.selected)}?${params}`;
  }
  params.set("limit", "20");
  if (value.domain === "observation" || value.domain === "progress")
    if (value.consumer) params.set("consumerId", value.consumer);
  if (value.cursors.length) params.set("cursor", value.cursors.at(-1)!);
  return `${endpoint}${value.domain === "memory" ? `/${encodeURIComponent(value.selected)}/history` : ""}?${params}`;
}
