/**
 * 功能概述：为真实 Runtime/PGlite 集成测试提供有阶段标识的持久化等待与失败诊断。
 * 主要职责：等待沿用 8 秒/20 毫秒预算；失败时报告任务、订阅、调度和最近事件，帮助定位未完成阶段。
 * 代码库关系：speech-planner 与 web-chat fixture 共用；只读测试数据库，不改变 runner 或业务 deadline。
 */
import type { KaguyaDatabase } from "@kaguya/database";
import { expect, vi } from "vitest";

export { closeTestResources } from "../../../../packages/modules/src/first-party/test-support/cleanup.js";
export const persistenceWait = { timeout: 8_000, interval: 20 };

export function createPersistenceWait(
  database: KaguyaDatabase,
  counters: () => Record<string, unknown>,
) {
  let stage = 0;
  return async function wait<T>(
    phase: string,
    assertion: () => T | Promise<T>,
    options = persistenceWait,
  ): Promise<T> {
    const label = `${++stage}: ${phase}`;
    try {
      return await vi.waitFor(assertion, options);
    } catch (cause) {
      const names = ["deliveries", "schedules", "recent", "errors", "health"];
      const reads = await Promise.allSettled([
        database.sql
          .query(
            `SELECT d.subscription_id,a.kind,d.information_id,d.state,d.attempts,d.available_at
          FROM information_deliveries d JOIN information_atoms a USING(information_id)
          WHERE d.state<>'acked' ORDER BY d.created_at LIMIT 25`,
          )
          .then((r) => r.rows),
        database.sql
          .query(
            `SELECT schedule_information_id,state,due_at FROM information_schedule_arms
          WHERE state<>'terminal' ORDER BY due_at LIMIT 20`,
          )
          .then((r) => r.rows),
        database.information
          .find({
            occurredAfter: "2020-01-01T00:00:00Z",
            order: "desc",
            registrationOrder: true,
            limit: 30,
          })
          .then((atoms) =>
            atoms.map((a) => ({
              id: a.informationId,
              kind: a.kind,
              taskId: a.payload.taskId,
              status: a.payload.status,
              sourceId: a.payload.sourceInformationId,
            })),
          ),
        database.information
          .find({ kinds: ["consumer.failed"], limit: 10 })
          .then((atoms) => atoms.map((a) => a.payload)),
        database.information.reliable.health(),
      ]);
      const diagnostics = Object.fromEntries(
        reads.map((r, i) => [
          names[i],
          r.status === "fulfilled"
            ? r.value
            : { diagnosticError: String(r.reason) },
        ]),
      );
      throw new Error(
        `Persistence stage ${label} failed: ${JSON.stringify({
          ...counters(),
          ...diagnostics,
        })}`,
        { cause },
      );
    }
  };
}

/** 当前 fixture 独占数据库；未来调度不阻塞收敛，已到期调度及未结束模型任务必须闭合。 */
export async function expectPersistenceSettled(database: KaguyaDatabase) {
  const state = await database.sql.query(`SELECT
    (SELECT count(*)::int FROM information_deliveries WHERE state IN ('pending','claimed')) pending,
    (SELECT count(*)::int FROM information_schedule_arms WHERE state IN ('open','due') AND due_at<=clock_timestamp()) due,
    (SELECT count(*)::int FROM information_atoms a WHERE a.kind='core.model.task.requested'
      AND NOT EXISTS(SELECT 1 FROM information_references r JOIN information_atoms terminal ON terminal.information_id=r.information_id
        WHERE r.target_information_id=a.information_id AND r.relation='core:status-of'
          AND terminal.kind IN ('core.model.task.completed','core.model.task.failed','core.model.task.cancelled'))) models`);
  expect(state.rows[0]).toEqual({ pending: 0, due: 0, models: 0 });
}

/** 清理始终执行；清理失败与主断言失败同时保留，避免 finally 覆盖原错。 */
export async function withModelGateCleanup(
  run: () => Promise<void>,
  release: () => void,
  drain: () => Promise<unknown>,
) {
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  try {
    release();
  } catch (error) {
    failures.push(error);
  }
  try {
    await drain();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Model gate body and cleanup failed");
}
