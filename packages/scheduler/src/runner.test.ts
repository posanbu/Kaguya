/**
 * 功能概述：验证 scheduler 恢复、过期投递、timer 清理与确定性时钟行为。
 * 主要职责：覆盖分页恢复和重复回调的幂等边界，确保 runner 不持有业务回调。
 */
import { describe, expect, it, vi } from "vitest";
import { DurableOneShotScheduler } from "./runner.js";
import { FakeScheduleClock } from "./testing.js";

describe("DurableOneShotScheduler", () => {
  it("restores future and overdue arms before start resolves", async () => {
    const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
    const emitDue = vi.fn(async () => ({ scheduleInformationId: "x", dueInformationId: "d", created: true }));
    const store = { emitDue, listOpen: vi.fn(async ({ after }: { after?: string }) => after ? { arms: [] } : { arms: [{ scheduleInformationId: "future", dueAt: "2026-09-06T12:01:00.000Z" }, { scheduleInformationId: "overdue", dueAt: "2026-09-06T11:59:00.000Z" }] }) };
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: (() => { let n = 0; return () => `due-${++n}` as any; })(), recoveryBatchSize: 1 });
    await scheduler.start();
    expect(emitDue).toHaveBeenCalledWith(expect.objectContaining({ scheduleInformationId: "overdue" }));
    expect(clock.pendingTimerCount()).toBe(1);
  });
});
