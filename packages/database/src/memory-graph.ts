/**
 * 功能概述：以 PostgreSQL 保存独立的 Memory 节点和有向类型边。
 * 主要职责：原子 upsert 节点与边；updateNode 只更新已有节点，避免并发删除后重新创建。单条 SQL 返回有界图与一跳邻域快照。
 * 代码库关系：实现 memory/graph.ts 契约，由 KaguyaDatabase.memoryGraph 暴露；
 * schema.ts 在启动事务中调用 prepareMemoryGraphSchema，不依赖原始消息或 Information ID。
 * 输入输出与副作用：每个写操作执行一条 SQL；删除节点由外键级联删除关联边。
 */
import { randomUUID } from "node:crypto";
import {
  memoryEdgeInputSchema,
  memoryEdgeQuerySchema,
  memoryNodeIdSchema,
  memoryNodeInputSchema,
  memoryNodeQuerySchema,
  memoryGraphQuerySchema,
  type MemoryGraphQuery,
  type MemoryGraphSnapshot,
  type MemoryEdge,
  type MemoryEdgeInput,
  type MemoryEdgeQuery,
  type MemoryGraphAccess,
  type MemoryNode,
  type MemoryNodeInput,
  type MemoryNodeQuery,
} from "@kaguya/memory";
import type { SqlTransaction } from "./driver.js";

export async function prepareMemoryGraphSchema(
  tx: SqlTransaction,
): Promise<void> {
  await tx.exec(`
    CREATE TABLE IF NOT EXISTS memory_nodes (
      id uuid PRIMARY KEY,
      metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
      content text NOT NULL CHECK (length(btrim(content)) > 0)
    );
    CREATE INDEX IF NOT EXISTS memory_nodes_metadata_idx ON memory_nodes USING gin(metadata);
    CREATE INDEX IF NOT EXISTS memory_nodes_time_idx ON memory_nodes ((metadata->>'occurredAt'), id);
    CREATE TABLE IF NOT EXISTS memory_edges (
      source_id uuid NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      target_id uuid NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      relation text NOT NULL CHECK (length(btrim(relation)) > 0),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS memory_edges_target_idx ON memory_edges(target_id, source_id, relation);
  `);
}

type NodeRow = {
  id: string;
  metadata: MemoryNode["metadata"];
  content: string;
};
type EdgeRow = {
  source_id: string;
  target_id: string;
  relation: string;
  metadata: MemoryEdge["metadata"];
};

export class PostgresMemoryGraphStore implements MemoryGraphAccess {
  constructor(private readonly database: SqlTransaction) {}

  /** 单条 SQL 冻结节点及其内部边，避免并发编辑生成悬空的检视快照。 */
  async readGraph(query: MemoryGraphQuery = {}): Promise<MemoryGraphSnapshot> {
    const parsed = memoryGraphQuerySchema.parse(query);
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const predicates = nodePredicates(parsed, bind);
    if (parsed.focusId !== undefined) {
      const focus = bind(parsed.focusId);
      predicates.push(`(id=${focus}::uuid OR id IN (
        SELECT target_id FROM memory_edges WHERE source_id=${focus}::uuid
        UNION SELECT source_id FROM memory_edges WHERE target_id=${focus}::uuid
      ))`);
    }
    const focus = bind(parsed.focusId ?? null);
    const order = `(id=${focus}::uuid) DESC NULLS LAST, id`;
    const limit = bind(parsed.limit);
    const result = await this.database.query<{
      nodes: NodeRow[];
      edges: EdgeRow[];
      more_nodes: boolean;
      more_edges: boolean;
    }>(
      `WITH candidates AS (
         SELECT id, metadata, content FROM memory_nodes
         WHERE ${predicates.join(" AND ")} ORDER BY ${order} LIMIT (${limit}::int + 1)
       ), visible AS (
         SELECT * FROM candidates ORDER BY ${order} LIMIT ${limit}
       ), links AS (
         SELECT * FROM memory_edges WHERE source_id IN (SELECT id FROM visible)
         AND target_id IN (SELECT id FROM visible)
         ORDER BY source_id, target_id, relation LIMIT 1001
       ) SELECT
         COALESCE((SELECT jsonb_agg(v ORDER BY ${order}) FROM visible v), '[]'::jsonb) AS nodes,
         COALESCE((SELECT jsonb_agg(e) FROM (SELECT * FROM links LIMIT 1000) e), '[]'::jsonb) AS edges,
         (SELECT count(*) > ${limit}::int FROM candidates) AS more_nodes,
         (SELECT count(*) > 1000 FROM links) AS more_edges`,
      values,
    );
    const row = result.rows[0]!;
    return {
      nodes: row.nodes,
      edges: row.edges.map(edgeFromRow),
      hasMoreNodes: row.more_nodes,
      hasMoreEdges: row.more_edges,
    };
  }

  /** 省略 id 时创建节点，指定 id 时完整替换 metadata 和 content。 */
  async putNode(input: MemoryNodeInput): Promise<MemoryNode> {
    const parsed = memoryNodeInputSchema.parse(input);
    const result = await this.database.query<NodeRow>(
      `INSERT INTO memory_nodes(id, metadata, content) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET metadata=EXCLUDED.metadata, content=EXCLUDED.content
       RETURNING id, metadata, content`,
      [
        parsed.id ?? randomUUID(),
        JSON.stringify(parsed.metadata),
        parsed.content,
      ],
    );
    return result.rows[0]!;
  }

  async getNode(id: string): Promise<MemoryNode | undefined> {
    const result = await this.database.query<NodeRow>(
      "SELECT id, metadata, content FROM memory_nodes WHERE id=$1",
      [memoryNodeIdSchema.parse(id)],
    );
    return result.rows[0];
  }

  async updateNode(
    input: MemoryNodeInput & { id: string },
  ): Promise<MemoryNode | undefined> {
    const parsed = memoryNodeInputSchema
      .extend({ id: memoryNodeIdSchema })
      .parse(input);
    const result = await this.database.query<NodeRow>(
      `UPDATE memory_nodes SET metadata=$2::jsonb, content=$3 WHERE id=$1
       RETURNING id, metadata, content`,
      [parsed.id, JSON.stringify(parsed.metadata), parsed.content],
    );
    return result.rows[0];
  }

  async listNodes(query: MemoryNodeQuery = {}): Promise<readonly MemoryNode[]> {
    const parsed = memoryNodeQuerySchema.parse(query);
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const predicates = nodePredicates(parsed, bind);
    const result = await this.database.query<NodeRow>(
      `SELECT id, metadata, content FROM memory_nodes WHERE ${predicates.join(" AND ")} ORDER BY id LIMIT ${bind(parsed.limit)}`,
      values,
    );
    return result.rows;
  }

  async deleteNode(id: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM memory_nodes WHERE id=$1 RETURNING id",
      [memoryNodeIdSchema.parse(id)],
    );
    return result.rows.length > 0;
  }

  async putEdge(input: MemoryEdgeInput): Promise<MemoryEdge> {
    const parsed = memoryEdgeInputSchema.parse(input);
    const result = await this.database.query<EdgeRow>(
      `INSERT INTO memory_edges(source_id, target_id, relation, metadata) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (source_id, target_id, relation) DO UPDATE SET metadata=EXCLUDED.metadata
       RETURNING source_id, target_id, relation, metadata`,
      [
        parsed.sourceId,
        parsed.targetId,
        parsed.relation,
        JSON.stringify(parsed.metadata),
      ],
    );
    return edgeFromRow(result.rows[0]!);
  }

  async listEdges(query: MemoryEdgeQuery): Promise<readonly MemoryEdge[]> {
    const parsed = memoryEdgeQuerySchema.parse(query);
    const direction =
      parsed.direction === "outgoing"
        ? "source_id=$1"
        : parsed.direction === "incoming"
          ? "target_id=$1"
          : "(source_id=$1 OR target_id=$1)";
    const result = await this.database.query<EdgeRow>(
      `SELECT source_id, target_id, relation, metadata FROM memory_edges
       WHERE ${direction} AND ($2::text IS NULL OR relation=$2)
       ORDER BY source_id, target_id, relation LIMIT $3`,
      [parsed.nodeId, parsed.relation ?? null, parsed.limit],
    );
    return result.rows.map(edgeFromRow);
  }

  async deleteEdge(
    sourceId: string,
    targetId: string,
    relation: string,
  ): Promise<boolean> {
    const parsed = memoryEdgeInputSchema.parse({
      sourceId,
      targetId,
      relation,
    });
    const result = await this.database.query(
      "DELETE FROM memory_edges WHERE source_id=$1 AND target_id=$2 AND relation=$3 RETURNING source_id",
      [parsed.sourceId, parsed.targetId, parsed.relation],
    );
    return result.rows.length > 0;
  }
}

function edgeFromRow(row: EdgeRow): MemoryEdge {
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
    metadata: row.metadata,
  };
}

function nodePredicates(
  parsed: ReturnType<typeof memoryNodeQuerySchema.parse>,
  bind: (value: unknown) => string,
): string[] {
  const predicates = ["true"];
  if (parsed.tags.length)
    predicates.push(
      `metadata @> ${bind(JSON.stringify({ tags: parsed.tags }))}::jsonb`,
    );
  if (parsed.search)
    predicates.push(
      `strpos(lower(content), lower(${bind(parsed.search)})) > 0`,
    );
  if (parsed.occurredFrom !== undefined)
    predicates.push(`metadata->>'occurredAt' >= ${bind(parsed.occurredFrom)}`);
  if (parsed.occurredBefore !== undefined)
    predicates.push(`metadata->>'occurredAt' < ${bind(parsed.occurredBefore)}`);
  if (parsed.afterId !== undefined)
    predicates.push(`id > ${bind(parsed.afterId)}`);
  return predicates;
}
