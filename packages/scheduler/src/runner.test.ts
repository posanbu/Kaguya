/**
 * 功能概述：验证 scheduler 恢复、过期投递、timer 清理与确定性时钟行为。
 * 主要职责：覆盖分页恢复和重复回调的幂等边界，确保 runner 不持有业务回调。
 */
import { describe, expect, it, vi } from "vitest";
import { DurableOneShotScheduler } from "./runner.js";
import { FakeScheduleClock } from "./testing.js";
import type { ScheduleClock } from "./contracts.js";

type Arm = { scheduleInformationId: string; dueAt: string };

class ManualClock implements ScheduleClock {
  #nowMs: number;
  #nextId = 1;
  readonly timers = new Map<number, { handler: () => void; delayMs: number; deadline: number }>();

  constructor(now: string) {
    this.#nowMs = Date.parse(now);
  }

  now(): Date {
    return new Date(this.#nowMs);
  }

  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.timers.set(id, { handler, delayMs, deadline: this.#nowMs + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  setNow(value: string): void {
    this.#nowMs = Date.parse(value);
  }

  async invoke(id: number, advance = false): Promise<void> {
    const timer = this.timers.get(id);
    if (!timer) throw new Error(`unknown timer ${id}`);
    this.timers.delete(id);
    if (advance) this.#nowMs = timer.deadline;
    timer.handler();
    await Promise.resolve();
  }

  nextTimer(): { id: number; delayMs: number } | undefined {
    const timer = [...this.timers.entries()].sort((left, right) => left[1].deadline - right[1].deadline)[0];
    return timer === undefined ? undefined : { id: timer[0], delayMs: timer[1].delayMs };
  }
}

function storeFor(arms: readonly Arm[], emitDue: (commit: unknown) => Promise<unknown>) {
  return {
    emitDue: vi.fn(emitDue),
    listOpen: vi.fn(async ({ after }: { after?: string }) => {
      if (after !== undefined) return { arms: [] };
      return { arms };
    }),
  };
}

function idGenerator() {
  let sequence = 0;
  return () => `due-${++sequence}` as never;
}

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

  it("ignores duplicate and stale generation callbacks", async () => {
    const clock = new ManualClock("2026-09-06T12:00:00.000Z");
    const emitDue = vi.fn(async () => ({ scheduleInformationId: "schedule", dueInformationId: "due", created: true }));
    const store = storeFor([{ scheduleInformationId: "schedule", dueAt: "2026-09-06T12:01:00.000Z" }], emitDue);
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator() });
    await scheduler.start();
    const first = clock.nextTimer();
    expect(first).toBeDefined();
    const staleHandler = clock.timers.get(first!.id)!.handler;
    await scheduler.refresh("schedule" as never);
    const second = clock.nextTimer();
    expect(second?.id).not.toBe(first?.id);
    staleHandler();
    await Promise.resolve();
    expect(store.emitDue).not.toHaveBeenCalled();
    const currentHandler = clock.timers.get(second!.id)!.handler;
    await clock.invoke(second!.id, true);
    currentHandler();
    await Promise.resolve();
    expect(store.emitDue).toHaveBeenCalledTimes(1);
  });

  it("segments delays larger than the Node timeout limit", async () => {
    const clock = new ManualClock("2026-09-06T12:00:00.000Z");
    const emitDue = vi.fn(async () => ({ scheduleInformationId: "long", dueInformationId: "due", created: true }));
    const store = storeFor([{ scheduleInformationId: "long", dueAt: "2026-10-10T12:00:00.000Z" }], emitDue);
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator() });
    await scheduler.start();
    const first = clock.nextTimer();
    expect(first?.delayMs).toBe(2_147_483_647);
    await clock.invoke(first!.id, true);
    expect(clock.nextTimer()?.delayMs).toBeLessThanOrEqual(2_147_483_647);
    expect(emitDue).not.toHaveBeenCalled();
  });

  it("retries a failed due emission while preserving the open arm", async () => {
    const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
    let attempts = 0;
    const emitDue = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary database outage");
      return { scheduleInformationId: "retry", dueInformationId: "due", created: true };
    });
    const store = storeFor([{ scheduleInformationId: "retry", dueAt: "2026-09-06T11:59:00.000Z" }], emitDue);
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator() });
    await scheduler.start();
    expect(emitDue).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimerCount()).toBe(1);
    await clock.advanceTo(new Date("2026-09-06T12:00:01.000Z"));
    expect(emitDue).toHaveBeenCalledTimes(2);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("waits for an in-flight callback during bounded stop without finishing the arm", async () => {
    const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const emitDue = vi.fn(async () => {
      await pending;
      return { scheduleInformationId: "drain", dueInformationId: "due", created: true };
    });
    const store = storeFor([{ scheduleInformationId: "drain", dueAt: "2026-09-06T12:01:00.000Z" }], emitDue);
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator(), drainTimeoutMs: 500 });
    await scheduler.start();
    await clock.advanceTo(new Date("2026-09-06T12:01:00.000Z"));
    expect(emitDue).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await clock.advanceTo(new Date("2026-09-06T12:01:00.500Z"));
    await stop;
    expect(stopped).toBe(true);
    expect(clock.pendingTimerCount()).toBe(0);
    release();
  });

  it("bounds stop while startup recovery delivery is still in flight", async () => {
    const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const emitDue = vi.fn(async () => {
      await pending;
      return { scheduleInformationId: "startup-drain", dueInformationId: "due", created: true };
    });
    const store = storeFor([{ scheduleInformationId: "startup-drain", dueAt: "2026-09-06T11:59:00.000Z" }], emitDue);
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator(), drainTimeoutMs: 500 });
    const starting = scheduler.start();
    await vi.waitFor(() => expect(emitDue).toHaveBeenCalledTimes(1));
    const stopping = scheduler.stop();
    await clock.advanceTo(new Date("2026-09-06T12:00:00.500Z"));
    await stopping;
    expect(clock.pendingTimerCount()).toBe(0);
    release();
    await starting;
  });

  it("refreshes an overdue arm and delivers it before resolving", async () => {
    const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
    const emitDue = vi.fn(async () => ({ scheduleInformationId: "refresh", dueInformationId: "due", created: true }));
    const store = storeFor([], emitDue);
    store.listOpen.mockImplementationOnce(async () => ({ arms: [] }));
    store.listOpen.mockImplementationOnce(async () => ({ arms: [{ scheduleInformationId: "refresh", dueAt: "2026-09-06T11:59:00.000Z" }] }));
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator() });
    await scheduler.start();
    await scheduler.refresh("refresh" as never);
    expect(emitDue).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("re-arms when the host clock moves backwards before a callback", async () => {
    const clock = new ManualClock("2026-09-06T12:00:00.000Z");
    const emitDue = vi.fn(async () => ({ scheduleInformationId: "clock", dueInformationId: "due", created: true }));
    const store = storeFor([{ scheduleInformationId: "clock", dueAt: "2026-09-06T12:01:00.000Z" }], emitDue);
    const scheduler = new DurableOneShotScheduler({ store: store as any, clock, nextInformationId: idGenerator() });
    await scheduler.start();
    const timer = clock.nextTimer();
    clock.setNow("2026-09-06T11:59:59.000Z");
    await clock.invoke(timer!.id);
    expect(clock.nextTimer()?.delayMs).toBe(61_000);
    expect(emitDue).not.toHaveBeenCalled();
  });

  it("recovers every page of open arms", async () => {
    const clock = new FakeScheduleClock("2026-09-06T12:00:00.000Z");
    const emitDue = vi.fn(async () => ({ scheduleInformationId: "due", dueInformationId: "atom", created: true }));
    const pages = [
      { arms: [{ scheduleInformationId: "first", dueAt: "2026-09-06T12:00:01.000Z" }], nextCursor: "first" },
      { arms: [{ scheduleInformationId: "second", dueAt: "2026-09-06T12:00:02.000Z" }] },
    ];
    const listOpen = vi.fn(async ({ after }: { after?: string }) => after === undefined ? pages[0] : pages[1]);
    const scheduler = new DurableOneShotScheduler({ store: { listOpen, emitDue } as any, clock, nextInformationId: idGenerator(), recoveryBatchSize: 1 });
    await scheduler.start();
    expect(listOpen).toHaveBeenCalledTimes(2);
    expect(clock.pendingTimerCount()).toBe(2);
  });
});
