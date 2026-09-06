/**
 * 功能概述：把已提交的 durable delivery 变成有界、可重放的 handler 执行。
 * 主要职责：start 登记完整订阅集合；每轮公平尝试各订阅一个 claim；失败有界 retry/exhaust，
 * stop 停止领取、传播 abort 并有界 drain。lease 到期的迟到任务由 Core/数据库 fencing 拒绝。
 * 代码库关系：仅依赖 Core 与可靠 ledger 端口；Host/Runtime 安装订阅，不把业务策略写入执行器。
 * 输入输出与副作用：后台轮询执行持久化 I/O，所有 rejection 均被消费；不记录正文或原始错误。
 */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import type { InformationCore } from "./information-core.js";
import type {
  InformationClaim,
  ReliableInformationLedger,
} from "./reliable-types.js";
export interface ReliableInformationSubscription {
  readonly subscriptionId: string;
  readonly kind: string;
  handle(
    atom: DeepReadonly<InformationAtom>,
    signal: AbortSignal,
  ): Promise<void> | void;
}
export interface ReliableInformationRunnerOptions {
  readonly core: InformationCore;
  readonly subscriptions: readonly ReliableInformationSubscription[];
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly pollIntervalMs?: number;
  readonly drainTimeoutMs?: number;
}
export class ReliableInformationRunner {
  readonly #ledger: ReliableInformationLedger;
  readonly #options: ReliableInformationRunnerOptions;
  readonly #shutdown = new AbortController();
  #running = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #cycle: Promise<void> | undefined;
  #start: Promise<void> | undefined;
  #stop: Promise<void> | undefined;
  constructor(options: ReliableInformationRunnerOptions) {
    this.#options = options;
    if (!options.core.store.reliable)
      throw new Error("Reliable information ledger is required");
    this.#ledger = options.core.store.reliable;
    for (const [value, min, max] of [
      [options.leaseMs ?? 30000, 1, 86400000],
      [options.maxAttempts ?? 3, 1, 100],
      [options.retryDelayMs ?? 100, 0, 86400000],
      [options.pollIntervalMs ?? 25, 1, 60000],
      [options.drainTimeoutMs ?? 5000, 0, 60000],
    ]) {
      if (!Number.isSafeInteger(value) || value! < min! || value! > max!)
        throw new Error("Invalid reliable execution bounds");
    }
  }
  start(): Promise<void> {
    if (this.#start) return this.#start;
    if (this.#started || this.#shutdown.signal.aborted)
      return Promise.reject(new Error("Reliable runner cannot restart"));
    this.#started = true;
    this.#start = (async () => {
      await this.#ledger.configureSubscriptions(this.#options.subscriptions);
      if (this.#shutdown.signal.aborted) return;
      this.#running = true;
      this.schedule(0);
    })();
    return this.#start;
  }
  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    this.#running = false;
    clearTimeout(this.#timer);
    this.#shutdown.abort(new Error("Runtime shutdown"));
    this.#stop = (async () => {
      // shutdown 不改 activation 配置：与崩溃相同，保留离线期间的持久投递。
      // 下次 start 的完整 Catalog 才负责显式禁用订阅。
      await boundedWait(
        Promise.allSettled([this.#start, this.#cycle]),
        this.#options.drainTimeoutMs ?? 5000,
      );
    })();
    return this.#stop;
  }
  private schedule(delay: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#cycle = Promise.allSettled(
        this.#options.subscriptions.map((subscription) =>
          this.consume(subscription),
        ),
      ).then(() => undefined);
      void this.#cycle.finally(() =>
        this.schedule(this.#options.pollIntervalMs ?? 25),
      );
    }, delay);
    this.#timer.unref?.();
  }
  private async consume(
    subscription: ReliableInformationSubscription,
  ): Promise<void> {
    if (!this.#running) return;
    const claim = await this.#ledger.claim(
      subscription.subscriptionId,
      this.#options.leaseMs ?? 30000,
    );
    if (!claim) return;
    if (!this.#running) {
      await this.#ledger.release(claim);
      return;
    }
    const expired = new AbortController();
    const leaseTimer = setTimeout(
      () => expired.abort(new Error("Information lease expired")),
      Math.max(0, new Date(claim.leaseUntil).getTime() - Date.now()),
    );
    const signal = AbortSignal.any([this.#shutdown.signal, expired.signal]);
    let removeAbort = () => {};
    try {
      if (claim.attempt > (this.#options.maxAttempts ?? 3)) {
        await this.#options.core.exhaustClaim({ ...claim, signal });
        return;
      }
      const atom = await this.#options.core.get(claim.informationId);
      if (!atom) throw new Error("Durable source missing");
      signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      });
      const work = this.#options.core.withClaim(claim, signal, async () =>
        subscription.handle(atom, signal),
      );
      await Promise.race([work, aborted]);
      signal.throwIfAborted();
      await this.#ledger.ack(claim);
    } catch {
      await this.fail(claim, signal);
    } finally {
      removeAbort();
      clearTimeout(leaseTimer);
    }
  }
  private async fail(
    claim: InformationClaim,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#shutdown.signal.aborted) {
      await this.#ledger.release(claim);
      return;
    }
    if (signal.aborted) return; // 过期 claim 留给下一次领取，不能由旧持有者更改。
    if (claim.attempt >= (this.#options.maxAttempts ?? 3)) {
      await this.#options.core.exhaustClaim({ ...claim, signal });
      return;
    }
    await this.#ledger.retry(claim, this.#options.retryDelayMs ?? 100);
  }
}
async function boundedWait(
  work: Promise<unknown> | undefined,
  ms: number,
): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
