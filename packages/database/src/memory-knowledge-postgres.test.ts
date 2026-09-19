/**
 * 功能概述：在真实 PostgreSQL 连接池上检查知识仓储的并发与重连语义，补足 PGlite 单连接覆盖。
 * 主要职责：验证同来源并发幂等、数据库毫秒 recordedAt 冻结、Wiki CAS 单赢家，以及撤回与修订跨连接重启持久。
 * 代码库关系：使用 testing.ts 的独立 schema；postgres-cli 的测试清单在配置 KAGUYA_TEST_DATABASE_URL 时运行本文件。
 * 输入输出与副作用：测试创建临时 schema 并关闭/重开连接；finally 删除临时 schema，不打印连接串。
 */
import { describe, expect, it } from "vitest";
import {
  KnowledgeConflictError,
  type KnowledgeEventInput,
  type WikiRevisionInput,
} from "@kaguya/memory";
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import { createPostgresTestingDatabaseScope } from "./testing.js";

const connectionString = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !connectionString)
  throw new Error("KAGUYA_TEST_DATABASE_URL is required for PostgreSQL tests");
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgresMemoryKnowledgeStore (PostgreSQL)", () => {
  it("serializes duplicate source and revision races, freezes timestamps and persists revocations across connections", async () => {
    const scope = await createPostgresTestingDatabaseScope(connectionString!);
    try {
      const db = await scope.connect();
      await db.prepareSchema();
      await db.prepareMemoryKnowledgeSchema();
      await db.information.synchronizeKinds([
        "device.entity",
        "device.observation",
      ]);
      await db.information.append(
        freezeInformationAtom({
          informationId: informationIdSchema.parse("device"),
          kind: "device.entity",
          occurredAt: "2026-01-01T00:00:00.000Z",
          source: "device",
          payload: {},
          references: [],
        }),
        [],
      );
      await db.information.append(
        freezeInformationAtom({
          informationId: informationIdSchema.parse("reading"),
          kind: "device.observation",
          occurredAt: "2026-01-02T00:00:00.000Z",
          source: "device",
          payload: { temperature: 20 },
          references: [
            {
              relation: "agent:scope",
              informationId: informationIdSchema.parse("device"),
            },
          ],
        }),
        [{ relation: "agent:scope", required: true, multiple: false }],
      );
      const input: KnowledgeEventInput = {
        sourceInformationId: "reading",
        scopeInformationId: "device",
        occurredAt: "2026-01-02T00:00:00.000Z",
        content: "Temperature is 20 degrees",
        eventType: "temperature",
        actor: { status: "resolved", entityInformationId: "device" },
        subjects: [],
      };
      const writes = await Promise.all([
        db.knowledge.putEvent(input),
        db.knowledge.putEvent(input),
      ]);
      expect(writes.filter((r) => r.created)).toHaveLength(1);
      expect(writes[0]!.event).toEqual(writes[1]!.event);
      const recordedBefore = writes[0]!.event.recordedAt;
      expect(
        (
          await db.knowledge.recall({
            scopeInformationId: "device",
            occurredBefore: input.occurredAt,
            recordedBefore,
            limit: 10,
          })
        ).events,
      ).toHaveLength(1);
      const page = (await db.knowledge.listDirtyPages({ limit: 1 }))[0]!;
      const base: WikiRevisionInput = {
        operationId: "refresh-1",
        scopeInformationId: "device",
        entityInformationId: "device",
        expectedVersion: 0,
        expectedDirtyVersion: page.dirtyVersion,
        evidenceCutoff: { occurredBefore: input.occurredAt, recordedBefore },
        generatorVersion: "test-v1",
        sections: [
          {
            heading: "Readings",
            content: input.content,
            evidenceSourceInformationIds: ["reading"],
            claimIds: [],
          },
        ],
      };
      const revisionWrites = await Promise.allSettled([
        db.knowledge.writeWikiRevision(base),
        db.knowledge.writeWikiRevision({ ...base, operationId: "refresh-2" }),
      ]);
      expect(
        revisionWrites.filter((r) => r.status === "fulfilled"),
      ).toHaveLength(1);
      const failed = revisionWrites.find((r) => r.status === "rejected");
      expect(
        failed?.status === "rejected" ? failed.reason : undefined,
      ).toBeInstanceOf(KnowledgeConflictError);
      const saved = (
        await db.knowledge.listWikiRevisions({
          scopeInformationId: "device",
          entityInformationId: "device",
          limit: 10,
        })
      )[0]!;
      expect(
        await db.knowledge.writeWikiRevision({
          ...base,
          operationId: saved.operationId,
        }),
      ).toEqual(saved);
      await db.knowledge.revokeSource({
        scopeInformationId: "device",
        sourceInformationId: "reading",
        reason: "sensor correction",
      });
      await db.close();
      const restarted = await scope.reconnect();
      await restarted.prepareSchema();
      await restarted.prepareMemoryKnowledgeSchema();
      expect(
        await restarted.knowledge.filterAvailableSourceIds({
          sourceInformationIds: ["reading"],
        }),
      ).toEqual([]);
      expect(
        (await restarted.knowledge.readWikiPage({
          scopeInformationId: "device",
          entityInformationId: "device",
        }))!.dirty,
      ).toBe(true);
      expect(
        await restarted.knowledge.listWikiRevisions({
          scopeInformationId: "device",
          entityInformationId: "device",
          limit: 10,
        }),
      ).toEqual([saved]);
    } finally {
      await scope.close();
    }
  });
});
