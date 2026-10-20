/**
 * 功能概述：声明跨浏览器与服务端共享的 Memory 节点、有向边、查询和图快照协议。
 * 主要职责：校验可扩展 JSON metadata，规范化 UTC 时间、标签及有界检视查询。
 * 代码库关系：schema 入口导出；memory 声明存储端口，database/server/web 共用同一字段契约。
 * 输入输出与副作用：只执行同步解析，不建立数据库连接或发出网络请求。
 */
import { z } from "zod";

const nonBlank = z.string().trim().min(1);
export const memoryNodeIdSchema = z.uuid();

export const memoryNodeMetadataSchema = z
  .object({
    occurredAt: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    tags: z
      .array(nonBlank)
      .default([])
      .transform((tags) => [...new Set(tags)]),
  })
  .catchall(z.json());

export const memoryNodeInputSchema = z
  .object({
    id: memoryNodeIdSchema.optional(),
    metadata: memoryNodeMetadataSchema,
    // 保留 Markdown 的缩进和换行，只拒绝空白正文。
    content: z
      .string()
      .refine(
        (value) => value.trim().length > 0,
        "Memory content must not be blank",
      ),
  })
  .strict();

export type MemoryNodeInput = z.input<typeof memoryNodeInputSchema>;
export interface MemoryNode {
  readonly id: string;
  readonly metadata: z.output<typeof memoryNodeMetadataSchema>;
  readonly content: string;
}

export const memoryEdgeInputSchema = z
  .object({
    sourceId: memoryNodeIdSchema,
    targetId: memoryNodeIdSchema,
    relation: nonBlank.default("related"),
    metadata: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export type MemoryEdgeInput = z.input<typeof memoryEdgeInputSchema>;
export type MemoryEdge = z.output<typeof memoryEdgeInputSchema>;

export const memoryNodeQuerySchema = z
  .object({
    tags: z.array(nonBlank).default([]),
    search: z.string().trim().max(512).optional(),
    occurredFrom: z.iso
      .datetime({ offset: true })
      .optional()
      .transform((value) =>
        value === undefined ? undefined : new Date(value).toISOString(),
      ),
    occurredBefore: z.iso
      .datetime({ offset: true })
      .optional()
      .transform((value) =>
        value === undefined ? undefined : new Date(value).toISOString(),
      ),
    afterId: memoryNodeIdSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type MemoryNodeQuery = z.input<typeof memoryNodeQuerySchema>;

export const memoryEdgeQuerySchema = z
  .object({
    nodeId: memoryNodeIdSchema,
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
    relation: nonBlank.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type MemoryEdgeQuery = z.input<typeof memoryEdgeQuerySchema>;

export const memoryNodeSchema = memoryNodeInputSchema.extend({
  id: memoryNodeIdSchema,
});
export const memoryGraphQuerySchema = memoryNodeQuerySchema.extend({
  focusId: memoryNodeIdSchema.optional(),
});
export type MemoryGraphQuery = z.input<typeof memoryGraphQuerySchema>;
export const memoryGraphSnapshotSchema = z.object({
  nodes: z.array(memoryNodeSchema),
  edges: z.array(memoryEdgeInputSchema),
  hasMoreNodes: z.boolean(),
  hasMoreEdges: z.boolean(),
});
export type MemoryGraphSnapshot = z.output<typeof memoryGraphSnapshotSchema>;
