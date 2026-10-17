/**
 * 功能概述：以真实隔离 PGlite 和 Fastify inject 验证 Memory 图管理 HTTP 契约。
 * 主要职责：检查管理认证、有界完整图、正文／标签筛选、一跳邻域、节点编辑、删除后不可编辑及关系级联删除。
 * 代码库关系：组合 app.ts 路由和 database.memoryGraph，不启动 Runtime 或调用外部模型。
 * 输入输出与副作用：等待明确的 HTTP/数据库 Promise；afterAll 关闭应用及数据库，无 sleep 或后台轮询。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import { memoryGraphSnapshotSchema } from "@kaguya/schema";
import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";

const token = "memory-graph-test-token";
const headers = { authorization: `Bearer ${token}` };
const metadata = {
  occurredAt: "2026-10-17T04:00:00Z",
  tags: ["fixture", "音乐"],
};
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken: token,
  corsOrigins: [],
  trustProxy: false,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60000,
  databaseUrl: "postgresql://localhost/test",
  configRoot: "/tmp/memory-graph-test",
  development: false,
  webDistPath: "/tmp/web",
  logLevel: "silent",
  logFormat: "json",
  inboundAllowlist: [],
  outboundAllowlist: [],
  napcat: { enabled: false, adapterId: "test", reconnectMs: 3000 },
};

describe("Memory graph management", () => {
  let database: Awaited<ReturnType<typeof createTestingDatabase>>;
  let app: Awaited<ReturnType<typeof createHttpApplication>>;
  let available = true;
  let a: string, b: string, isolated: string;
  beforeAll(async () => {
    database = await createTestingDatabase();
    await database.prepareSchema();
    a = (
      await database.memoryGraph.putNode({ metadata, content: "# 喜欢钢琴" })
    ).id;
    b = (
      await database.memoryGraph.putNode({
        metadata,
        content: "最近在练习肖邦",
      })
    ).id;
    isolated = (
      await database.memoryGraph.putNode({
        metadata: { ...metadata, tags: ["独立"] },
        content: "不相连的记忆",
      })
    ).id;
    await database.memoryGraph.putEdge({
      sourceId: a,
      targetId: b,
      relation: "补充",
    });
    await database.memoryGraph.putEdge({
      sourceId: a,
      targetId: b,
      relation: "支持",
    });
    await database.memoryGraph.putEdge({
      sourceId: b,
      targetId: a,
      relation: "引用",
    });
    app = await createHttpApplication({
      config,
      memoryGraph: () => (available ? database.memoryGraph : undefined),
    });
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await database?.close();
    }
  });

  it("rejects unauthenticated reads and writes before validating IDs or bodies", async () => {
    for (const [method, url] of [
      ["GET", "/graph"],
      ["POST", "/nodes"],
      ["PUT", "/nodes/not-an-id"],
      ["DELETE", "/nodes/not-an-id"],
      ["POST", "/edges"],
      ["DELETE", "/edges"],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/memory${url}`,
      });
      expect(response.statusCode).toBe(401);
    }
  });
  it("returns only edges whose endpoints are in the bounded snapshot and marks truncation", async () => {
    const response = await app.inject({
      url: "/api/v1/memory/graph?tags=fixture&tags=音乐&limit=1",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const first = memoryGraphSnapshotSchema.parse(response.json().data);
    expect(first.nodes).toHaveLength(1);
    expect(first.edges).toEqual([]);
    expect(first.hasMoreNodes).toBe(true);
    const next = await app.inject({
      url: `/api/v1/memory/graph?tags=fixture&afterId=${first.nodes[0]!.id}&limit=1`,
      headers,
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data.nodes).toHaveLength(1);
    expect(next.json().data.hasMoreNodes).toBe(false);
    const full = await app.inject({
      url: "/api/v1/memory/graph?tags=fixture",
      headers,
    });
    expect(full.json().data.nodes).toHaveLength(2);
    expect(full.json().data.edges).toHaveLength(3);
  });
  it("supports literal content search and prioritizes the focused node in its one-hop neighborhood", async () => {
    const search = await app.inject({
      url: `/api/v1/memory/graph?search=${encodeURIComponent("肖邦")}`,
      headers,
    });
    expect(search.statusCode).toBe(200);
    expect(
      search.json().data.nodes.map((node: { id: string }) => node.id),
    ).toEqual([b]);
    const focus = await app.inject({
      url: `/api/v1/memory/graph?focusId=${b}&limit=1`,
      headers,
    });
    expect(focus.statusCode).toBe(200);
    expect(focus.json().data.nodes[0].id).toBe(b);
    expect(focus.json().data.hasMoreNodes).toBe(true);
    const lonely = await app.inject({
      url: `/api/v1/memory/graph?focusId=${isolated}`,
      headers,
    });
    expect(
      lonely.json().data.nodes.map((node: { id: string }) => node.id),
    ).toEqual([isolated]);
    expect(lonely.json().data.edges).toEqual([]);
  });
  it("creates, inspects, edits and deletes nodes without stripping Markdown or metadata", async () => {
    const content = "# 手动记忆\n\n  保留缩进。\n";
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/memory/nodes",
      headers,
      payload: { metadata: { ...metadata, source: { manual: true } }, content },
    });
    expect(created.statusCode).toBe(200);
    const id: string = created.json().data.id;
    const detail = await app.inject({
      url: `/api/v1/memory/nodes/${id}`,
      headers,
    });
    expect(detail.json().data.content).toBe(content);
    expect(detail.json().data.metadata.source).toEqual({ manual: true });
    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/memory/nodes/${id}`,
      headers,
      payload: {
        metadata: { ...metadata, tags: ["已编辑"], source: { manual: true } },
        content: "已修订",
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data.content).toBe("已修订");
    expect(edited.json().data.metadata.tags).toEqual(["已编辑"]);
    await app.inject({
      method: "POST",
      url: "/api/v1/memory/edges",
      headers,
      payload: { sourceId: id, targetId: a, relation: "引用" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/memory/edges",
      headers,
      payload: { sourceId: a, targetId: id, relation: "补充" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/memory/nodes/${id}`,
      headers,
    });
    expect(deleted.json().data.deleted).toBe(true);
    expect(
      (await app.inject({ url: `/api/v1/memory/nodes/${id}`, headers }))
        .statusCode,
    ).toBe(404);
    expect(await database.memoryGraph.listEdges({ nodeId: id })).toEqual([]);
    expect(await database.memoryGraph.getNode(a)).toBeDefined();
    const staleEdit = await app.inject({
      method: "PUT",
      url: `/api/v1/memory/nodes/${id}`,
      headers,
      payload: { metadata, content: "迟到的旧表单" },
    });
    expect(staleEdit.statusCode).toBe(404);
    expect(await database.memoryGraph.getNode(id)).toBeUndefined();
  });
  it("persists and deletes exactly one directional typed edge", async () => {
    const input = {
      sourceId: a,
      targetId: b,
      relation: "后续",
      metadata: { manual: true },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/memory/edges",
          headers,
          payload: input,
        })
      ).json().data,
    ).toEqual(input);
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/memory/edges",
      headers,
      payload: input,
    });
    expect(deleted.json().data.deleted).toBe(true);
    expect(
      await database.memoryGraph.listEdges({ nodeId: a, relation: "后续" }),
    ).toEqual([]);
    expect(await database.memoryGraph.listEdges({ nodeId: a })).toHaveLength(3);
  });
  it("reports invalid input, missing endpoints and an unavailable database without echoing content", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/memory/nodes",
      headers,
      payload: { content: "private-content", metadata: { occurredAt: "昨天" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("private-content");
    expect(
      (await app.inject({ url: "/api/v1/memory/graph?limit=101", headers }))
        .statusCode,
    ).toBe(400);
    const dangling = await app.inject({
      method: "POST",
      url: "/api/v1/memory/edges",
      headers,
      payload: {
        sourceId: a,
        targetId: "00000000-0000-4000-8000-000000000099",
      },
    });
    expect(dangling.statusCode).toBe(409);
    available = false;
    try {
      expect(
        (await app.inject({ url: "/api/v1/memory/graph", headers })).statusCode,
      ).toBe(503);
    } finally {
      available = true;
    }
  });
});
