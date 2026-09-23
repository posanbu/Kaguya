import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  createInspectionService,
  registerInspectionRoutes,
} from "./inspection.js";
import {
  arousalPreviewModule,
  seedArousalPreview,
} from "./preview/arousal-fixture.js";

let database: Awaited<ReturnType<typeof createTestingDatabase>>;
const app = Fastify();
const base =
  "/api/v1/inspection/modules/agent.attention.arousal/surfaces/arousal";
const headers = { authorization: "Bearer arousal-test" };

beforeAll(async () => {
  database = await createTestingDatabase();
  await database.prepareSchema();
  await seedArousalPreview(database);
  registerInspectionRoutes(
    app,
    createInspectionService({
      ledger: database.information,
      modules: () => [arousalPreviewModule],
      secrets: { token: "arousal-known-secret" },
    }),
    async (request, reply) => {
      if (request.headers.authorization !== headers.authorization)
        return reply.code(401).send({ error: { code: "unauthorized" } });
    },
  );
  await app.ready();
}, 15_000);

afterAll(async () => {
  await app.close();
  await database?.close();
});

const get = (suffix = "") =>
  app.inject({ method: "GET", url: base + suffix, headers });

it("serves strict wake-state observation records without body or score fields", async () => {
  expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const page = response.json().data;
  expect(page.items).toHaveLength(8);
  expect(page.items[0]).toMatchObject({
    entityId: "demo-arousal-direct-notification",
    status: "observe",
  });
  const serialized = JSON.stringify(page);
  expect(serialized).not.toContain('"text"');
  expect(serialized).not.toContain('"score"');
  expect(serialized).not.toContain("arousal-known-secret");
});

it("filters results, searches trigger facts and paginates with bound cursors", async () => {
  const first = (await get("?status=observe&limit=1")).json().data;
  expect(first.items).toHaveLength(1);
  expect(first.items[0].status).toBe("observe");
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = (
    await get(
      `?status=observe&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    )
  ).json().data;
  expect(second.items[0].entityId).not.toBe(first.items[0].entityId);
  expect((await get("?q=periodic-recheck")).json().data.items).toHaveLength(1);
  const deferred = (await get("?status=defer")).json().data.items;
  expect(deferred).toHaveLength(1);
  expect(deferred[0].entityId).toBe("demo-arousal-ordinary-defer");
  expect((await get("?q=does-not-exist")).json().data.items).toEqual([]);
  expect((await get("?status=ignore")).statusCode).toBe(400);
});

it("returns state, candidate and Focus relationships while keeping missing Focus empty", async () => {
  const focused = (await get("/entities/demo-arousal-focus-active")).json()
    .data;
  expect(
    focused.sections.find((section: any) => section.id === "arousal-state")
      .items,
  ).toHaveLength(1);
  expect(
    focused.sections.find((section: any) => section.id === "candidate").items,
  ).toHaveLength(1);
  expect(
    focused.sections.find((section: any) => section.id === "focus").items,
  ).toHaveLength(1);
  const missing = (
    await get("/entities/demo-arousal-focus-state-missing")
  ).json().data;
  expect(
    missing.sections.find((section: any) => section.id === "focus").items,
  ).toEqual([]);
  expect(missing.entity.fields).toContainEqual({
    path: "focusState",
    label: "Focus 状态",
    value: "unavailable",
  });
});

it("applies half-open time bounds", async () => {
  const response = await get(
    "?after=2026-09-22T08%3A38%3A00.000Z&before=2026-09-22T08%3A42%3A00.000Z",
  );
  expect(response.statusCode).toBe(200);
  expect(response.json().data.items.map((item: any) => item.entityId)).toEqual([
    "demo-arousal-focus-active",
    "demo-arousal-passive-awake",
  ]);
});
