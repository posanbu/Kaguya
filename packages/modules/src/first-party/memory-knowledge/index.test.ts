/**
 * 功能概述：用真实 Core、ModuleHost 和 PGlite 验证事件 Wiki 原型的后台集成。
 * fixture 可先仅启用身份模块再启用知识模块，覆盖无订阅历史回填、多人归属、昵称变化和关闭重开。
 * 使用数据库实际修订与账本终态断言，不把虚拟 provider 或页面文字视为语义质量证据。
 * 单次持久化等待为 8 秒；三次身份/页面串行收敛最多六段等待，普通用例预留 60 秒总预算。
 * 历史分页单独给 30 秒处理 51 条来源；测试仅写临时数据库，结束时关闭可靠消费者和连接，不连接用户服务。
 */
import { randomUUID } from "node:crypto";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import { memoryKnowledgeCapability } from "@kaguya/memory";
import { z } from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityModule } from "../identity/index.js";
import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";
import {
  memoryKnowledgeModule,
  memoryKnowledgeBootstrapCapability,
  memoryKnowledgeBackfillInformationKind,
  memoryKnowledgeMaintenanceInformationKind,
  memoryKnowledgeMutationInformationKind,
  memoryEventSubmittedInformationKind,
  memoryWikiUpdatedInformationKind,
} from "./index.js";

const contextKind = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "上下文",
  description: "集成测试",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
// 同一可靠投递路径统一使用 Planner/PGlite 的 8 秒有界条件等待，不改变业务重试或截止点。
const DURABLE_WAIT = { timeout: 8000, interval: 20 } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
});
async function fixture(knowledgeEnabled = true) {
  const database = await createTestingDatabase();
  cleanups.push(() => database.close());
  await database.prepareSchema();
  await database.prepareMemoryKnowledgeSchema();
  const catalog = defineInformationModuleCatalog(
    identityModule,
    memoryKnowledgeModule,
  );
  function createRegistry() {
    const registry = new InformationKindRegistry();
    registry.registerBuiltin(contextKind);
    for (const definition of catalogInformationKinds(catalog)) {
      if (definition.kind.startsWith("core."))
        registry.registerBuiltin(definition);
      else registry.register(definition);
    }
    return registry;
  }
  let core = new InformationCore({
    registry: createRegistry(),
    store: database.information,
    nextInformationId: randomUUID,
  });
  cleanups.push(() => core.close());
  await core.start();
  const bootstrap = async () => {
    await core.register(memoryKnowledgeBackfillInformationKind, {
      source: "test:bootstrap",
      occurredAt: new Date().toISOString(),
      payload: { afterInformationId: null },
      references: [],
    });
  };
  const maintenance = async () => {
    await core.register(memoryKnowledgeMaintenanceInformationKind, {
      source: "test:bootstrap",
      occurredAt: new Date().toISOString(),
      payload: { after: null },
      references: [],
    });
  };
  let host: ModuleHost | undefined;
  cleanups.push(async () => {
    await host?.stop();
  });
  async function start(enabled = true) {
    host = new ModuleHost({
      core,
      catalog,
      capabilities: [
        { capability: memoryKnowledgeCapability, value: database.knowledge },
        {
          capability: memoryKnowledgeBootstrapCapability,
          value: {
            requestBackfill: async () => {
              await bootstrap();
              await maintenance();
            },
            requestMaintenance: maintenance,
          },
        },
      ],
    });
    await host.start([
      {
        instanceId: "identity",
        definitionId: "memory.identity",
        settings: {},
      },
      ...(enabled
        ? [
            {
              instanceId: "knowledge",
              definitionId: "memory.knowledge",
              settings: {},
            },
          ]
        : []),
    ]);
  }
  await start(knowledgeEnabled);
  async function submit(
    senderId: string,
    text: string,
    nickname = senderId,
    groupId = "group",
  ) {
    const context = await core.register(contextKind, {
      source: "test:context",
      occurredAt: new Date().toISOString(),
      payload: {},
      references: [],
    });
    const atom = await core.register(inboundTextInformationKind, {
      source: "test:inbound",
      occurredAt: new Date().toISOString(),
      payload: {
        text,
        source: {
          platform: "qq",
          adapterId: "qq-main",
          senderId,
          platformMessageId: randomUUID(),
          destination: { kind: "group", groupId },
          sender: { userId: senderId, nickname },
        },
      },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    const identity = await vi.waitFor(async () => {
      const rows = await database.information.find({
        kinds: [personContextCompletedInformationKind.kind],
        limit: 100,
      });
      const found = rows.find((a) =>
        a.references.some(
          (r) =>
            r.relation === "core:status-of" &&
            r.informationId === atom.informationId,
        ),
      );
      expect(found).toBeDefined();
      return found!;
    }, DURABLE_WAIT);
    return {
      atom,
      scopeInformationId: identity.payload.scopeInformationId as string,
      entityInformationId: identity.payload.personInformationId as string,
    };
  }
  async function settled(
    scopeInformationId: string,
    entityInformationId: string,
    text: string,
  ) {
    return vi.waitFor(async () => {
      const page = await database.knowledge.readWikiPage({
        scopeInformationId,
        entityInformationId,
      });
      expect(
        page?.dirty,
        !page
          ? JSON.stringify(
              await database.information.find({
                kinds: [
                  "memory.knowledge.backfill.requested",
                  "memory.knowledge.event.submitted",
                  "core.execution.exhausted",
                ],
                limit: 20,
              }),
            )
          : undefined,
      ).toBe(false);
      expect(JSON.stringify(page?.latestRevision)).toContain(text);
      const revisions = await database.information.find({
        kinds: [memoryWikiUpdatedInformationKind.kind],
        payloadContains: { scopeInformationId, entityInformationId },
        limit: 100,
      });
      expect(
        revisions.some((r) => (r.payload.text as string).includes(text)),
      ).toBe(true);
      return page!;
    }, DURABLE_WAIT);
  }
  return {
    database,
    get core() {
      return core;
    },
    submit,
    settled,
    restart: async (enabled = true) => {
      await host?.stop();
      await core.close();
      core = new InformationCore({
        registry: createRegistry(),
        store: database.information,
        nextInformationId: randomUUID,
      });
      await core.start();
      await start(enabled);
    },
  };
}

describe("durable event and Wiki projection", () => {
  it("continues past a full historical page and quarantines a permanently invalid event", async () => {
    const f = await fixture(false);
    const first = await f.submit("alice", "跨页历史 0");
    const otherScope = await f.submit(
      "bob",
      "另一个群的合法历史",
      "bob",
      "other-group",
    );
    await f.core.register(memoryEventSubmittedInformationKind, {
      source: "test:bad-producer",
      occurredAt: new Date().toISOString(),
      payload: {
        sourceInformationId: first.atom.informationId,
        scopeInformationId: otherScope.scopeInformationId,
        occurredAt: first.atom.occurredAt,
        content: "跨页历史 0",
        eventType: "message",
        actor: {
          status: "resolved",
          entityInformationId: first.entityInformationId,
        },
        subjects: [],
      },
      references: [
        { relation: "agent:source", informationId: first.atom.informationId },
        {
          relation: "agent:scope",
          informationId: otherScope.scopeInformationId,
        },
      ],
    });
    let last = first;
    for (let index = 1; index < 51; index++)
      last = await f.submit("alice", `跨页历史 ${index}`);
    await f.restart();
    await vi.waitFor(
      async () => {
        expect(
          await f.database.knowledge.getEvent(
            last.atom.informationId,
            last.scopeInformationId,
          ),
        ).toBeDefined();
        const skipped = await f.database.information.find({
          kinds: ["memory.knowledge.completed"],
          payloadContains: { status: "skipped" },
          limit: 100,
        });
        expect(skipped.length).toBeGreaterThan(0);
      },
      { timeout: 30000, interval: DURABLE_WAIT.interval },
    );
    const result = await f.database.knowledge.recall({
      scopeInformationId: first.scopeInformationId,
      occurredBefore: new Date().toISOString(),
      recordedBefore: new Date().toISOString(),
      limit: 100,
    });
    expect(result.events).toHaveLength(51);
    expect(
      await f.database.knowledge.getEvent(
        first.atom.informationId,
        otherScope.scopeInformationId,
      ),
    ).toBeUndefined();
  }, 60000);

  it("recovers a database revision committed before the worker lost its acknowledgement", async () => {
    const f = await fixture();
    const original = f.database.knowledge.writeWikiRevision.bind(
      f.database.knowledge,
    );
    let lost = false;
    const write = vi
      .spyOn(f.database.knowledge, "writeWikiRevision")
      .mockImplementation(async (input) => {
        const revision = await original(input);
        if (!lost) {
          lost = true;
          throw new Error("simulated connection lost after commit");
        }
        return revision;
      });
    const message = await f.submit("alice", "可恢复的共同经历");
    await f.settled(
      message.scopeInformationId,
      message.entityInformationId,
      "可恢复的共同经历",
    );
    const scope = await f.settled(
      message.scopeInformationId,
      message.scopeInformationId,
      "可恢复的共同经历",
    );
    expect(scope.version).toBe(1);
    expect(write.mock.calls.length).toBeGreaterThanOrEqual(3);
    write.mockRestore();
  }, 60000);

  it("rebuilds all dependent pages after a durable source revocation", async () => {
    const f = await fixture();
    const message = await f.submit("alice", "这条来源后来被撤回");
    await f.settled(
      message.scopeInformationId,
      message.entityInformationId,
      "后来被撤回",
    );
    await f.core.register(memoryKnowledgeMutationInformationKind, {
      source: "test:correction",
      occurredAt: new Date().toISOString(),
      payload: {
        operation: "revoke-source",
        input: {
          scopeInformationId: message.scopeInformationId,
          sourceInformationId: message.atom.informationId,
          reason: "错误来源",
        },
      },
      references: [
        { relation: "agent:scope", informationId: message.scopeInformationId },
        { relation: "agent:source", informationId: message.atom.informationId },
      ],
    });
    await vi.waitFor(async () => {
      for (const entityInformationId of [
        message.entityInformationId,
        message.scopeInformationId,
      ]) {
        const page = await f.database.knowledge.readWikiPage({
          scopeInformationId: message.scopeInformationId,
          entityInformationId,
        });
        expect(page?.dirty).toBe(false);
        expect(page?.version).toBeGreaterThan(1);
        expect(page?.latestRevision?.sections).toEqual([]);
      }
    }, DURABLE_WAIT);
    expect(
      await f.database.knowledge.filterAvailableSourceIds({
        sourceInformationIds: [message.atom.informationId],
      }),
    ).toEqual([]);
  }, 60000);
  it("keeps speaker identity across nickname changes and separates third-party speech", async () => {
    const f = await fixture();
    const first = await f.submit("alice", "我以前喜欢咖啡", "小月");
    await f.settled(
      first.scopeInformationId,
      first.entityInformationId,
      "我以前喜欢咖啡",
    );
    const second = await f.submit("bob", "小月说过她喜欢咖啡", "小月");
    await f.settled(
      second.scopeInformationId,
      second.entityInformationId,
      "小月说过她喜欢咖啡",
    );
    const correction = await f.submit(
      "alice",
      "那是以前，我现在不喝咖啡",
      "阿月",
    );
    expect(correction.entityInformationId).toBe(first.entityInformationId);
    expect(second.entityInformationId).not.toBe(first.entityInformationId);
    const page = await f.settled(
      first.scopeInformationId,
      first.entityInformationId,
      "我现在不喝咖啡",
    );
    const result = await f.database.knowledge.recall({
      scopeInformationId: first.scopeInformationId,
      entityInformationId: first.entityInformationId,
      occurredBefore: new Date().toISOString(),
      recordedBefore: new Date().toISOString(),
      limit: 30,
    });
    expect(result.events.map((e) => e.sourceInformationId)).toEqual(
      expect.arrayContaining([
        first.atom.informationId,
        correction.atom.informationId,
      ]),
    );
    expect(result.events.map((e) => e.sourceInformationId)).not.toContain(
      second.atom.informationId,
    );
    expect(result.claims.map((c) => c.predicate)).toEqual(
      expect.arrayContaining(["observed.nickname"]),
    );
    expect(
      result.claims.every((c) => c.predicate.startsWith("observed.")),
    ).toBe(true);
    expect(
      page.latestRevision!.sections.every(
        (s) => s.evidenceSourceInformationIds.length > 0,
      ),
    ).toBe(true);
  }, 60000);

  it("backfills pre-enable history and resumes after closing and reopening", async () => {
    const f = await fixture(false);
    const past = await f.submit("alice", "旧约定：周五讨论项目");
    expect(
      await f.database.knowledge.getEvent(
        past.atom.informationId,
        past.scopeInformationId,
      ),
    ).toBeUndefined();
    await f.restart();
    const first = await f.settled(
      past.scopeInformationId,
      past.entityInformationId,
      "周五讨论项目",
    );
    await f.restart(false);
    const paused = await f.submit("alice", "停用期间补充了时间");
    await f.restart();
    await f.settled(
      past.scopeInformationId,
      past.entityInformationId,
      "停用期间补充了时间",
    );
    const events = await f.database.knowledge.recall({
      scopeInformationId: past.scopeInformationId,
      occurredBefore: new Date().toISOString(),
      recordedBefore: new Date().toISOString(),
      limit: 100,
    });
    expect(events.events.map((e) => e.sourceInformationId).sort()).toEqual(
      [past.atom.informationId, paused.atom.informationId].sort(),
    );
    const revisions = await f.database.knowledge.listWikiRevisions({
      scopeInformationId: past.scopeInformationId,
      entityInformationId: past.entityInformationId,
      limit: 100,
    });
    expect(revisions.some((r) => r.version === first.version)).toBe(true);
  }, 60000);
});
