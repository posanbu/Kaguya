/**
 * 功能概述：验证开发者 API 在真实 PGlite 账本上的认证、脱敏、游标分页、详情和有界 Flow。
 * 主要职责：fixture 创建两个独立 context 与跨 context 引用；通过 Fastify inject 检查
 * 无认证先拒绝、同时间分页不丢消息、过滤绑定、完整 Prompt 保留及秘密移除、只读与错误隔离。
 * 代码库关系：组合 app.ts、inspection.ts、真实 Runtime Manifest 和 database/testing；
 * 不调用外部模型或真实网络，每次测试关闭 Fastify、Runtime 与内存数据库。
 * 输入输出与副作用：仅隔离测试数据库 I/O；对比请求前后原子数量确保检查接口不追加事实。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import { KaguyaRuntime } from "@kaguya/runtime";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { freezeInformationAtom, type InformationAtom } from "@kaguya/schema";
import { createHttpApplication } from "./app.js";
import { createInspectionService } from "./inspection.js";
import { createReplyComposition } from "./runtime-composition.js";
import type { ServerConfig } from "./config.js";

const token = "inspection-gateway-secret";
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken: token,
  corsOrigins: [],
  trustProxy: false,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60000,
  databaseUrl: "postgresql://localhost/test",
  configRoot: "/tmp/inspection-test",
  development: false,
  webDistPath: "/tmp/web",
  logLevel: "silent",
  logFormat: "json",
  gatewayAllowlist: [],
  napcat: { enabled: false, adapterId: "test", reconnectMs: 3000 },
};
const headers = { authorization: `Bearer ${token}` };
const time = "2026-09-11T01:00:00.000Z";

describe("developer inspection", () => {
  let database: Awaited<ReturnType<typeof createTestingDatabase>>;
  let app: Awaited<ReturnType<typeof createHttpApplication>>;
  let runtime: KaguyaRuntime;
  let original: string;
  beforeAll(async () => {
    database = await createTestingDatabase();
    runtime = new KaguyaRuntime({
      database,
      ...createReplyComposition(undefined, {
        moduleConfigs: createFirstPartyModuleConfigDefaults("test"),
      }),
    });
    await runtime.start();
    const modules = runtime.inspectModules();
    await runtime.close();
    const service = createInspectionService({
      ledger: database.information,
      modules: () => modules,
      secrets: { gatewayToken: token, apiKey: "provider-secret-value" },
    });
    app = await createHttpApplication({ config, inspection: service });
    const append = async (
      informationId: string,
      kind: string,
      context?: string,
      extra: InformationAtom["references"] = [],
    ) => {
      const references = context
        ? [{ relation: "core:context", informationId: context }, ...extra]
        : extra;
      await database.information.append(
        freezeInformationAtom({
          informationId,
          kind,
          occurredAt: time,
          source: "test:inspection",
          payload: {
            text: `Full message ${informationId}`,
            prompt: {
              text: `Complete compiled prompt ${token} provider-secret-value Bearer inline-token`,
              templates: [{ content: "keep this template" }],
            },
            apiKey: "unknown-key",
          },
          references,
        }),
        [...new Set(references.map((r) => r.relation))].map((relation) => ({
          relation,
          required: false,
          multiple: true,
        })),
      );
    };
    await append("ctx-a", "core.runtime.context");
    await append("ctx-b", "core.runtime.context");
    await append("outside", "core.message.inbound.text", "ctx-b");
    await append("a", "core.message.inbound.text", "ctx-a");
    await append("b", "core.message.inbound.text", "ctx-a", [
      { relation: "core:caused-by", informationId: "a" },
      { relation: "core:uses-context", informationId: "outside" },
    ]);
    await append("c", "core.message.inbound.text", "ctx-a");
    original = JSON.stringify(await database.information.get("b"));
  });
  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await database?.close();
  });
  const get = (path: string, auth = true) =>
    app.inject({
      method: "GET",
      url: `/api/v1/inspection/${path}`,
      ...(auth ? { headers } : {}),
    });

  it("authenticates every endpoint before validating and disables response caching", async () => {
    for (const path of [
      "modules",
      "atoms?limit=bad",
      "atoms/missing",
      "flows",
      "flows/missing?limit=bad",
    ]) {
      const response = await get(path, false);
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/inspection/atoms",
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("projects actual Runtime manifests including activation, kinds and prompt metadata", async () => {
    const response = await get("modules");
    expect(response.statusCode).toBe(200);
    const modules = response.json().data.modules;
    expect(modules.length).toBeGreaterThan(0);
    const reply = modules.find(
      (m: { definitionId: string }) => m.definitionId === "demo.reply.llm",
    );
    expect(reply.bindings[0].instanceId).toBe("reply.default");
    expect(reply.promptRenderers.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('"settings":');
    expect(response.body).not.toContain(token);
  });
  it("paginates tied timestamps without duplicates, supports filters and rejects mismatched cursors", async () => {
    const query =
      "atoms?kind=core.message.inbound.text&source=test:inspection&limit=2";
    const first = (await get(query)).json().data;
    expect(
      first.items.map((a: { informationId: string }) => a.informationId),
    ).toEqual(["outside", "c"]);
    expect(first.truncated).toBe(true);
    const second = (
      await get(`${query}&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json().data;
    expect(
      second.items.map((a: { informationId: string }) => a.informationId),
    ).toEqual(["b", "a"]);
    expect(second.nextCursor).toBeNull();
    expect((await get(`atoms?cursor=${first.nextCursor}`)).statusCode).toBe(
      400,
    );
    expect((await get("atoms?cursor=invalid")).statusCode).toBe(400);
    expect((await get("atoms?limit=101")).statusCode).toBe(400);
    expect(
      (
        await get(
          "atoms?after=2026-09-12T00:00:00Z&before=2026-09-11T00:00:00Z",
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await get("atoms?after=2026-09-12T00:00:00Z")).json().data.items,
    ).toEqual([]);
    expect(
      (
        await get("atoms?before=2026-09-11T01:00:00Z&source=test:inspection")
      ).json().data.items,
    ).toEqual([]);
    expect((await get("atoms?kind=unknown.kind")).json().data.items).toEqual(
      [],
    );
  });
  it("returns complete redacted messages and both directions without mutating the ledger", async () => {
    const response = await get("atoms/b");
    expect(response.statusCode).toBe(200);
    for (const secret of [
      token,
      "provider-secret-value",
      "inline-token",
      "unknown-key",
    ])
      expect(response.body).not.toContain(secret);
    expect(response.body).toContain("Complete compiled prompt");
    expect(response.body).toContain("keep this template");
    expect(response.json().data.atom.references).toHaveLength(3);
    expect(
      (await get("atoms/a"))
        .json()
        .data.referencedBy.map(
          (a: { informationId: string }) => a.informationId,
        ),
    ).toContain("b");
    expect(JSON.stringify(await database.information.get("b"))).toBe(original);
    expect((await get("atoms/missing")).statusCode).toBe(404);
  });
  it("keeps flows within one context, preserves reference edges and reports truncation", async () => {
    const response = await get("flows/ctx-a");
    expect(response.statusCode).toBe(200);
    const flow = response.json().data;
    expect(
      new Set(
        flow.nodes.map((a: { informationId: string }) => a.informationId),
      ),
    ).toEqual(new Set(["ctx-a", "a", "b", "c"]));
    expect(flow.edges).toContainEqual({
      from: "b",
      to: "a",
      relation: "core:caused-by",
    });
    expect(flow.externalReferences).toBe(1);
    expect(flow.truncated).toBe(false);
    const limited = (await get("flows/ctx-a?limit=2")).json().data;
    expect(limited.nodes).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect((await get("flows/a")).statusCode).toBe(404);
    expect((await get("flows/ctx-a?limit=501")).statusCode).toBe(400);
    const contexts = (await get("flows?source=test:inspection")).json().data
      .items;
    expect(
      contexts.every(
        (a: { kind: string }) => a.kind === "core.runtime.context",
      ),
    ).toBe(true);
  });
  it("returns safe unavailable and database error responses", async () => {
    const unavailable = await createHttpApplication({ config });
    try {
      expect(
        (
          await unavailable.inject({
            method: "GET",
            url: "/api/v1/inspection/modules",
            headers,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await unavailable.close();
    }
    const failing = await createHttpApplication({
      config,
      inspection: createInspectionService({
        modules: () => [],
        secrets: {},
        ledger: {
          get: async () => {
            throw new Error("postgresql://secret:password@host/db");
          },
          inspectPage: async () => [],
        },
      }),
    });
    try {
      const response = await failing.inject({
        method: "GET",
        url: "/api/v1/inspection/atoms/a",
        headers,
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("password");
    } finally {
      await failing.close();
    }
  });
});

it("caps both reference directions and flow edges without hiding truncation", async () => {
  const base: InformationAtom = {
    informationId: "ctx",
    kind: "core.runtime.context",
    source: "test:limits",
    occurredAt: time,
    payload: {},
    references: [],
  };
  const child: InformationAtom = {
    ...base,
    informationId: "child",
    kind: "core.message.inbound.text",
    references: Array.from({ length: 2001 }, (_, i) => ({
      relation: `test:relation-${i}`,
      informationId: "ctx",
    })),
  };
  const service = createInspectionService({
    secrets: {},
    modules: () => [],
    ledger: {
      get: async (id) => (id === "ctx" ? base : child),
      inspectPage: async (query) =>
        query.limit === 101
          ? Array.from({ length: 101 }, (_, i) => ({
              ...child,
              informationId: `child-${i}`,
            }))
          : [child],
    },
  });
  const detail = await service.detail("child");
  expect(detail.atom.references).toHaveLength(100);
  expect(detail.referencedBy).toHaveLength(100);
  expect(detail.referencesTruncated).toBe(true);
  expect(detail.reverseReferencesTruncated).toBe(true);
  const flow = await service.flow("ctx", {});
  expect(flow.edges).toHaveLength(2000);
  expect(flow.truncated).toBe(true);
});
