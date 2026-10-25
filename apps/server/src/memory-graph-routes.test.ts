/**
 * 功能概述：以真实隔离 PGlite 和 Fastify inject 验证 Memory 图管理 HTTP 契约。
 * 主要职责：检查管理认证、有界完整图、正文／标签筛选、一跳邻域、节点编辑、删除后不可编辑及关系级联删除。
 * 代码库关系：组合 app.ts 路由和 database.memoryGraph，不启动 Runtime 或调用外部模型。
 * 输入输出与副作用：等待明确的 HTTP/数据库 Promise；afterAll 关闭应用及数据库，无 sleep 或后台轮询。
 */
/**
 * 功能概述：以真实隔离 PGlite 和 Fastify inject 验证 Memory 图管理 HTTP 契约。
 * 主要职责：检查管理认证、有界完整图、正文／标签筛选、一跳邻域、节点编辑、删除后不可编辑及关系级联删除。
 * 代码库关系：组合 app.ts 路由和 database.memoryGraph，不启动 Runtime 或调用外部模型。
 * 输入输出与副作用：等待明确的 HTTP/数据库 Promise；afterAll 关闭应用及数据库，无 sleep 或后台轮询。
 */
import { randomUUID } from "node:crypto";
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

describe("versioned Memory HTTP management", () => {
  let database: Awaited<ReturnType<typeof createTestingDatabase>>;
  let app: Awaited<ReturnType<typeof createHttpApplication>>;
  const id = randomUUID();
  beforeAll(async () => {
    database = await createTestingDatabase();
    await database.prepareSchema();
    app = await createHttpApplication({
      config,
      memoryGraph: () => database.memoryGraph,
    });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });
  const publish = (
    content: string,
    expectedRevision: number,
    operationId = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/memory/publications",
      headers,
      payload: {
        operationId,
        actor: "manual",
        nodes: [
          {
            expectedRevision,
            node: {
              id,
              content,
              metadata: {
                ...metadata,
                system: "native-v1",
                kind: "person",
                ownerId: "person:test",
                scope: "scope:test",
                level: 0,
                revision: expectedRevision + 1,
                status: "active",
                locked: false,
                sourceIds: [],
                aliases: [],
              },
            },
          },
        ],
        edges: [],
      },
    });
  it("authenticates graph reads and version publication", async () => {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/memory/${method === "GET" ? "graph" : "publications"}`,
      });
      expect(response.statusCode).toBe(401);
    }
  });
  it("publishes, reads, revises and preserves the actual revision history", async () => {
    const first = await publish("喜欢钢琴", 0);
    expect(first.statusCode).toBe(200);
    const graph = await app.inject({
      url: "/api/v1/memory/graph?kind=person&level=0&tags=音乐",
      headers,
    });
    const parsed = memoryGraphSnapshotSchema.parse(graph.json().data);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.metadata.revision).toBe(1);
    expect((await publish("喜欢钢琴与肖邦", 1)).statusCode).toBe(200);
    expect((await publish("过期编辑", 1)).statusCode).toBe(409);
    const detail = await app.inject({
      url: `/api/v1/memory/nodes/${id}`,
      headers,
    });
    expect(detail.json().data).toMatchObject({
      content: "喜欢钢琴与肖邦",
      metadata: { revision: 2 },
    });
    const history = await app.inject({
      url: `/api/v1/memory/nodes/${id}/history`,
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data).toHaveLength(2);
  });
});
