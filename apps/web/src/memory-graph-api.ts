/**
 * 功能概述：封装 Memory 图检视及节点／边管理 HTTP 请求。
 * 主要职责：校验响应、保留输入错误语义、将 401 交给 App 全局锁屏，并支持取消过期读取。
 * 代码库关系：MemoryGraph 页面调用，协议来自 schema，服务端由 memory-graph-routes.ts 实现。
 * 输入输出与副作用：Token 仅通过 Authorization 发送；写操作持久化到 PostgreSQL。
 */
/**
 * 功能概述：封装 Memory 图检视及节点／边管理 HTTP 请求。
 * 主要职责：校验响应、保留输入错误语义、将 401 交给 App 全局锁屏，并支持取消过期读取。
 * 代码库关系：MemoryGraph 页面调用，协议来自 schema，服务端由 memory-graph-routes.ts 实现。
 * 输入输出与副作用：Token 仅通过 Authorization 发送；写操作持久化到 PostgreSQL。
 */
import {
  memoryGraphSnapshotSchema,
  nativeMemoryNodeSchema,
  memoryEdgeInputSchema,
  type MemoryGraphQuery,
  type MemoryNodeInput,
  type MemoryNode,
  type MemoryEdgeInput,
  z,
} from "@kaguya/schema";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";

const messages: Record<string, string> = {
  memory_revision_conflict: "记忆已被修改。请刷新后重新编辑。",
  memory_summary_conflict:
    "此对象在该范围已有有效的 level 0 摘要，请编辑已有摘要。",
  memory_publication_required: "此记忆必须通过版本发布保存。",
  memory_invalid_edge:
    "摘要连结必须从较小 level 指向较大 level，且两端属于新记忆体系。",
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
  const expectedRevision = Number(input.metadata.revision ?? 0);
  const node = nativeMemoryNodeSchema.parse({
    ...input,
    id: input.id ?? crypto.randomUUID(),
    metadata: { ...input.metadata, revision: expectedRevision + 1 },
  });
  const result = await request(token, "publications", "POST", {
    operationId: crypto.randomUUID(),
    actor: "manual",
    nodes: [{ expectedRevision, node }],
    edges: [],
  });
  return nativeMemoryNodeSchema.parse((result as unknown[])[0]);
}
export async function deleteMemoryNode(token: string, node: MemoryNode) {
  await saveMemoryNode(token, {
    ...node,
    metadata: { ...node.metadata, status: "archived" },
  });
}
export async function saveMemoryEdge(
  token: string,
  input: MemoryEdgeInput,
  expectedVersions: Record<string, number> = {},
) {
  await request(token, "publications", "POST", {
    operationId: crypto.randomUUID(),
    actor: "manual",
    expectedVersions,
    nodes: [],
    edges: [input],
  });
  return memoryEdgeInputSchema.parse(input);
}
export async function deleteMemoryEdge(
  token: string,
  input: MemoryEdgeInput,
  expectedVersions: Record<string, number> = {},
) {
  await request(token, "publications", "POST", {
    operationId: crypto.randomUUID(),
    actor: "manual",
    expectedVersions,
    nodes: [],
    edges: [],
    removeEdges: [input],
  });
}

export async function readMemoryHistory(
  token: string,
  id: string,
  signal?: AbortSignal,
) {
  return request(
    token,
    `nodes/${encodeURIComponent(id)}/history`,
    "GET",
    undefined,
    signal,
  );
}
const memoryStatusSchema = z.object({
  batches: z.array(
    z.object({ id: z.string(), scope: z.string(), status: z.string() }),
  ),
  snapshots: z.array(
    z.object({
      id: z.string(),
      frozenAt: z.string(),
      status: z.enum(["enabled", "disabled"]),
      fixed: z.number(),
      recalled: z.number(),
      degraded: z.array(z.string()),
    }),
  ),
  counts: z.object({
    queued: z.number(),
    pending: z.number(),
    rejected: z.number(),
    nodes: z.number(),
    fixed: z.number(),
  }),
  stages: z.array(
    z.object({ stage: z.string(), status: z.string(), updated_at: z.string() }),
  ),
});
export async function readNativeMemoryStatus(
  token: string,
  signal?: AbortSignal,
) {
  return memoryStatusSchema.parse(
    await request(token, "status", "GET", undefined, signal),
  );
}

export async function retryMemoryBatch(token: string, id: string) {
  return request(token, `batches/${encodeURIComponent(id)}/retry`, "POST");
}
