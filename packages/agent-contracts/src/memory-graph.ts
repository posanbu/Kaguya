/**
 * 功能概述：声明跨浏览器与服务端共享的 Memory 节点、有向边、查询和图快照协议。
 * 主要职责：校验可扩展 JSON metadata，规范化 UTC 时间、标签及有界检视查询。
 * 代码库关系：schema 入口导出；memory 声明存储端口，database/server/web 共用同一字段契约。
 * 输入输出与副作用：只执行同步解析，不建立数据库连接或发出网络请求。
 */
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
    kind: z
      .enum(["person", "conversation", "self", "experience", "expression"])
      .optional(),
    ownerId: nonBlank.optional(),
    expressionType: z.enum(["habit", "example", "qq-resource"]).optional(),
    level: z.number().int().nonnegative().optional(),
    status: z.enum(["active", "invalidated", "archived"]).optional(),
    system: z.literal("native-v1").optional(),
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

/** Native metadata is deliberately separate from the historical free-form graph. */
export const nativeMemoryMetadataSchema = memoryNodeMetadataSchema.extend({
  occurredAt: z.iso.datetime({ offset: true }),
  tags: z.array(nonBlank).default([]),
  system: z.literal("native-v1"),
  kind: z.enum(["person", "conversation", "self", "experience", "expression"]),
  ownerId: nonBlank,
  scope: nonBlank,
  level: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  status: z.enum(["active", "invalidated", "archived"]).default("active"),
  locked: z.boolean().default(false),
  sourceIds: z.array(nonBlank).default([]),
  aliases: z.array(nonBlank).default([]),
});
export const nativeMemoryNodeSchema = memoryNodeSchema.extend({
  metadata: nativeMemoryMetadataSchema,
});
export type NativeMemoryNode = z.output<typeof nativeMemoryNodeSchema>;
export const memoryPublicationSchema = z
  .object({
    operationId: nonBlank.max(256),
    actor: z.enum(["manual", "automatic"]),
    expectedVersions: z
      .record(memoryNodeIdSchema, z.number().int().positive())
      .default({}),
    nodes: z
      .array(
        z
          .object({
            expectedRevision: z.number().int().nonnegative(),
            node: nativeMemoryNodeSchema,
          })
          .strict(),
      )
      .max(100),
    edges: z.array(memoryEdgeInputSchema).max(500).default([]),
    removeEdges: z.array(memoryEdgeInputSchema).max(500).default([]),
  })
  .strict();
export type MemoryPublication = z.input<typeof memoryPublicationSchema>;
export const memoryRetrievalTraceSchema = z.object({
  channel: z.string(),
  indexVersion: z.string().default("unrecorded"),
  rank: z.number().int().positive(),
  path: z.array(z.string()).default([]),
});
export const memoryRecallItemSchema = z.object({
  node: nativeMemoryNodeSchema,
  traces: z.array(memoryRetrievalTraceSchema),
  truncated: z.boolean(),
});
export const nativeMemorySnapshotSchema = z.object({
  version: z.literal(1),
  status: z.enum(["enabled", "disabled"]),
  frozenAt: z.iso.datetime({ offset: true }),
  scope: z.string(),
  owners: z.array(z.string()),
  people: z
    .array(z.object({ accountId: z.string(), ownerId: nonBlank }))
    .default([]),
  participants: z
    .array(
      z.object({
        platform: nonBlank,
        adapterId: nonBlank,
        accountId: nonBlank,
        ownerId: nonBlank.nullable(),
        nickname: z.string().nullable(),
        card: z.string().nullable(),
        relation: z.enum(["participant", "mentioned", "replied-to"]),
        sourceIds: z.array(nonBlank),
      }),
    )
    .default([]),
  fixed: z.array(nativeMemoryNodeSchema),
  recalled: z.array(memoryRecallItemSchema),
  degraded: z.array(z.string()),
  budget: z.object({
    dynamicCharacters: z.number().int().nonnegative(),
    omittedNodeIds: z.array(z.string()),
  }),
});
export type NativeMemorySnapshot = z.output<typeof nativeMemorySnapshotSchema>;
