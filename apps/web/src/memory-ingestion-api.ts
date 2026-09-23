/**
 * 功能概述：记忆录入页面的同源认证客户端和安全错误说明。
 * 主要职责：requestMemoryIngestion 校验共享响应契约；401 交给 App 锁屏；错误保留状态供幂等重试判断。
 * 代码库关系：MemoryIngestion.tsx 调用管理路由，不访问模板、Profile 或普通聊天发送接口。
 * 输入输出与副作用：Token 只在请求头中发送，支持 AbortSignal；不会自动重复 POST 或持久化 Token。
 */
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
export function ingestionErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    ingestion_unavailable:
      "记忆录入暂不可用。请在配置中启用 Memory 和事件 / Wiki 记忆，并应用配置。",
    session_busy: "这一轮仍在处理中，请等待结果后继续补充。",
    session_full: "本次录入上下文已满，请开始新录入。已有内容已保存在记录中。",
    incompatible_contract:
      "这条任务使用了不兼容的旧版本，无法重试。请新建录入并重新提交原文。",
    invalid_plan: "AI 返回的整理格式不符合要求，请重试。",
    unsupported_evidence:
      "AI 整理结果缺少对应原文，未写入记忆。请重试或补充明确说明。",
    revision_conflict: "需要修订的记忆已经变化，请补充说明后重新整理。",
    foreign_entity: "AI 选择了适用范围之外的人物，未写入记忆。请重试。",
    scope_too_large:
      "该范围的人物数量超过本次整理上限，请改用更具体的聊天范围。",
    processing_interrupted: "处理被服务重启或配置切换中断，可以重试。",
    model_retryable: "模型服务暂时不可用，可以重试。",
    model_non_retryable: "模型请求失败，请检查模型配置后重试。",
    model_cancelled: "模型处理超时或被取消，可以重试。",
    invalid_resolution: "所选身份与当前候选不一致，请重新选择人物。",
    invalid_scope: "该适用范围已不可用，请开始新录入并重新选择。",
  };
  return messages[code] ?? "本次处理未完成。原文已保留，请重试或补充说明。";
}
export class MemoryIngestionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(ingestionErrorMessage(code));
  }
}
export async function requestMemoryIngestion<T>(
  token: string,
  path: string,
  schema: { parse: (value: unknown) => T },
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  if (!token.trim()) throw new MemoryIngestionRequestError("unauthorized", 401);
  const response = await fetch(`/api/v1/memory-ingestion/${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const body = await response.json();
  if (!response.ok)
    throw new MemoryIngestionRequestError(
      String(body.error?.code ?? "request_failed"),
      response.status,
    );
  return schema.parse(body.data);
}
