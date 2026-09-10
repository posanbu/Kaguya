/**
 * 功能概述：持久化 durable one-shot scheduler 的可重建 arm projection，并把 schedule、due 与 terminal
 * 的原子提交和可变执行状态放在同一 PostgreSQL 事务中。
 * 主要职责：create/replace/emitDue/finish 复用 Reliable 的 operation、terminal 与 claim fencing，
 * listOpen 为 timer runner 提供稳定 keyset 分页；arm 表只保存 dueAt、状态和事实引用，不保存回调或计时器句柄。
 * 代码库关系：`InformationRepository` 注入 append/read 与 Reliable 实现；scheduler 契约提供 commit 类型和回执，
 * schema.ts 建立 projection 表；Core/runner 只通过本文件导出的 projection store 端口访问数据库。
 * 输入输出与副作用：所有写操作在一个数据库事务内完成，失败自动回滚；information atoms 仍 append-only，
 * arm projection 是可变的执行索引，可在进程重启后由 listOpen 重建。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
} from "@kaguya/schema";
import type {
  InformationClaim,
  InformationReferenceExpectation,
} from "@kaguya/engine";
import type {
  OneShotCreateCommit,
  OneShotDueCommit,
  OneShotDueReceipt,
  OneShotFencingGuard,
  OneShotReplaceCommit,
  OneShotReplacementReceipt,
  OneShotScheduleReceipt,
  OneShotTerminalCommit,
  OneShotTerminalResult,
} from "@kaguya/scheduler";

import type { SqlDatabase, SqlTransaction } from "./driver.js";
import {
  assertClaimInTransaction,
  ReliableInformationRepository,
} from "./reliable-repository.js";

export interface OpenOneShotArm {
  readonly scheduleInformationId: InformationId;
  readonly dueAt: string;
}

export interface OpenOneShotPage {
  readonly arms: readonly OpenOneShotArm[];
  readonly nextCursor?: InformationId;
}

export interface OneShotScheduleProjectionStore {
  create(input: OneShotCreateCommit): Promise<OneShotScheduleReceipt>;
  replace(input: OneShotReplaceCommit): Promise<OneShotReplacementReceipt>;
  emitDue(input: OneShotDueCommit): Promise<OneShotDueReceipt>;
  finish(input: OneShotTerminalCommit): Promise<OneShotTerminalResult>;
  listOpen(input: {
    readonly after?: InformationId;
    readonly limit: number;
  }): Promise<OpenOneShotPage>;
}

const SCHEDULE_OPERATION_NAMESPACE = "kaguya.schedule.one-shot.schedule.v1";
const DUE_OPERATION_NAMESPACE = "kaguya.schedule.one-shot.due.v1";
const TERMINAL_NAMESPACE = "kaguya.schedule.one-shot.result.v1";

export class OneShotScheduleRepository implements OneShotScheduleProjectionStore {
  constructor(
    private readonly database: SqlDatabase,
    private readonly reliable: ReliableInformationRepository,
  ) {}

  async create(input: OneShotCreateCommit): Promise<OneShotScheduleReceipt> {
    validateDueAt(input.dueAt);
    return this.database.transaction(async (tx) => {
      await assertGuard(tx, input.guard);
      const result = await this.reliable.appendOnceInTransaction(
        tx,
        SCHEDULE_OPERATION_NAMESPACE,
        input.operationKey,
        input.schedule,
        expectationsFor(input.schedule),
        {},
      );
      if (result.created) {
        await insertArm(tx, input.schedule.informationId, input.dueAt);
      } else {
        await ensureArmExists(tx, result.atom.informationId);
      }
      await assertGuard(tx, input.guard);
      return {
        scheduleInformationId: result.atom.informationId,
        created: result.created,
      };
    });
  }

  async replace(
    input: OneShotReplaceCommit,
  ): Promise<OneShotReplacementReceipt> {
    validateDueAt(input.dueAt);
    return this.database.transaction(async (tx) => {
      await assertGuard(tx, input.guard);
      const replacement = await this.reliable.appendOnceInTransaction(
        tx,
        SCHEDULE_OPERATION_NAMESPACE,
        input.operationKey,
        input.schedule,
        expectationsFor(input.schedule),
        {},
      );
      if (replacement.created) {
        await insertArm(tx, replacement.atom.informationId, input.dueAt);
      } else {
        await ensureArmExists(tx, replacement.atom.informationId);
      }

      const oldArm = await lockArm(tx, input.previousScheduleInformationId);
      const terminal = await readTerminalSlot(
        tx,
        input.previousScheduleInformationId,
      );

      let previousOutcome: OneShotReplacementReceipt["previousOutcome"];
      let previousTerminalInformationId: InformationId;
      if (terminal === undefined) {
        const superseded = await this.reliable.appendTerminalInTransaction(
          tx,
          TERMINAL_NAMESPACE,
          input.previousScheduleInformationId,
          input.superseded,
          expectationsFor(input.superseded),
          {},
        );
        previousOutcome = "superseded";
        previousTerminalInformationId = superseded.atom.informationId;
        await setTerminalArm(
          tx,
          input.previousScheduleInformationId,
          oldArm.state,
          previousTerminalInformationId,
        );
      } else {
        previousOutcome = "already-terminal";
        previousTerminalInformationId = terminal;
      }

      await assertGuard(tx, input.guard);
      return {
        scheduleInformationId: replacement.atom.informationId,
        created: replacement.created,
        previousOutcome,
        previousTerminalInformationId,
      };
    });
  }

  async emitDue(input: OneShotDueCommit): Promise<OneShotDueReceipt> {
    return this.database.transaction(async (tx) => {
      const arm = await lockArm(tx, input.scheduleInformationId);
      const result = await this.reliable.appendOnceInTransaction(
        tx,
        DUE_OPERATION_NAMESPACE,
        input.scheduleInformationId,
        input.due,
        expectationsFor(input.due),
        {},
      );
      if (arm.state === "open") {
        await tx.query(
          `UPDATE information_schedule_arms
           SET state = 'due', due_information_id = $2
           WHERE schedule_information_id = $1`,
          [input.scheduleInformationId, result.atom.informationId],
        );
      } else if (arm.state === "terminal") {
        await tx.query(
          `UPDATE information_schedule_arms
           SET due_information_id = COALESCE(due_information_id, $2)
           WHERE schedule_information_id = $1`,
          [input.scheduleInformationId, result.atom.informationId],
        );
      }
      return {
        scheduleInformationId: input.scheduleInformationId,
        dueInformationId: result.atom.informationId,
        created: result.created,
      };
    });
  }

  async finish(input: OneShotTerminalCommit): Promise<OneShotTerminalResult> {
    return this.database.transaction(async (tx) => {
      await assertGuard(tx, input.guard);
      const arm = await lockArm(tx, input.scheduleInformationId);
      const result = await this.reliable.appendTerminalInTransaction(
        tx,
        TERMINAL_NAMESPACE,
        input.scheduleInformationId,
        input.terminal,
        expectationsFor(input.terminal),
        {},
      );
      if (arm.state !== "terminal") {
        await setTerminalArm(
          tx,
          input.scheduleInformationId,
          arm.state,
          result.atom.informationId,
        );
      }
      await assertGuard(tx, input.guard);
      return {
        scheduleInformationId: input.scheduleInformationId,
        terminalInformationId: result.atom.informationId,
        status: terminalStatus(result.atom),
        created: result.created,
      };
    });
  }

  async listOpen(input: {
    readonly after?: InformationId;
    readonly limit: number;
  }): Promise<OpenOneShotPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    ) {
      throw new Error(
        "one-shot schedule page limit must be between 1 and 1000",
      );
    }
    return this.database.transaction(async (tx) => {
      const result = await tx.query<{
        schedule_information_id: string;
        due_at: string;
      }>(
        `SELECT schedule_information_id, due_at::text AS due_at
         FROM information_schedule_arms
         WHERE state = 'open'
           AND ($1::text IS NULL OR schedule_information_id > $1)
         ORDER BY schedule_information_id ASC
         LIMIT $2`,
        [input.after ?? null, input.limit],
      );
      const arms = result.rows.map((row) => ({
        scheduleInformationId: row.schedule_information_id as InformationId,
        dueAt: new Date(row.due_at).toISOString(),
      }));
      return {
        arms,
        ...(arms.length === input.limit
          ? { nextCursor: arms.at(-1)!.scheduleInformationId }
          : {}),
      };
    });
  }
}

async function assertGuard(
  tx: SqlTransaction,
  guard: OneShotFencingGuard | undefined,
): Promise<void> {
  if (guard !== undefined) {
    await assertClaimInTransaction(tx, guard as InformationClaim);
  }
}

async function insertArm(
  tx: SqlTransaction,
  scheduleInformationId: InformationId,
  dueAt: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO information_schedule_arms(schedule_information_id, due_at, state)
     VALUES ($1, $2::timestamptz, 'open')`,
    [scheduleInformationId, dueAt],
  );
}

async function ensureArmExists(
  tx: SqlTransaction,
  scheduleInformationId: InformationId,
): Promise<void> {
  const row = await tx.query(
    "SELECT 1 FROM information_schedule_arms WHERE schedule_information_id = $1",
    [scheduleInformationId],
  );
  if (row.rowCount !== 1) {
    throw new Error("Committed one-shot schedule is missing its arm");
  }
}

type ArmRow = {
  state: "open" | "due" | "terminal";
};

async function lockArm(
  tx: SqlTransaction,
  scheduleInformationId: InformationId,
): Promise<ArmRow> {
  const row = await tx.query<ArmRow>(
    `SELECT state FROM information_schedule_arms
     WHERE schedule_information_id = $1 FOR UPDATE`,
    [scheduleInformationId],
  );
  if (row.rowCount !== 1)
    throw new Error("One-shot schedule arm does not exist");
  return row.rows[0]!;
}

async function readTerminalSlot(
  tx: SqlTransaction,
  scheduleInformationId: InformationId,
): Promise<InformationId | undefined> {
  const row = await tx.query<{ information_id: string }>(
    `SELECT information_id FROM information_commit_slots
     WHERE slot_type = 'terminal' AND namespace = $1 AND key = $2`,
    [TERMINAL_NAMESPACE, scheduleInformationId],
  );
  return row.rows[0]?.information_id as InformationId | undefined;
}

async function setTerminalArm(
  tx: SqlTransaction,
  scheduleInformationId: InformationId,
  previousState: ArmRow["state"],
  terminalInformationId: InformationId,
): Promise<void> {
  await tx.query(
    `UPDATE information_schedule_arms
     SET state = 'terminal', terminal_information_id = $2
     WHERE schedule_information_id = $1 AND state = $3`,
    [scheduleInformationId, terminalInformationId, previousState],
  );
}

function validateDueAt(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("one-shot schedule requires an absolute dueAt");
  }
}

function expectationsFor(
  atom: DeepReadonly<InformationAtom>,
): readonly InformationReferenceExpectation[] {
  if (atom.kind === "core.schedule.one-shot.requested") {
    return [
      { relation: "core:caused-by", required: true, multiple: false },
      { relation: "core:replaces", required: false, multiple: false },
    ];
  }
  if (
    atom.kind === "core.schedule.one-shot.due" ||
    atom.kind === "core.schedule.one-shot.fired" ||
    atom.kind === "core.schedule.one-shot.superseded" ||
    atom.kind === "core.schedule.one-shot.failed"
  ) {
    return [
      {
        relation: "core:status-of",
        required: true,
        multiple: false,
        targetKinds: ["core.schedule.one-shot.requested"],
      },
    ];
  }
  return [];
}

function terminalStatus(
  atom: DeepReadonly<InformationAtom>,
): OneShotTerminalResult["status"] {
  switch (atom.kind) {
    case "core.schedule.one-shot.fired":
      return "fired";
    case "core.schedule.one-shot.superseded":
      return "superseded";
    case "core.schedule.one-shot.failed":
      return "failed";
    default:
      throw new Error("Invalid one-shot terminal atom kind");
  }
}
