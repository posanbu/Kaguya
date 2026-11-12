/**
 * 功能概述：桌面管理的浏览器 wire 边界，响应逐项校验；与 Inspection 的 {data} 包装分开。
 * environmentRequest 发送 Gateway Bearer 和 no-store，401 同步通知壳层并抛出结构化安全错误。
 * readEnvironmentImage 只读取认证 PNG Blob，不把凭证放 URL；公开控制/任务/操作 schema 不包含 broker 密钥。
 * EnvironmentControl 使用本文件；POST 仅来自显式操作，网络失败不会自动重放。
 */
import { z } from "@kaguya/schema";
import { GatewayRequestError, GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
export const environmentControlSchema = z.object({
  environmentId: z.string(),
  scope: z.string(),
  generation: z.number().int().nonnegative(),
  state: z.enum([
    "preparing",
    "ready",
    "human",
    "draining",
    "quarantined",
    "isolation_failed",
  ]),
  human: z.object({ sessionId: z.string(), expiresAt: z.string() }).optional(),
  pendingControl: z
    .object({ mode: z.enum(["human", "automation"]), generation: z.number() })
    .optional(),
});
export const environmentListSchema = z.object({
  environments: z.array(environmentControlSchema),
});
export const guiTaskSchema = z.object({
  taskRequestId: z.string().uuid(),
  environmentId: z.string(),
  requestedInformationId: z.string(),
  runInformationId: z.string().nullable(),
  status: z.enum(["queued", "running", "completed", "failed", "stopped"]),
  terminal: z
    .object({
      status: z.string(),
      reason: z.string(),
      runInformationId: z.string().nullable(),
      output: z.unknown(),
    })
    .nullable(),
  cancellation: z
    .object({
      state: z.enum(["pending", "forwarded"]),
      requestedInformationId: z.string(),
    })
    .nullable(),
});
export const humanReceiptSchema = z.object({
  operationId: z.string(),
  attemptId: z.string(),
  outcome: z.object({
    status: z.enum([
      "succeeded",
      "rejected",
      "cancelled",
      "partial",
      "unknown",
    ]),
    evidence: z.string(),
    result: z.unknown(),
    artifacts: z.array(
      z.object({
        id: z.string(),
        hash: z.string(),
        mime: z.string(),
        size: z.number(),
      }),
    ),
    truncated: z.boolean(),
  }),
});
export const desktopCaptureSchema = z.object({
  observation: z.object({
    id: z.string(),
    environmentId: z.string(),
    workflowId: z.string(),
    generation: z.number(),
  }),
  expiresAt: z.string(),
  image: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    sha256: z.string(),
  }),
});
export type Control = z.infer<typeof environmentControlSchema>;
export type HumanReceipt = z.infer<typeof humanReceiptSchema>;
export type GuiTask = z.infer<typeof guiTaskSchema>;
export function environmentPath(id: string, suffix: string) {
  return `/api/v1/environments/${encodeURIComponent(id)}/${suffix}`;
}
async function authenticated(
  token: string,
  path: string,
  signal: AbortSignal,
  body?: unknown,
) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
  if (response.status === 401) {
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
    throw new GatewayRequestError(
      "管理访问已失效，请重新打开访问链接。",
      "unauthorized",
      401,
    );
  }
  return response;
}
export async function environmentRequest<T>(
  token: string,
  path: string,
  schema: { parse(value: unknown): T },
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await authenticated(token, path, signal, body);
  if (!response.ok) {
    const raw = await response.json().catch(() => null);
    const code =
      typeof raw?.error === "string" ? raw.error : "environment-request-failed";
    throw new GatewayRequestError(
      response.status === 404
        ? "尚未找到此任务或操作；请保留原 ID 查询。"
        : "请求结果未确认。请刷新状态或查询原 ID，勿重复输入。",
      code,
      response.status,
    );
  }
  try {
    return schema.parse(await response.json());
  } catch {
    throw new GatewayRequestError(
      "管理响应格式无效，结果未确认。",
      "environment-response-invalid",
      response.status,
    );
  }
}
export async function readEnvironmentImage(
  token: string,
  environmentId: string,
  artifactId: string,
  signal: AbortSignal,
) {
  const response = await authenticated(
    token,
    environmentPath(environmentId, `images/${encodeURIComponent(artifactId)}`),
    signal,
  );
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("image/png")
  )
    throw new Error("截图不可读取，请重新观察。");
  return response.blob();
}
