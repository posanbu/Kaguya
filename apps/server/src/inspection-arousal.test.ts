/**
 * 功能概述：在隔离 PGlite 中验证注意力门控 Surface 的状态/时间筛选、游标、冻结上下文及统一脱敏。
 * 主要职责：正式演示 fixture 提供三种结果及分项计算依据；额外构造错误 Kind、错误关系和缺字段上下文，
 * 验证不推断历史条件，评分依据的嵌套文本统一脱敏，缺省的旧记录不补算或改写。
 * 代码库关系：Fastify 注册正式 inspection.ts 路由，inspection-records.ts 负责正向引用；cap 测试直接检查有界 getMany。
 * 输入输出与副作用：写入仅限测试数据库；初始化、写入、注入请求和关闭均直接 await，无定时器或轮询。
 * beforeAll 的 15 秒与仓库 PGlite 初始化预算一致，afterAll 关闭 HTTP 服务及数据库；测试不启动 Runtime 或后台调度。
 */
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  freezeInformationAtom,
  type InformationAtom,
  type JsonObject,
} from "@kaguya/schema";
import {
  createInspectionService,
  registerInspectionRoutes,
} from "./inspection.js";
import { recordEntity, type RecordBrowser } from "./inspection-records.js";
import {
  arousalPreviewModule,
  seedArousalPreview,
} from "./preview/arousal-fixture.js";

let database: Awaited<ReturnType<typeof createTestingDatabase>>;
const app = Fastify();
const base =
  "/api/v1/inspection/modules/agent.attention.arousal/surfaces/arousal";
const headers = { authorization: "Bearer arousal-test" };
const browser = arousalPreviewModule.inspection!.surface!.components.find(
  (component): component is RecordBrowser =>
    component.type === "record-browser",
)!;
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
const append = async (atom: InformationAtom) =>
  database.information.append(
    freezeInformationAtom(atom),
    [...new Set(atom.references.map(({ relation }) => relation))].map(
      (relation) => ({ relation, required: false, multiple: true }),
    ),
  );

it("authenticates read-only gate routes and preserves stable field paths and persisted root outcomes", async () => {
  expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: "POST", url: base, headers })).statusCode,
  ).toBe(404);
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const page = response.json().data;
  expect(page.items).toHaveLength(15);
  expect(page.items[0]).toMatchObject({
    entityId: "demo-arousal-muted-high-score",
    status: "ignore",
  });
  expect(page.items[0].fields).toContainEqual({
    path: "outcome",
    label: "结果",
    value: "ignore",
  });
  expect(page.items[0].fields).toContainEqual(
    expect.objectContaining({
      path: "source",
      value: expect.objectContaining({
        destination: { kind: "group", groupId: "demo-research" },
      }),
    }),
  );
  expect(
    (await get("/entities/demo-arousal-muted-high-score-context")).statusCode,
  ).toBe(404);
});

it("combines declared outcomes, conversation search and half-open time filters and binds all filters into cursors", async () => {
  const query = new URLSearchParams({
    status: "attend",
    limit: "1",
    after: "2026-09-19T07:10:00.000Z",
    before: "2026-09-19T07:42:00.000Z",
  });
  const first = (await get(`?${query}`)).json().data;
  expect(first.items).toHaveLength(1);
  expect(first.items[0].status).toBe("attend");
  expect(first.nextCursor).toEqual(expect.any(String));
  const nextQuery = new URLSearchParams(query);
  nextQuery.set("cursor", first.nextCursor);
  const second = (await get(`?${nextQuery}`)).json().data;
  expect(second.items[0].status).toBe("attend");
  expect(second.items[0].entityId).not.toBe(first.items[0].entityId);
  for (const [field, value] of [
    ["status", "ignore"],
    ["q", "其他"],
    ["after", "2026-09-19T07:20:00.000Z"],
    ["before", "2026-09-19T07:40:00.000Z"],
  ]) {
    const changed = new URLSearchParams(nextQuery);
    changed.set(field!, value!);
    expect((await get(`?${changed}`)).statusCode).toBe(400);
  }
  const range = new URLSearchParams({
    q: "demo-research",
    after: "2026-09-19T07:34:00.000Z",
    before: "2026-09-19T07:40:00.000Z",
  });
  expect(
    (await get(`?${range}`))
      .json()
      .data.items.map((item: { entityId: string }) => item.entityId),
  ).toEqual([
    "demo-arousal-mention-low-score",
    "demo-arousal-score-threshold-met",
    "demo-arousal-score-below-threshold",
  ]);
  expect((await get("?q=demo-classmate")).json().data.items).toHaveLength(2);
  for (const invalid of [
    "status=unknown",
    "after=not-a-date",
    "before=2026-09-31T00:00:00Z",
    "after=2026-09-19T08:00:00Z&before=2026-09-19T07:00:00Z",
    "after=2026-09-19T08:00:00Z&before=2026-09-19T08:00:00Z",
    "platform=qq",
    "limit=51",
  ])
    expect((await get(`?${invalid}`)).statusCode).toBe(400);
});

it("reads the root's forward context only and distinguishes absent fields from false", async () => {
  const detail = (await get("/entities/demo-arousal-muted-high-score")).json()
    .data;
  expect(detail.entity.status).toBe("ignore");
  expect(detail.sections[0]).toMatchObject({ id: "context", truncated: false });
  expect(detail.sections[0].items).toHaveLength(1);
  expect(detail.sections[0].items[0]).toMatchObject({
    id: "demo-arousal-muted-high-score-context",
  });
  expect(detail.sections[0].items[0].fields).toContainEqual({
    path: "muted",
    label: "已静音",
    value: true,
  });
  expect(detail.sections[0].items[0].fields).toContainEqual({
    path: "repliedToSelf",
    label: "回复自己",
    value: false,
  });
  const missing = (await get("/entities/demo-arousal-context-missing")).json()
    .data;
  expect(missing.sections[0].items).toEqual([]);
  expect(missing.entity.fields).toContainEqual({
    path: "turnContextInformationId",
    label: "冻结上下文",
    value: "demo-arousal-context-missing-context",
  });
});

it("filters forward kinds before the section limit, rejects other edges, redacts nested facts and never fills historical flags", async () => {
  const time = "2026-09-19T07:42:00.000Z";
  const wrongKind = {
    informationId: "gate-wrong-kind",
    kind: "core.message.inbound.text",
    source: "test:arousal",
    occurredAt: time,
    payload: { text: "must-not-leak-wrong-kind" },
    references: [],
  };
  const context = {
    informationId: "gate-partial-context",
    kind: "agent.turn.context.completed",
    source: "test:arousal",
    occurredAt: time,
    payload: {
      safe: false,
      inputs: [{ text: "arousal-known-secret", apiKey: "hidden-input-key" }],
      internal: "must-not-leak-private-field",
    },
    references: [],
  };
  await append(wrongKind);
  await append(context);
  await append({ ...context, informationId: "gate-extra-context" });
  await append({
    ...context,
    informationId: "gate-wrong-edge",
    payload: { inputs: [{ text: "must-not-leak-wrong-edge" }] },
  });
  await append({
    informationId: "gate-safety",
    kind: browser.recordKind,
    source: "test:arousal",
    occurredAt: time,
    payload: {
      text: "arousal-known-secret",
      outcome: "defer",
      source: {
        destination: { kind: "group", groupId: "test" },
        apiKey: "hidden-source-key",
      },
    },
    references: [
      { relation: "core:uses-context", informationId: wrongKind.informationId },
      { relation: "core:caused-by", informationId: "gate-wrong-edge" },
      { relation: "core:uses-context", informationId: context.informationId },
      { relation: "core:uses-context", informationId: "gate-extra-context" },
    ],
  });
  const before = await database.information.inspectPage({ limit: 100 });
  const response = await get("/entities/gate-safety");
  expect(response.statusCode).toBe(200);
  for (const hidden of [
    "arousal-known-secret",
    "hidden-input-key",
    "hidden-source-key",
    "must-not-leak-wrong-kind",
    "must-not-leak-wrong-edge",
    "must-not-leak-private-field",
  ])
    expect(response.body).not.toContain(hidden);
  const detail = response.json().data;
  expect(detail.entity.status).toBe("defer");
  expect(detail.sections[0].truncated).toBe(true);
  expect(detail.sections[0].items).toHaveLength(1);
  expect(detail.sections[0].items[0].id).toBe(context.informationId);
  expect(detail.sections[0].items[0].fields).toContainEqual({
    path: "safe",
    label: "安全检查通过",
    value: false,
  });
  expect(
    detail.sections[0].items[0].fields.map(
      (field: { path: string }) => field.path,
    ),
  ).toEqual(["inputs", "safe"]);
  expect(await database.information.inspectPage({ limit: 100 })).toEqual(
    before,
  );
});

it("caps forward candidate reads while reporting references beyond the bound", async () => {
  const refs = Array.from({ length: 101 }, (_, index) => ({
    relation: "core:uses-context",
    informationId: `bounded-${index}`,
  }));
  const root = freezeInformationAtom({
    informationId: "bounded-root",
    kind: browser.recordKind,
    source: "test:arousal",
    occurredAt: "2026-09-19T07:00:00Z",
    payload: { text: "bounded", outcome: "ignore" },
    references: refs,
  });
  const getMany = vi.fn(async (ids: readonly string[]) =>
    ids.map((informationId) =>
      freezeInformationAtom({
        informationId,
        kind: "agent.turn.context.completed",
        source: "test:arousal",
        occurredAt: root.occurredAt,
        payload: { safe: true },
        references: [],
      }),
    ),
  );
  const result = await recordEntity(
    { get: async () => undefined, getMany, inspectPage: async () => [] },
    browser,
    root,
  );
  expect(getMany).toHaveBeenCalledTimes(1);
  expect(getMany.mock.calls[0]![0]).toHaveLength(100);
  expect(result.sections[0]!.items).toHaveLength(1);
  expect(result.sections[0]!.truncated).toBe(true);
});

it("projects the persisted score evidence on both history and detail without adding evidence to legacy records", async () => {
  const id = "demo-arousal-score-threshold-met";
  const atom = (await database.information.get(id))!;
  expect(atom.payload.scoreEvidence).toMatchObject({
    version: 1,
    parts: expect.arrayContaining([
      expect.objectContaining({ id: "relevance" }),
      expect.objectContaining({ id: "content" }),
      expect.objectContaining({ id: "pressure" }),
      expect.objectContaining({ id: "recentPresencePenalty" }),
    ]),
  });
  const expected = {
    path: "scoreEvidence",
    label: "评分计算依据",
    value: atom.payload.scoreEvidence,
  };
  const page = (await get("?q=能不能帮我看看这个要怎么做")).json().data;
  expect(page.items).toHaveLength(1);
  expect(page.items[0].entityId).toBe(id);
  expect(page.items[0].fields).toContainEqual(expected);
  const detail = (await get(`/entities/${id}`)).json().data;
  expect(detail.entity.fields).toContainEqual(expected);

  const legacyId = "demo-arousal-legacy-unknown-reason";
  const legacyBefore = await database.information.get(legacyId);
  expect(legacyBefore!.payload).not.toHaveProperty("scoreEvidence");
  const legacy = (await get(`/entities/${legacyId}`)).json().data;
  expect(legacy.entity.fields).not.toContainEqual(
    expect.objectContaining({ path: "scoreEvidence" }),
  );
  expect(legacy.entity.fields).toContainEqual({
    path: "reasonCodes",
    label: "原因",
    value: ["legacy-policy-evidence"],
  });
  expect(await database.information.get(legacyId)).toEqual(legacyBefore);
});

it("redacts nested score evidence labels, facts, steps and formulas while preserving recorded numeric contributions", async () => {
  const source = (await database.information.get(
    "demo-arousal-score-threshold-met",
  ))!;
  const evidence = source.payload.scoreEvidence as JsonObject;
  const parts = evidence.parts as JsonObject[];
  const recorded = {
    ...evidence,
    parts: parts.map((part) =>
      part.id === "content"
        ? {
            ...part,
            facts: [
              { label: "arousal-known-secret", value: "arousal-known-secret" },
            ],
            steps: [{ label: "arousal-known-secret", delta: 35 }],
            formula: "arousal-known-secret",
          }
        : part,
    ),
  };
  await append({
    informationId: "gate-evidence-redaction",
    kind: browser.recordKind,
    source: "test:arousal",
    occurredAt: "2026-09-19T07:00:00.000Z",
    payload: {
      ...source.payload,
      text: "评分依据脱敏验证",
      scoreEvidence: recorded,
    },
    references: [],
  });
  const before = await database.information.get("gate-evidence-redaction");
  for (const suffix of [
    "?q=评分依据脱敏验证",
    "/entities/gate-evidence-redaction",
  ]) {
    const response = await get(suffix);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("arousal-known-secret");
    const data = response.json().data;
    const fields = suffix.startsWith("?")
      ? data.items[0].fields
      : data.entity.fields;
    const projected = fields.find(
      (field: { path: string }) => field.path === "scoreEvidence",
    );
    expect(projected).toBeDefined();
    expect(projected.value.parts).toContainEqual(
      expect.objectContaining({
        id: "content",
        value: 35,
        facts: [{ label: "[REDACTED]", value: "[REDACTED]" }],
        steps: [{ label: "[REDACTED]", delta: 35 }],
        formula: "[REDACTED]",
      }),
    );
  }
  expect(await database.information.get("gate-evidence-redaction")).toEqual(
    before,
  );
});
