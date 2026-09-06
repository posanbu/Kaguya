/**
 * 功能概述：提供不依赖 vi fake timers 的确定性 scheduler 时钟。
 * 主要职责：按 deadline 与插入序执行 timer，并在每个回调后让出 microtask。
 * 代码库关系：runner 测试注入本时钟；生产环境使用 runner 内的 system clock。
 */
import type { ScheduleClock } from "./contracts.js";

type Timer = { readonly id: number; readonly deadline: number; readonly handler: () => void };

export class FakeScheduleClock implements ScheduleClock {
  #nowMs: number;
  #nextId = 1;
  readonly #timers = new Map<number, Timer>();

  constructor(now: string | Date) {
    const value = typeof now === "string" ? Date.parse(now) : now.getTime();
    if (!Number.isFinite(value)) throw new Error("Invalid fake clock time");
    this.#nowMs = value;
  }
  now(): Date { return new Date(this.#nowMs); }
  setTimeout(handler: () => void, delayMs: number): unknown {
    const delay = Math.max(0, Math.min(delayMs, 2_147_483_647));
    const id = this.#nextId++;
    this.#timers.set(id, { id, deadline: this.#nowMs + delay, handler });
    return id;
  }
  clearTimeout(handle: unknown): void { if (typeof handle === "number") this.#timers.delete(handle); }
  pendingTimerCount(): number { return this.#timers.size; }
  async advanceTo(target: Date): Promise<void> {
    const targetMs = target.getTime();
    if (!Number.isFinite(targetMs) || targetMs < this.#nowMs) throw new Error("Fake clock cannot move backwards");
    while (true) {
      const timer = [...this.#timers.values()].sort((a, b) => a.deadline - b.deadline || a.id - b.id)[0];
      if (!timer || timer.deadline > targetMs) break;
      this.#timers.delete(timer.id);
      this.#nowMs = timer.deadline;
      timer.handler();
      await Promise.resolve();
    }
    this.#nowMs = targetMs;
    await Promise.resolve();
  }
}
