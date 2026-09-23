/**
 * 测试配置分别声明 inboundAllowlist/outboundAllowlist，保持与严格 Profile 或 Runtime 出站策略契约一致。
 * 功能概述：验证开发者 API 在真实 PGlite 账本上的认证、脱敏、游标分页、详情和有界 Flow。
 * 主要职责：fixture 创建两个独立 context 与跨 context 引用；通过 Fastify inject 检查
 * 无认证先拒绝、同时间分页不丢消息、过滤绑定、完整 Prompt 保留及秘密移除、只读与错误隔离。
 * 注意力观察只投影唤醒状态、非语义信号、水位、未读数量和 Focus 快照，不读取正文。
 * 代码库关系：Runtime 业务装配统一来自 @kaguya/composition；组合 app.ts、inspection.ts、真实 Runtime Manifest 和 database/testing；
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
import { createMessageComposition } from "@kaguya/composition";
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
  inboundAllowlist: [],
  outboundAllowlist: [],
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
      ...createMessageComposition(undefined, {
        moduleConfigs: createFirstPartyModuleConfigDefaults("test"),
      }),
    });
    await runtime.start();
    const modules = runtime.inspectModules();
    await runtime.close();
    const inspection = createInspectionService({
      ledger: database.information,
      database,
      modules: () => modules,
      secrets: { gatewayToken: token, apiKey: "provider-secret-value" },
      now: () => new Date(time),
    });
    app = await createHttpApplication({ config, inspection });
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
    const identityTime = time;
    const appendIdentity = async (
      informationId: string,
      kind: string,
      payload: InformationAtom["payload"],
    ) =>
      database.information.append(
        freezeInformationAtom({
          informationId,
          kind,
          occurredAt: identityTime,
          source: "module:identity.default",
          payload,
          references: [],
        }),
        [],
      );
    await appendIdentity("person-ada", "agent.person.entity", {
      accountId: "10001",
    });
    await appendIdentity("account-ada", "agent.platform.account.entity", {
      platform: "qq",
      adapterId: "napcat",
      accountId: "10001",
    });
    await appendIdentity("observed-ada", "agent.person.observed", {
      accountId: "10001",
      nickname: "Ada",
      card: "Ada · 研究组",
      observedAt: identityTime,
    });
    await appendIdentity("scope-ada", "agent.chat.scope.entity", {
      platform: "qq",
      adapterId: "napcat",
      destination: { kind: "group", id: "20002" },
      scopeMode: "canonical",
    });
    await appendIdentity("resolution-ada", "agent.person.resolution", {
      status: "complete",
      scopeMode: "canonical",
      platform: "qq",
      adapterId: "napcat",
      scopeInformationId: "scope-ada",
      accountInformationId: "account-ada",
      personInformationId: "person-ada",
    });
    await appendIdentity(
      "identity-completed-ada",
      "agent.person.context.completed",
      {
        status: "complete",
        scopeMode: "canonical",
        platform: "qq",
        adapterId: "napcat",
        scopeInformationId: "scope-ada",
        accountInformationId: "account-ada",
        personInformationId: "person-ada",
      },
    );
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
    const composer = modules.find(
      (m: { definitionId: string }) =>
        m.definitionId === "agent.message-composer",
    );
    expect(composer.bindings[0].instanceId).toBe("message-composer.default");
    expect(composer.promptRenderers.length).toBeGreaterThan(0);
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
  it("shows non-semantic observations, filters by registered view and binds pagination to it", async () => {
    for (const [id, source, outcome, signal] of [
      ["gate-a", "module:attention-arousal.default", "defer", "passive"],
      ["gate-b", "module:historical-gate", "observe", "recheck"],
    ] as const) {
      await database.information.append(
        freezeInformationAtom({
          informationId: id,
          kind: "agent.attention.arousal.completed",
          occurredAt: time,
          source,
          payload: {
            outcome,
            arousalState: outcome === "observe" ? "awake" : "asleep",
            arousalStateInformationId: id + "-state",
            wakeSignal: outcome === "observe",
            candidateInformationId: id + "-candidate",
            scopeKey: "qq:napcat:group:20002",
            unreadThroughInformationId: id + "-upper",
            unreadCount: outcome === "observe" ? 5 : 2,
            signals: [signal],
            focusState: "inactive",
            reasonCodes: [
              outcome === "observe" ? "periodic-recheck" : "arousal-asleep",
            ],
            policyVersion: "attention-observation.v1",
          },
          references: [],
        }),
        [],
      );
    }
    const query =
      "atoms?definitionId=agent.attention.arousal&view=gates&limit=1";
    const response = await get(query);
    expect(response.statusCode).toBe(200);
    const first = response.json().data;
    expect(first.items[0].informationId).toBe("gate-b");
    expect(first.items[0].presentation.fields).toContainEqual({
      label: "未读数量",
      value: 5,
    });
    expect(first.items[0].presentation.fields).toContainEqual({
      label: "策略版本",
      value: "attention-observation.v1",
    });
    expect(response.body).not.toContain("正文");
    const second = (
      await get(query + "&cursor=" + encodeURIComponent(first.nextCursor))
    ).json().data;
    expect(second.items[0].informationId).toBe("gate-a");
    expect(second.nextCursor).toBeNull();
    expect(
      (await get(query + "&source=module:attention-arousal.default")).json()
        .data.items[0].informationId,
    ).toBe("gate-a");
    expect((await get(query + "&source=module:other")).statusCode).toBe(400);
    expect((await get(query + "&kind=core.memory.text")).statusCode).toBe(400);
    expect(
      (
        await get(
          "atoms?definitionId=agent.expression&view=library&cursor=" +
            encodeURIComponent(first.nextCursor),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await get("atoms?definitionId=agent.expression&view=missing"))
        .statusCode,
    ).toBe(404);
    expect(
      (await get("flows?definitionId=agent.expression&view=library"))
        .statusCode,
    ).toBe(400);
    expect(
      (await get(query + "&after=2026-09-12T00:00:00Z")).json().data.items,
    ).toEqual([]);
    const stored = await database.information.get("gate-a");
    expect(stored!.payload).not.toHaveProperty("text");
  });
  it("reads real shared Memory documents while inactive and distinguishes missing vector storage", async () => {
    const address = {
      platform: "web",
      adapterId: "web",
      platformMessageId: "test",
      accountId: "user",
      destination: { kind: "web" as const },
    };
    for (const source of ["a", "b"])
      await database.memory.put({
        sourceInformationId: source,
        sourceKind: "core.message.inbound.text",
        content: "已存储原文 " + token,
        occurredAt: time,
        address: { ...address, platformMessageId: source },
      });
    const path = "modules/agent.memory.writeback/storage?limit=1";
    expect((await get(path, false)).statusCode).toBe(401);
    const response = await get(path);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain(token);
    const first = response.json().data;
    expect(first.items).toHaveLength(1);
    expect(first.items[0].fields[0].value).toContain("已存储原文");
    const second = (
      await get(path + "&cursor=" + encodeURIComponent(first.nextCursor))
    ).json().data;
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.nextCursor).toBeNull();
    expect(
      (await get("modules/agent.memory.index/storage")).json().data.available,
    ).toBe(false);
    expect(
      (await get("modules/agent.memory.index/storage?cursor=invalid"))
        .statusCode,
    ).toBe(400);
    expect((await get(path.replace("limit=1", "limit=999"))).statusCode).toBe(
      400,
    );
    expect((await get("modules/agent.expression/storage")).statusCode).toBe(
      404,
    );
    expect((await database.memory.getBySource("a"))!.content).toContain(token);
  });
  it("projects the identity surface with bounded search, filters, summary and related detail", async () => {
    const path = "modules/core.identity.normalize/surfaces/people";
    expect((await get(path, false)).statusCode).toBe(401);
    const response = await get(path + "?q=研究组&platform=qq&status=complete");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const page = response.json().data;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      entityId: "person-ada",
      entityKey: "10001",
      title: "Ada · 研究组",
      platform: "qq",
      status: "complete",
    });
    expect(page.summary.counts).toContainEqual({
      status: "complete",
      count: 1,
    });
    expect(page.platforms).toContain("qq");
    const detail = (await get(path + "/entities/person-ada")).json().data;
    expect(
      detail.sections.find(
        (section: { id: string }) => section.id === "observations",
      ).items[0].fields,
    ).toContainEqual({
      label: "群名片",
      value: "Ada · 研究组",
    });
    expect(
      detail.sections.find((section: { id: string }) => section.id === "scopes")
        .items[0].id,
    ).toBe("scope-ada");
    expect((await get(path + "?q=nobody")).json().data.items).toEqual([]);
    expect((await get(path + "/entities/missing")).statusCode).toBe(404);
    expect((await get(path + "?limit=51")).statusCode).toBe(400);
    expect(
      JSON.stringify(await database.information.get("person-ada")),
    ).toContain("10001");
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
