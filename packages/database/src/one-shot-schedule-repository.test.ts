/**
 * 功能概述：验证 one-shot arm projection 在 PGlite 与真实 PostgreSQL 中的原子性、幂等性、竞态和 fencing。
 * 主要职责：覆盖 create/replace/emitDue/finish、分页恢复、旧 terminal 赢家及失效 claim 拒绝写入。
 * 代码库关系：直接通过 `InformationRepository.oneShotSchedules` 测试生产仓储与 migrations，不引入内存替身。
 * 输入输出与副作用：每个测试创建隔离数据库；真实 PostgreSQL 用 testing scope，不修改用户 schema。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InformationClaimLostError } from "@kaguya/engine";
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
    [
      {
        relation: "core:caused-by",
        informationId: informationIdSchema.parse(source),
      },
    ],
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
    [
      {
        relation: "core:status-of",
        informationId: informationIdSchema.parse(schedule),
      },
    ],
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
    [
      {
        relation: "core:status-of",
        informationId: informationIdSchema.parse(schedule),
      },
    ],
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
    expect(
      await db.information.oneShotSchedules.listOpen({ limit: 256 }),
    ).toEqual({
      arms: [
        {
          scheduleInformationId: "schedule-a",
          dueAt: "2026-09-06T04:00:00.000Z",
        },
      ],
    });
  });

  it("returns stable cursors across multiple open-arm pages", async () => {
    const db = await setup();
    await create(db, "schedule-a");
    await create(db, "schedule-b");
    await create(db, "schedule-c");
    const first = await db.information.oneShotSchedules.listOpen({ limit: 2 });
    expect(first.arms.map((arm) => arm.scheduleInformationId)).toEqual([
      "schedule-a",
      "schedule-b",
    ]);
    expect(first.nextCursor).toBe("schedule-b");
    const second = await db.information.oneShotSchedules.listOpen({
      ...(first.nextCursor === undefined ? {} : { after: first.nextCursor }),
      limit: 2,
    });
    expect(second.arms.map((arm) => arm.scheduleInformationId)).toEqual([
      "schedule-c",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("rolls back the atom, operation slot, and arm when arm SQL fails", async () => {
    const db = await setup();
    const transaction = db.sql.transaction.bind(db.sql);
    let failed = false;
    vi.spyOn(db.sql, "transaction").mockImplementation((run) =>
      transaction((tx) =>
        run({
          exec: (sql) => tx.exec(sql),
          query: async (text, values) => {
            const result = await tx.query(text, values);
            if (
              !failed &&
              text.includes("INSERT INTO information_schedule_arms")
            ) {
              failed = true;
              throw new Error("injected arm projection failure");
            }
            return result as never;
          },
        }),
      ),
    );
    await expect(create(db, "rollback")).rejects.toThrow(
      "injected arm projection failure",
    );
    expect(
      await db.information.get(informationIdSchema.parse("rollback")),
    ).toBeUndefined();
    expect(
      await db.information.oneShotSchedules.listOpen({ limit: 256 }),
    ).toEqual({ arms: [] });
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
    expect(
      await db.information.get(informationIdSchema.parse("superseded")),
    ).toBeDefined();
    expect(
      await db.information.oneShotSchedules.listOpen({ limit: 256 }),
    ).toEqual({
      arms: [
        { scheduleInformationId: "new", dueAt: "2026-09-06T04:00:00.000Z" },
      ],
    });
    const fired: OneShotTerminalCommit = {
      scheduleInformationId: informationIdSchema.parse("old"),
      terminal: terminal("late-fired", "fired", "old"),
    };
    const late = await db.information.oneShotSchedules.finish(fired);
    expect(late.status).toBe("superseded");
    expect(late.terminalInformationId).toBe("superseded");
  });

  it("creates a new open schedule when the previous schedule is already terminal", async () => {
    const db = await setup();
    await create(db, "old-terminal");
    const fired = await db.information.oneShotSchedules.finish({
      scheduleInformationId: informationIdSchema.parse("old-terminal"),
      terminal: terminal("old-fired", "fired", "old-terminal"),
    });
    const replacement = await db.information.oneShotSchedules.replace({
      operationKey: "replacement-after-terminal",
      previousScheduleInformationId: informationIdSchema.parse("old-terminal"),
      schedule: requested(
        "replacement-after-terminal",
        "source",
        "replacement-after-terminal",
      ),
      superseded: terminal("unused-superseded", "superseded", "old-terminal"),
      dueAt: "2026-09-06T04:00:00.000Z",
    });
    expect(replacement.previousOutcome).toBe("already-terminal");
    expect(replacement.previousTerminalInformationId).toBe(
      fired.terminalInformationId,
    );
    expect(
      await db.information.get(informationIdSchema.parse("unused-superseded")),
    ).toBeUndefined();
    expect(
      await db.information.oneShotSchedules.listOpen({ limit: 256 }),
    ).toEqual({
      arms: [
        {
          scheduleInformationId: "replacement-after-terminal",
          dueAt: "2026-09-06T04:00:00.000Z",
        },
      ],
    });
  });

  it("rejects stale guards for create, replace, and finish without changing state", async () => {
    const db = await setup();
    await db.information.reliable.configureSubscriptions([
      { subscriptionId: "test.schedule-guard", kind: "test.source" },
    ]);
    await db.information.append(sourceAtom("guard-source"), []);
    const claim = (await db.information.reliable.claim(
      "test.schedule-guard",
      10_000,
    ))!;
    await create(db, "guarded-old");
    await db.sql.exec(
      "UPDATE information_deliveries SET lease_until = clock_timestamp() - interval '1 second'",
    );
    const guard = { ...claim };
    await expect(
      db.information.oneShotSchedules.create({
        operationKey: "stale-create",
        schedule: requested("stale-create"),
        dueAt: "2026-09-06T04:00:00.000Z",
        guard,
      }),
    ).rejects.toBeInstanceOf(InformationClaimLostError);
    await expect(
      db.information.oneShotSchedules.replace({
        operationKey: "stale-replace",
        previousScheduleInformationId: informationIdSchema.parse("guarded-old"),
        schedule: requested("stale-replace", "source", "stale-replace"),
        superseded: terminal("stale-superseded", "superseded", "guarded-old"),
        dueAt: "2026-09-06T04:00:00.000Z",
        guard,
      }),
    ).rejects.toBeInstanceOf(InformationClaimLostError);
    await expect(
      db.information.oneShotSchedules.finish({
        scheduleInformationId: informationIdSchema.parse("guarded-old"),
        terminal: terminal("stale-fired", "fired", "guarded-old"),
        guard,
      }),
    ).rejects.toBeInstanceOf(InformationClaimLostError);
    expect(
      await db.information.oneShotSchedules.listOpen({ limit: 256 }),
    ).toEqual({
      arms: [
        {
          scheduleInformationId: "guarded-old",
          dueAt: "2026-09-06T04:00:00.000Z",
        },
      ],
    });
  });

  it("emits a due atom after a terminal without reopening the arm", async () => {
    const db = await setup();
    await create(db, "due-after-terminal");
    await db.information.oneShotSchedules.finish({
      scheduleInformationId: informationIdSchema.parse("due-after-terminal"),
      terminal: terminal("due-after-fired", "fired", "due-after-terminal"),
    });
    const emitted = await db.information.oneShotSchedules.emitDue({
      scheduleInformationId: informationIdSchema.parse("due-after-terminal"),
      due: due("due-after-due", "due-after-terminal"),
    });
    expect(emitted.created).toBe(true);
    expect(
      await db.information.get(informationIdSchema.parse("due-after-due")),
    ).toBeDefined();
    expect(
      await db.information.oneShotSchedules.listOpen({ limit: 256 }),
    ).toEqual({ arms: [] });
    const arm = await db.sql.query<{
      state: string;
      due_information_id: string | null;
      terminal_information_id: string | null;
    }>(
      "SELECT state, due_information_id, terminal_information_id FROM information_schedule_arms WHERE schedule_information_id = $1",
      ["due-after-terminal"],
    );
    expect(arm.rows[0]).toEqual({
      state: "terminal",
      due_information_id: "due-after-due",
      terminal_information_id: "due-after-fired",
    });
  });

  it("serializes a fired-versus-replace race to one old terminal", async () => {
    const db = await setup();
    await create(db, "race-old");
    const [fired, replacement] = await Promise.all([
      db.information.oneShotSchedules.finish({
        scheduleInformationId: informationIdSchema.parse("race-old"),
        terminal: terminal("race-fired", "fired", "race-old"),
      }),
      db.information.oneShotSchedules.replace({
        operationKey: "race-replacement",
        previousScheduleInformationId: informationIdSchema.parse("race-old"),
        schedule: requested("race-new", "source", "race-replacement"),
        superseded: terminal("race-superseded", "superseded", "race-old"),
        dueAt: "2026-09-06T04:00:00.000Z",
      }),
    ]);
    const winner = fired.created
      ? fired.terminalInformationId
      : replacement.previousTerminalInformationId;
    expect(fired.created ? replacement.previousOutcome : fired.status).toBe(
      fired.created ? "already-terminal" : "superseded",
    );
    expect(winner).toBeDefined();
    const terminals = await db.information.query({
      informationId: informationIdSchema.parse("race-old"),
      relation: "core:status-of",
    });
    expect(
      terminals.filter(
        (atom) =>
          atom.kind.includes("fired") || atom.kind.includes("superseded"),
      ),
    ).toHaveLength(1);
  });

  it("makes due idempotent and terminal commit single-winner", async () => {
    const db = await setup();
    await create(db, "schedule");
    const dueCommit: OneShotDueCommit = {
      scheduleInformationId: informationIdSchema.parse("schedule"),
      due: due("due", "schedule"),
    };
    expect(
      await db.information.oneShotSchedules.emitDue(dueCommit),
    ).toMatchObject({ created: true });
    expect(
      await db.information.oneShotSchedules.emitDue(dueCommit),
    ).toMatchObject({ created: false, dueInformationId: "due" });
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
    expect(
      new Set(finishes.map((result) => result.terminalInformationId)).size,
    ).toBe(1);
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
      expect(
        await second.information.oneShotSchedules.listOpen({ limit: 256 }),
      ).toEqual({
        arms: [
          {
            scheduleInformationId: "restart",
            dueAt: "2026-09-06T04:00:00.000Z",
          },
        ],
      });
      const races = await Promise.all([
        ...Array.from({ length: 6 }, (_, index) =>
          second.information.oneShotSchedules.replace({
            operationKey: `replacement-${index}`,
            previousScheduleInformationId: informationIdSchema.parse("restart"),
            schedule: requested(
              `replacement-${index}`,
              "source",
              `replacement-${index}`,
            ),
            superseded: terminal(
              `superseded-${index}`,
              "superseded",
              "restart",
            ),
            dueAt: "2026-09-06T04:00:00.000Z",
          }),
        ),
        ...Array.from({ length: 6 }, (_, index) =>
          second.information.oneShotSchedules.finish({
            scheduleInformationId: informationIdSchema.parse("restart"),
            terminal: terminal(`fired-race-${index}`, "fired", "restart"),
          }),
        ),
      ]);
      expect(
        new Set(
          races.map((result) =>
            "previousOutcome" in result
              ? result.previousTerminalInformationId
              : result.terminalInformationId,
          ),
        ).size,
      ).toBe(1);
    } finally {
      await scope.close();
    }
  });
});
