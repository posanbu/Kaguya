/**
 * 功能概述：验证 Memory 节点／边的持久化契约及新旧 schema 初始化。
 * 主要职责：检查正文保真、标签与时间筛选、更新不重建已删除节点、图截取、方向、去重和级联删除。
 * 代码库关系：共享 testing.ts 的隔离数据库工厂，可在 PGlite 和真实 PostgreSQL 运行。
 * 输入输出与副作用：直接等待数据库 Promise，不使用轮询或 sleep；每例关闭数据库。
 */
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
  it("reads a bounded graph from versioned publication and preserves it across schema preparation", async () => {
    const database = await setup();
    const ids = [1, 2, 3].map(
      (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    );
    const nodes = ids.map((id, index) => ({
      id,
      content: `钢琴记录 ${index}`,
      metadata: {
        system: "native-v1" as const,
        kind: "person" as const,
        ownerId: "person:test",
        scope: "scope:test",
        level: index,
        revision: 1,
        status: "active" as const,
        locked: false,
        sourceIds: [],
        aliases: [],
        tags: ["音乐"],
        occurredAt: "2026-10-20T00:00:00Z",
      },
    }));
    await database.memoryGraph.native.publish({
      operationId: "graph",
      actor: "manual",
      nodes: nodes.map((node) => ({ node, expectedRevision: 0 })),
      edges: [{ sourceId: ids[0]!, targetId: ids[1]!, relation: "summarizes" }],
    });
    const graph = await database.memoryGraph.readGraph({
      system: "native-v1",
      tags: ["音乐"],
      limit: 2,
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.hasMoreNodes).toBe(true);
    expect(
      graph.edges.every(
        (e) =>
          graph.nodes.some((n) => n.id === e.sourceId) &&
          graph.nodes.some((n) => n.id === e.targetId),
      ),
    ).toBe(true);
    await database.prepareSchema();
    expect(await database.memoryGraph.getNode(ids[0]!)).toEqual(nodes[0]);
  });
});
