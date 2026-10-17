/**
 * 功能概述：封装 Memory 图检视及节点／边管理 HTTP 请求。
 * 主要职责：校验响应、保留输入错误语义、将 401 交给 App 全局锁屏，并支持取消过期读取。
 * 代码库关系：MemoryGraph 页面调用，协议来自 schema，服务端由 memory-graph-routes.ts 实现。
 * 输入输出与副作用：Token 仅通过 Authorization 发送；写操作持久化到 PostgreSQL。
 */
import {
  memoryGraphSnapshotSchema,
  memoryNodeSchema,
  memoryEdgeInputSchema,
  type MemoryGraphQuery,
  type MemoryNodeInput,
  type MemoryEdgeInput,
} from "@kaguya/schema";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";

const messages: Record<string, string> = {
  invalid_memory_input: "输入格式无效，请检查时间、正文和 metadata。",
  memory_unavailable: "记忆数据库尚未就绪，请检查服务状态后刷新。",
  memory_node_not_found: "这个记忆节点已被删除，请刷新视图。",
  memory_endpoint_missing: "关系两端的节点必须存在，请刷新后重新选择。",
};
async function request(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/v1/memory/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 401)
    window.dispatchEvent(new Event(GATEWAY_UNAUTHORIZED_EVENT));
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      messages[result.error?.code] ?? "记忆操作失败，请稍后重试。",
    );
  return result.data;
}
export async function readMemoryGraph(
  token: string,
  query: MemoryGraphQuery,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach((tag) => params.append(key, tag));
    else if (value !== undefined && value !== "")
      params.set(key, String(value));
  }
  return memoryGraphSnapshotSchema.parse(
    await request(token, `graph?${params}`, "GET", undefined, signal),
  );
}
export async function saveMemoryNode(token: string, input: MemoryNodeInput) {
  const { id, ...body } = input;
  return memoryNodeSchema.parse(
    await request(
      token,
      id ? `nodes/${encodeURIComponent(id)}` : "nodes",
      id ? "PUT" : "POST",
      body,
    ),
  );
}
export async function deleteMemoryNode(token: string, id: string) {
  await request(token, `nodes/${encodeURIComponent(id)}`, "DELETE");
}
export async function saveMemoryEdge(token: string, input: MemoryEdgeInput) {
  return memoryEdgeInputSchema.parse(
    await request(token, "edges", "POST", input),
  );
}
export async function deleteMemoryEdge(token: string, input: MemoryEdgeInput) {
  await request(token, "edges", "DELETE", input);
}
