/**
 * 功能概述：验证 Memory 节点／边的持久化契约及新旧 schema 初始化。
 * 主要职责：检查正文保真、标签与时间筛选、更新不重建已删除节点、图截取、方向、去重和级联删除。
 * 代码库关系：共享 testing.ts 的隔离数据库工厂，可在 PGlite 和真实 PostgreSQL 运行。
 * 输入输出与副作用：直接等待数据库 Promise，不使用轮询或 sleep；每例关闭数据库。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createPostgresTestingDatabase,
  createTestingDatabase,
} from "./testing.js";

const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
if (
  process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" &&
  connectionString === undefined
) {
  throw new Error("KAGUYA_TEST_DATABASE_URL is required for PostgreSQL tests");
}
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(connectionString === undefined
    ? []
    : [
        {
          name: "PostgreSQL",
          create: () => createPostgresTestingDatabase(connectionString),
        },
      ]),
];
const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe.each(backends)("Memory graph ($name)", ({ create }) => {
  async function setup() {
    const database = await create();
    databases.push(database);
    await database.prepareSchema();
    return database;
  }
  const metadata = {
    occurredAt: "2026-10-17T10:00:00+08:00",
    tags: ["xxx用户", "音乐"],
  };

  it("stores exactly three node columns and preserves Markdown and extensible JSON metadata", async () => {
    const database = await setup();
    const content = "# 音乐偏好\n\n  喜欢钢琴。\n";
    const node = await database.memoryGraph.putNode({
      metadata: {
        ...metadata,
        tags: ["音乐", "xxx用户", "音乐"],
        source: { messageIds: ["m1", "m2"] },
      },
      content,
    });
    expect(node.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await database.memoryGraph.getNode(node.id)).toEqual({
      id: node.id,
      content,
      metadata: {
        occurredAt: "2026-10-17T02:00:00.000Z",
        tags: ["音乐", "xxx用户"],
        source: { messageIds: ["m1", "m2"] },
      },
    });
    const columns = await database.sql.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='memory_nodes' ORDER BY ordinal_position",
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "metadata",
      "content",
    ]);
    await database.prepareSchema();
    expect(await database.memoryGraph.getNode(node.id)).toEqual(node);
  });

  it("filters all tags and inclusive/exclusive UTC time bounds with a stable ID cursor", async () => {
    const database = await setup();
    const first = await database.memoryGraph.putNode({
      id: "00000000-0000-4000-8000-000000000001",
      metadata,
      content: "第一条",
    });
    const second = await database.memoryGraph.putNode({
      id: "00000000-0000-4000-8000-000000000002",
      metadata: { ...metadata, occurredAt: "2026-10-17T03:00:00Z" },
      content: "第二条",
    });
    await database.memoryGraph.putNode({
      metadata: { ...metadata, tags: ["音乐"] },
      content: "另一个用户",
    });
    expect(
      await database.memoryGraph.listNodes({
        tags: ["xxx用户", "音乐"],
        occurredFrom: metadata.occurredAt,
        occurredBefore: "2026-10-17T03:00:00Z",
      }),
    ).toEqual([first]);
    expect(
      await database.memoryGraph.listNodes({
        tags: ["xxx用户"],
        afterId: first.id,
        limit: 1,
      }),
    ).toEqual([second]);
    expect(await database.memoryGraph.listNodes({ tags: ["不存在"] })).toEqual(
      [],
    );
  });

  it("replaces a node by ID, supports omitted tags, and rejects invalid input before writes", async () => {
    const database = await setup();
    const node = await database.memoryGraph.putNode({
      metadata,
      content: "旧内容",
    });
    const updated = await database.memoryGraph.putNode({
      id: node.id,
      metadata: { occurredAt: metadata.occurredAt },
      content: "新内容",
    });
    expect(updated.metadata.tags).toEqual([]);
    expect(await database.memoryGraph.listNodes()).toEqual([updated]);
    await expect(
      database.memoryGraph.putNode({ metadata, content: " \n " }),
    ).rejects.toThrow();
    await expect(
      database.memoryGraph.putNode({
        metadata: { ...metadata, occurredAt: "昨天" },
        content: "非法时间",
      }),
    ).rejects.toThrow();
    await expect(
      database.memoryGraph.putNode({
        metadata: { ...metadata, value: Number.NaN },
        content: "非法 JSON",
      }),
    ).rejects.toThrow();
    await expect(
      database.memoryGraph.listNodes({ limit: 101 }),
    ).rejects.toThrow();
    await expect(database.memoryGraph.getNode("not-an-id")).rejects.toThrow();
    expect(await database.memoryGraph.listNodes()).toHaveLength(1);
  });

  it("preserves edge directions and relation types while updating duplicate edge metadata", async () => {
    const database = await setup();
    const a = await database.memoryGraph.putNode({ metadata, content: "A" });
    const b = await database.memoryGraph.putNode({ metadata, content: "B" });
    await database.memoryGraph.putEdge({
      sourceId: a.id,
      targetId: b.id,
      relation: "补充",
      metadata: { evidence: "初始" },
    });
    const forward = await database.memoryGraph.putEdge({
      sourceId: a.id,
      targetId: b.id,
      relation: "补充",
      metadata: { evidence: "修订" },
    });
    const reverse = await database.memoryGraph.putEdge({
      sourceId: b.id,
      targetId: a.id,
      relation: "引用",
    });
    const related = await database.memoryGraph.putEdge({
      sourceId: a.id,
      targetId: b.id,
    });
    expect(related.relation).toBe("related");
    expect(
      await database.memoryGraph.listEdges({
        nodeId: a.id,
        direction: "outgoing",
        relation: "补充",
      }),
    ).toEqual([forward]);
    expect(
      await database.memoryGraph.listEdges({
        nodeId: a.id,
        direction: "incoming",
      }),
    ).toEqual([reverse]);
    expect(await database.memoryGraph.listEdges({ nodeId: a.id })).toHaveLength(
      3,
    );
    expect(await database.memoryGraph.deleteEdge(a.id, b.id, "补充")).toBe(
      true,
    );
    expect(await database.memoryGraph.deleteEdge(a.id, b.id, "补充")).toBe(
      false,
    );
    expect(
      await database.memoryGraph.listEdges({ nodeId: a.id, relation: "引用" }),
    ).toEqual([reverse]);
  });

  it("updates only an existing node and never recreates a deleted memory", async () => {
    const database = await setup();
    const node = await database.memoryGraph.putNode({
      metadata,
      content: "原内容",
    });
    const input = { id: node.id, metadata, content: "修订内容" };
    const updated = await database.memoryGraph.updateNode(input);
    expect(updated?.id).toBe(node.id);
    expect(updated?.content).toBe("修订内容");
    await database.memoryGraph.deleteNode(node.id);
    expect(await database.memoryGraph.updateNode(input)).toBeUndefined();
    expect(await database.memoryGraph.getNode(node.id)).toBeUndefined();
  });

  it("bounds dense graphs to 1000 internal edges and marks truncation", async () => {
    const database = await setup();
    const a = await database.memoryGraph.putNode({ metadata, content: "A" });
    const b = await database.memoryGraph.putNode({ metadata, content: "B" });
    await database.sql.query(
      `INSERT INTO memory_edges(source_id, target_id, relation)
       SELECT $1::uuid, $2::uuid, 'relation-' || value FROM generate_series(1,1001) value`,
      [a.id, b.id],
    );
    const graph = await database.memoryGraph.readGraph({ limit: 100 });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1000);
    expect(graph.hasMoreEdges).toBe(true);
    expect(graph.hasMoreNodes).toBe(false);
    expect(
      graph.edges.every(
        (edge) => edge.sourceId === a.id && edge.targetId === b.id,
      ),
    ).toBe(true);
  });

  it("rejects dangling edges and cascades both directions when a node is deleted", async () => {
    const database = await setup();
    const a = await database.memoryGraph.putNode({ metadata, content: "A" });
    const b = await database.memoryGraph.putNode({ metadata, content: "B" });
    await expect(
      database.memoryGraph.putEdge({
        sourceId: a.id,
        targetId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toThrow();
    await database.memoryGraph.putEdge({ sourceId: a.id, targetId: b.id });
    await database.memoryGraph.putEdge({ sourceId: b.id, targetId: a.id });
    expect(await database.memoryGraph.deleteNode(a.id)).toBe(true);
    expect(await database.memoryGraph.deleteNode(a.id)).toBe(false);
    expect(await database.memoryGraph.getNode(a.id)).toBeUndefined();
    expect(await database.memoryGraph.getNode(b.id)).toEqual(b);
    expect(await database.memoryGraph.listEdges({ nodeId: b.id })).toEqual([]);
  });

  it("adds graph tables to an existing database without resetting the raw projection checkpoint", async () => {
    const database = await setup();
    await database.sql.exec("DROP TABLE memory_edges; DROP TABLE memory_nodes");
    await database.sql.exec(
      "UPDATE memory_raw_checkpoint SET position=42 WHERE singleton=true",
    );
    const before = await database.sql.query(
      "SELECT * FROM memory_raw_checkpoint",
    );
    await database.prepareSchema();
    expect(
      (await database.sql.query("SELECT * FROM memory_raw_checkpoint")).rows,
    ).toEqual(before.rows);
    const node = await database.memoryGraph.putNode({
      metadata,
      content: "升级后",
    });
    expect(await database.memoryGraph.getNode(node.id)).toEqual(node);
  });
});
