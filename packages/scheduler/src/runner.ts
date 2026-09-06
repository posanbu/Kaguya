/**
 * 功能概述：实现可恢复的 durable one-shot timer runner。
 * 主要职责：分页恢复 open arm、按绝对 dueAt 设置 timer、生成幂等 due atom，并在停止时清理与排空。
 * 代码库关系：只依赖 projection store；业务 terminal 状态由 store 决定，runner 不保存回调或业务状态。
 */
import { freezeInformationAtom, informationIdSchema, type InformationId } from "@kaguya/schema";
import type { OneShotDueCommit, ScheduleClock, OneShotScheduleProjectionStore } from "./contracts.js";
import { oneShotDueInformationKind } from "./information-kinds.js";

const MAX_TIMEOUT = 2_147_483_647;
const systemClock: ScheduleClock = {
  now: () => new Date(),
  setTimeout: (handler, delay) => setTimeout(handler, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DurableOneShotSchedulerOptions {
  readonly store: OneShotScheduleProjectionStore;
  readonly clock?: ScheduleClock;
  readonly nextInformationId: () => InformationId;
  readonly recoveryBatchSize?: number;
  readonly drainTimeoutMs?: number;
}

export class DurableOneShotScheduler {
  readonly #store: OneShotScheduleProjectionStore;
  readonly #clock: ScheduleClock;
  readonly #nextInformationId: () => InformationId;
  readonly #batch: number;
  readonly #drain: number;
  readonly #timers = new Map<InformationId, { handle: unknown; generation: number; dueAt: string }>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #state: "new" | "starting" | "started" | "stopping" | "stopped" = "new";
  #startPromise?: Promise<void>;

  constructor(options: DurableOneShotSchedulerOptions) {
    this.#store = options.store; this.#clock = options.clock ?? systemClock; this.#nextInformationId = options.nextInformationId;
    this.#batch = options.recoveryBatchSize ?? 256; this.#drain = options.drainTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.#batch) || this.#batch < 1) throw new Error("Invalid scheduler recovery batch size");
    if (!Number.isSafeInteger(this.#drain) || this.#drain < 0) throw new Error("Invalid scheduler drain timeout");
  }
  start(): Promise<void> {
    if (this.#state === "started") return Promise.resolve();
    if (this.#state === "starting") return this.#startPromise!;
    if (this.#state !== "new") return Promise.reject(new Error("Scheduler is stopped"));
    this.#state = "starting";
    this.#startPromise = this.recover();
    return this.#startPromise;
  }
  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopping";
    for (const timer of this.#timers.values()) this.#clock.clearTimeout(timer.handle);
    this.#timers.clear();
    let timeoutHandle: unknown;
    const timeout = new Promise<void>((resolve) => { timeoutHandle = this.#clock.setTimeout(resolve, this.#drain); });
    await Promise.race([Promise.allSettled([...this.#inFlight]), timeout]);
    if (timeoutHandle !== undefined) this.#clock.clearTimeout(timeoutHandle);
    this.#state = "stopped";
  }
  async refresh(scheduleInformationId: InformationId): Promise<void> {
    if (this.#state !== "started") throw new Error("Scheduler is not started");
    let cursor: InformationId | undefined;
    while (true) {
      const page = await this.#store.listOpen({ ...(cursor ? { after: cursor } : {}), limit: this.#batch });
      const arm = page.arms.find((candidate) => candidate.scheduleInformationId === scheduleInformationId);
      if (arm) { this.arm(arm.scheduleInformationId, arm.dueAt); if (Date.parse(arm.dueAt) <= this.#clock.now().getTime()) await this.fire(arm.scheduleInformationId, this.#timers.get(arm.scheduleInformationId)?.generation ?? 0); return; }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.cancel(scheduleInformationId);
  }
  private async recover(): Promise<void> {
    let cursor: InformationId | undefined;
    do {
      const page = await this.#store.listOpen({ ...(cursor ? { after: cursor } : {}), limit: this.#batch });
      if (this.#state !== "starting") return;
      for (const arm of page.arms) { this.arm(arm.scheduleInformationId, arm.dueAt); if (Date.parse(arm.dueAt) <= this.#clock.now().getTime()) await this.fire(arm.scheduleInformationId, this.#timers.get(arm.scheduleInformationId)?.generation ?? 0); }
      cursor = page.nextCursor;
    } while (cursor !== undefined && this.#state === "starting");
    if (this.#state === "starting") this.#state = "started";
  }
  private arm(id: InformationId, dueAt: string): void {
    const previous = this.#timers.get(id); if (previous) this.#clock.clearTimeout(previous.handle);
    const generation = (previous?.generation ?? 0) + 1;
    const timer = { handle: undefined as unknown, generation, dueAt };
    const delay = Math.max(0, Date.parse(dueAt) - this.#clock.now().getTime());
    const scheduleNext = (): void => { timer.handle = this.#clock.setTimeout(() => void this.fire(id, generation), Math.min(delay, MAX_TIMEOUT)); };
    this.#timers.set(id, timer);
    if (delay !== 0) scheduleNext();
  }
  private cancel(id: InformationId): void { const timer = this.#timers.get(id); if (timer) this.#clock.clearTimeout(timer.handle); this.#timers.delete(id); }
  private async fire(id: InformationId, generation: number): Promise<void> {
    const timer = this.#timers.get(id); if (!timer || timer.generation !== generation || (this.#state !== "started" && this.#state !== "starting")) return;
    const remaining = Date.parse(timer.dueAt) - this.#clock.now().getTime();
    if (remaining > 0) { timer.handle = this.#clock.setTimeout(() => void this.fire(id, generation), Math.min(remaining, MAX_TIMEOUT)); return; }
    this.#timers.delete(id);
    const due = freezeInformationAtom({ informationId: this.#nextInformationId(), kind: oneShotDueInformationKind.kind, occurredAt: this.#clock.now().toISOString(), source: "core:scheduler", payload: { scheduleInformationId: id, dueAt: timer.dueAt, deliveredAt: this.#clock.now().toISOString() }, references: [{ relation: "core:status-of", informationId: id }] });
    const work = this.#store.emitDue({ scheduleInformationId: id, due } as OneShotDueCommit).catch(() => {
      if (this.#state === "started" || this.#state === "starting") {
        const current = this.#timers.get(id);
        if (current !== undefined && current.generation !== generation) return;
        timer.handle = this.#clock.setTimeout(() => void this.fire(id, generation), 1_000);
        this.#timers.set(id, timer);
      }
    }).finally(() => this.#inFlight.delete(work));
    this.#inFlight.add(work);
    await work;
  }
}
