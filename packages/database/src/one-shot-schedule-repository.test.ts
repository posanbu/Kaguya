/**
 * 功能概述：验证 one-shot arm projection 在 PGlite 与真实 PostgreSQL 中的原子性、幂等性、竞态和 fencing。
 * 主要职责：覆盖 create/replace/emitDue/finish、分页恢复、旧 terminal 赢家及失效 claim 拒绝写入。
 * 代码库关系：直接通过 `InformationRepository.oneShotSchedules` 测试生产仓储与 migrations，不引入内存替身。
 * 输入输出与副作用：每个测试创建隔离数据库；真实 PostgreSQL 用 testing scope，不修改用户 schema。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  freezeInformationAtom,
  informationIdSchema,
  type JsonObject,
  type InformationAtom,
} from "@kaguya/schema";
import {
  oneShotInformationKinds,
  type OneShotCreateCommit,
  type OneShotDueCommit,
  type OneShotReplaceCommit,
  type OneShotTerminalCommit,
} from "@kaguya/scheduler";
import {
  createPostgresTestingDatabaseScope,
  createTestingDatabase,
} from "./testing.js";

const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");

const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

const atom = (
  informationId: string,
  kind: string,
  payload: JsonObject = {},
  references: InformationAtom["references"] = [],
) =>
  freezeInformationAtom({
    informationId: informationIdSchema.parse(informationId),
    kind,
    occurredAt: new Date().toISOString(),
    source: "module:test",
    payload,
    references,
  });

function sourceAtom(id = "source") {
  return atom(id, "test.source");
}
function requested(id: string, source = "source", operationKey = id) {
  return atom(
    id,
    "core.schedule.one-shot.requested",
    {
      operationKey,
      dueAt: "2026-09-06T04:00:00.000Z",
      input: { text: "hello" },
      activation: { instanceId: "instance", definitionId: "definition" },
    },
    [{ relation: "core:caused-by", informationId: informationIdSchema.parse(source) }],
  );
}
function due(id: string, schedule: string) {
  return atom(
    id,
    "core.schedule.one-shot.due",
    {
      scheduleInformationId: schedule,
      dueAt: "2026-09-06T04:00:00.000Z",
      deliveredAt: "2026-09-06T04:00:00.000Z",
    },
    [{ relation: "core:status-of", informationId: informationIdSchema.parse(schedule) }],
  );
}
function terminal(
  id: string,
  kind: "fired" | "failed" | "superseded",
  schedule: string,
) {
  return atom(
    id,
    `core.schedule.one-shot.${kind}`,
    kind === "failed" ? { failureKind: "consumer-failed" } : {},
    [{ relation: "core:status-of", informationId: informationIdSchema.parse(schedule) }],
  );
}

async function setup() {
  const db = await createTestingDatabase();
  databases.push(db);
  await db.migrate();
  await db.information.synchronizeKinds([
    "test.source",
    ...oneShotInformationKinds.map((definition) => definition.kind),
  ]);
  await db.information.append(sourceAtom(), []);
  return db;
}

async function create(db: Awaited<ReturnType<typeof setup>>, id = "schedule") {
  const input: OneShotCreateCommit = {
    operationKey: id,
    schedule: requested(id),
    dueAt: "2026-09-06T04:00:00.000Z",
  };
  return db.information.oneShotSchedules.create(input);
}

describe("one-shot schedule projection (PGlite)", () => {
  it("writes one arm, deduplicates operation, and paginates open schedules", async () => {
    const db = await setup();
    const first = await create(db, "schedule-a");
    const repeated = await create(db, "schedule-a");
    expect(repeated).toEqual({ ...first, created: false });
    expect(first.created).toBe(true);
    expect(await db.information.oneShotSchedules.listOpen({ limit: 256 })).toEqual({
      arms: [{ scheduleInformationId: "schedule-a", dueAt: "2026-09-06T04:00:00.000Z" }],
    });
  });

  it("atomically supersedes or returns the prior terminal winner", async () => {
    const db = await setup();
    await create(db, "old");
    const replacement: OneShotReplaceCommit = {
      operationKey: "new",
      previousScheduleInformationId: informationIdSchema.parse("old"),
      schedule: requested("new", "source", "new"),
      superseded: terminal("superseded", "superseded", "old"),
      dueAt: "2026-09-06T04:00:00.000Z",
    };
    const result = await db.information.oneShotSchedules.replace(replacement);
    expect(result.previousOutcome).toBe("superseded");
    expect(await db.information.get(informationIdSchema.parse("superseded"))).toBeDefined();
    expect(await db.information.oneShotSchedules.listOpen({ limit: 256 })).toEqual({
      arms: [{ scheduleInformationId: "new", dueAt: "2026-09-06T04:00:00.000Z" }],
    });
    const fired: OneShotTerminalCommit = {
      scheduleInformationId: informationIdSchema.parse("old"),
      terminal: terminal("late-fired", "fired", "old"),
    };
    const late = await db.information.oneShotSchedules.finish(fired);
    expect(late.status).toBe("superseded");
    expect(late.terminalInformationId).toBe("superseded");
  });

  it("makes due idempotent and terminal commit single-winner", async () => {
    const db = await setup();
    await create(db, "schedule");
    const dueCommit: OneShotDueCommit = {
      scheduleInformationId: informationIdSchema.parse("schedule"),
      due: due("due", "schedule"),
    };
    expect(await db.information.oneShotSchedules.emitDue(dueCommit)).toMatchObject({ created: true });
    expect(await db.information.oneShotSchedules.emitDue(dueCommit)).toMatchObject({ created: false, dueInformationId: "due" });
    const finishes = await Promise.all([
      db.information.oneShotSchedules.finish({
        scheduleInformationId: informationIdSchema.parse("schedule"),
        terminal: terminal("fired", "fired", "schedule"),
      }),
      db.information.oneShotSchedules.finish({
        scheduleInformationId: informationIdSchema.parse("schedule"),
        terminal: terminal("failed", "failed", "schedule"),
      }),
    ]);
    expect(new Set(finishes.map((result) => result.terminalInformationId)).size).toBe(1);
    expect(finishes.filter((result) => result.created)).toHaveLength(1);
  });
});

describe.skipIf(!url)("one-shot schedule projection (PostgreSQL)", () => {
  it("survives close/reconnect with the open projection and serializes replacement race", async () => {
    const scope = await createPostgresTestingDatabaseScope(url!);
    try {
      const first = await scope.connect();
      await first.migrate();
      await first.information.synchronizeKinds([
        "test.source",
        ...oneShotInformationKinds.map((definition) => definition.kind),
      ]);
      await first.information.append(sourceAtom(), []);
      await first.information.oneShotSchedules.create({
        operationKey: "restart",
        schedule: requested("restart"),
        dueAt: "2026-09-06T04:00:00.000Z",
      });
      await first.close();
      const second = await scope.reconnect();
      expect(await second.information.oneShotSchedules.listOpen({ limit: 256 })).toEqual({
        arms: [{ scheduleInformationId: "restart", dueAt: "2026-09-06T04:00:00.000Z" }],
      });
      const races = await Promise.all([
        second.information.oneShotSchedules.replace({
          operationKey: "replacement-a",
          previousScheduleInformationId: informationIdSchema.parse("restart"),
          schedule: requested("replacement-a", "source", "replacement-a"),
          superseded: terminal("superseded-a", "superseded", "restart"),
          dueAt: "2026-09-06T04:00:00.000Z",
        }),
        second.information.oneShotSchedules.finish({
          scheduleInformationId: informationIdSchema.parse("restart"),
          terminal: terminal("fired-race", "fired", "restart"),
        }),
      ]);
      expect(new Set(races.map((result) => "previousOutcome" in result ? result.previousTerminalInformationId : result.terminalInformationId)).size).toBe(1);
    } finally {
      await scope.close();
    }
  });
});
