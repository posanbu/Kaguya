/**
 * 功能概述：请求检查页的稳定深链接，统一模块、请求 ID 编码与概览/Prompt/来源三个互斥子页面。
 * 主要职责：requestDetailPath 构造原生链接；requestRoute 严格解析已知路径，拒绝多余段和损坏的编码。
 * 代码库关系：DeveloperConsole、ModulePages 与 RequestSurface 共用，避免模块分派依赖 definitionId。
 * 输入输出与副作用：纯路径转换，不访问 history、Token 或模型数据；请求 ID 中的斜线作为编码数据保留。
 */
export type RequestView = "overview" | "prompt" | "sources";
export function requestDetailPath(
  definitionId: string,
  requestId: string,
  view: RequestView = "overview",
  sourceInformationId?: string,
) {
  return `/developer/modules/${encodeURIComponent(definitionId)}/requests/${encodeURIComponent(requestId)}${view === "overview" ? "" : `/${view}`}${view === "sources" && sourceInformationId ? `/${encodeURIComponent(sourceInformationId)}` : ""}`;
}
export function requestRoute(path: string) {
  const match =
    /^\/developer\/modules\/([^/]+)\/requests\/([^/]+)(?:\/(prompt|sources)(?:\/([^/]+))?)?\/?$/.exec(
      path,
    );
  if (!match || (match[4] && match[3] !== "sources")) return undefined;
  try {
    return {
      definitionId: decodeURIComponent(match[1]!),
      requestId: decodeURIComponent(match[2]!),
      view: (match[3] ?? "overview") as RequestView,
      ...(match[4]
        ? { sourceInformationId: decodeURIComponent(match[4]) }
        : {}),
    };
  } catch {
    return undefined;
  }
}
