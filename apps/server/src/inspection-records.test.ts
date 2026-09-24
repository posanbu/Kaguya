/**
 * 功能概述：在隔离 PGlite 上验证 record-browser 的只读 API、分页绑定、因果引用与来源投影。
 * 主要职责：复用演示账本覆盖正常/空结果/故障/无终态，额外构造同时间分页、错误关系与脱敏来源；不依赖固定 sleep。
 * 代码库关系：Fastify 注册正式 inspection 路由，fixture 直接 await schema/写入；afterAll 关闭服务和数据库，hook 留有初始化预算。
 * 输入输出与副作用：只触及测试数据库；不启动运行时、队列、外部检索或模型，每个断言基于已完成的注入请求。
 */
import Fastify from "fastify";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  freezeInformationAtom,
  inspectionSurfaceEntitySchema,
  type InspectionModule,
} from "@kaguya/schema";
import {
  createInspectionService,
  registerInspectionRoutes,
} from "./inspection.js";
import {
  associationPreviewModule,
  seedAssociationPreview,
} from "./preview/association-fixture.js";
let database: Awaited<ReturnType<typeof createTestingDatabase>>;
const app = Fastify();
const base =
  "/api/v1/inspection/modules/memory.association/surfaces/associations";
const headers = { authorization: "Bearer test-preview" };
beforeAll(async () => {
  database = await createTestingDatabase();
  await database.prepareSchema();
  await seedAssociationPreview(database);
  registerInspectionRoutes(
    app,
    createInspectionService({
      ledger: database.information,
      modules: () => [associationPreviewModule],
      secrets: { token: "synthetic-hidden-value" },
    }),
    async (request, reply) => {
      if (request.headers.authorization !== headers.authorization)
        return reply.code(401).send({ error: { code: "unauthorized" } });
    },
  );
  await app.ready();
}, 15000);
afterAll(async () => {
  await app.close();
  await database?.close();
});
const get = (suffix = "") =>
  app.inject({ method: "GET", url: base + suffix, headers });
it("authenticates read-only routes, binds cursors and keeps same-time records distinct", async () => {
  expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: "POST", url: base, headers })).statusCode,
  ).toBe(404);
  const response = await get("?limit=2");
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const first = response.json().data;
  expect(first.items).toHaveLength(2);
  const second = (await get(`?limit=2&cursor=${first.nextCursor}`)).json().data;
  expect(
    new Set([...first.items, ...second.items].map((item) => item.entityId))
      .size,
  ).toBe(4);
  expect((await get(`?q=其他&cursor=${first.nextCursor}`)).statusCode).toBe(
    400,
  );
  expect((await get("?limit=51")).statusCode).toBe(400);
  expect((await get("?status=matched")).statusCode).toBe(400);
  expect((await get("?q=不存在的查询")).json().data.items).toEqual([]);
  expect((await get("?q=demo-research")).json().data.items).toHaveLength(14);
  expect((await get("/entities/demo-source-1")).statusCode).toBe(404);
  expect((await get("/entities/missing")).statusCode).toBe(404);
});
it("keeps outcome distinctions and sorts candidate receipts by rank with canonical source text", async () => {
  const page = (await get()).json().data;
  expect(
    page.items.slice(0, 6).map((item: { status?: string }) => item.status),
  ).toEqual([
    "matched",
    "empty",
    "failed",
    "policy-filtered",
    "unavailable",
    undefined,
  ]);
  const detail = (await get("/entities/demo-query-01")).json().data;
  expect(detail.sections[0].items[0].status).toBe("matched");
  expect(
    detail.sections[1].items.map((item: { rank: number }) => item.rank),
  ).toEqual([0, 1]);
  expect(detail.sections[1].items[0].relatedSource).toMatchObject({
    informationId: "demo-source-1",
    available: true,
  });
  expect(detail.sections[1].items[0].relatedSource.fields[0].value).toContain(
    "最后采用方案 B",
  );
  const source = (
    await app.inject({
      method: "GET",
      url: "/api/v1/inspection/atoms/demo-source-1",
      headers,
    })
  ).json().data.atom;
  expect(source.presentation.fields).toContainEqual({
    label: "来源会话",
    value: {
      platform: "qq",
      adapterId: "demo",
      destination: { kind: "group", groupId: "demo-research" },
    },
  });
  expect(
    (await get("/entities/demo-query-06")).json().data.sections[0].items,
  ).toEqual([]);
  const missing = (await get("/entities/demo-query-08")).json().data.sections[1]
    .items[0];
  expect(missing.relatedSource).toEqual({ available: false, fields: [] });
  expect(missing.sourceInformationId).toBe("demo-query-08-candidate-0");
});
it("does not join unrelated edges or expose unapproved fields and leaves the ledger unchanged", async () => {
  await database.information.append(
    freezeInformationAtom({
      informationId: "wrong-edge",
      kind: "memory.association.candidate",
      occurredAt: "2026-09-19T07:42:00.000Z",
      source: "preview:test",
      payload: { rank: 99 },
      references: [
        { relation: "agent:request", informationId: "demo-query-01" },
      ],
    }),
    [{ relation: "agent:request", required: false, multiple: false }],
  );
  await database.information.append(
    freezeInformationAtom({
      informationId: "secret-query",
      kind: "memory.association.query",
      occurredAt: "2026-09-19T07:42:00.000Z",
      source: "preview:test",
      payload: {
        query: "synthetic-hidden-value",
        apiKey: "unknown-sensitive-value",
      },
      references: [],
    }),
    [],
  );
  const before = await database.information.inspectPage({
    kind: "memory.association.query",
    limit: 100,
  });
  const detail = await get("/entities/demo-query-01");
  expect(detail.body).not.toContain("wrong-edge");
  const secret = await get("/entities/secret-query");
  expect(secret.body).not.toContain("synthetic-hidden-value");
  expect(secret.body).not.toContain("unknown-sensitive-value");
  const first = (await get("?limit=1")).json().data;
  const second = (await get(`?limit=1&cursor=${first.nextCursor}`)).json().data;
  expect(new Set([first.items[0].entityId, second.items[0].entityId])).toEqual(
    new Set(["secret-query", "demo-query-01"]),
  );
  expect(
    await database.information.inspectPage({
      kind: "memory.association.query",
      limit: 100,
    }),
  ).toEqual(before);
});
it("reports bounded relation truncation and rejects source kinds outside the declared projection", async () => {
  const module: InspectionModule = structuredClone(associationPreviewModule);
  const browser = module.inspection!.surface!.components.find(
    (item) => item.type === "record-browser",
  )!;
  browser.relations[1]!.limit = 1;
  browser.relations[1]!.source!.kinds = ["memory.text"];
  const service = createInspectionService({
    ledger: database.information,
    modules: () => [module],
    secrets: {},
  });
  const detail = inspectionSurfaceEntitySchema.parse(
    await service.surfaceEntity(
      module.definitionId,
      "associations",
      "demo-query-01",
    ),
  );
  expect(detail.sections[1]!.truncated).toBe(true);
  expect(detail.sections[1]!.items).toHaveLength(1);
  expect(detail.sections[1]!.items[0]!.relatedSource).toEqual({
    available: false,
    fields: [],
  });
});
