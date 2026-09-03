/**
 * 功能概述：执行持久 outbox 到结构化日志 sink 的提交后投影，不参与原子事务。
 * 主要职责：`projectPending` 串行化并合并同进程并发批次；`drainPending` 循环处理全部
 * 成功批次，供 Core 关闭时最终排空；单个 job 负责读取 atom、调用 sink 并更新 outbox。
 * 代码库关系：依赖 `InformationRepository` 的 pending/read/mark/failure API，由 Runtime
 * 创建并注入 `InformationCore`；sink 是单向日志端口，不能通过本路径注册新原子。
 * 输入输出与副作用：成功会标记 outbox 已投影；失败保留待重试并只走 bootstrap reporter。
 * drain 遇到任一失败批次即停止，避免同一永久失败 job 造成关闭阶段无限循环。
 */
import type { InformationAtom } from "@kaguya/schema";

import { InformationRepository } from "./information-repository.js";

export type InformationAtomLogSink = (atom: InformationAtom) => Promise<void>;

export interface InformationLogProjectionFailure {
  readonly informationId: string;
  readonly errorType: "atom_missing" | "sink_failed" | "outbox_failed";
}

export interface InformationLogProjectionRunnerOptions {
  readonly repository: InformationRepository;
  readonly sink: InformationAtomLogSink;
  readonly batchSize?: number;
  /** A bootstrap-only diagnostic path; it must not append an InformationAtom. */
  readonly reportFailure?: (
    failure: InformationLogProjectionFailure,
  ) => void | Promise<void>;
}

export class InformationLogProjectionRunner {
  readonly #repository: InformationRepository;
  readonly #sink: InformationAtomLogSink;
  readonly #batchSize: number;
  readonly #reportFailure:
    | ((failure: InformationLogProjectionFailure) => void | Promise<void>)
    | undefined;
  #batchPromise: Promise<ProjectionBatchResult> | undefined;
  #drainPromise: Promise<void> | undefined;

  constructor(options: InformationLogProjectionRunnerOptions) {
    this.#repository = options.repository;
    this.#sink = options.sink;
    this.#batchSize = options.batchSize ?? 100;
    this.#reportFailure = options.reportFailure;
  }

  /**
   * Drain one bounded batch. Failed jobs remain pending and are retried by a
   * later call (including after a process restart); atom persistence is never
   * rolled back because this method runs only after commit.
   */
  async projectPending(): Promise<void> {
    await this.runSharedBatch();
  }

  drainPending(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;
    this.#drainPromise = (async () => {
      while (true) {
        const result = await this.runSharedBatch();
        if (
          result.pendingCount === 0 ||
          result.failedCount > 0 ||
          result.pendingCount < this.#batchSize
        ) {
          return;
        }
      }
    })().finally(() => {
      this.#drainPromise = undefined;
    });
    return this.#drainPromise;
  }

  private runSharedBatch(): Promise<ProjectionBatchResult> {
    if (this.#batchPromise !== undefined) return this.#batchPromise;
    this.#batchPromise = this.runBatch().finally(() => {
      this.#batchPromise = undefined;
    });
    return this.#batchPromise;
  }

  private async runBatch(): Promise<ProjectionBatchResult> {
    const pending = await this.#repository.listPendingLogProjections(
      this.#batchSize,
    );
    let failedCount = 0;
    for (const job of pending) {
      try {
        const atom = await this.#repository.get(job.informationId);
        if (atom === undefined) {
          await this.#repository.recordLogProjectionFailure(
            job.informationId,
            "atom_missing",
          );
          await this.report({
            informationId: job.informationId,
            errorType: "atom_missing",
          });
          failedCount += 1;
          continue;
        }
        await this.#sink(atom as InformationAtom);
        await this.#repository.markLogProjectionDelivered(job.informationId);
      } catch {
        try {
          await this.#repository.recordLogProjectionFailure(
            job.informationId,
            "sink_failed",
          );
        } catch {
          await this.report({
            informationId: job.informationId,
            errorType: "outbox_failed",
          });
          failedCount += 1;
          continue;
        }
        await this.report({
          informationId: job.informationId,
          errorType: "sink_failed",
        });
        failedCount += 1;
      }
    }
    return { pendingCount: pending.length, failedCount };
  }

  private async report(
    failure: InformationLogProjectionFailure,
  ): Promise<void> {
    try {
      await this.#reportFailure?.(failure);
    } catch {
      // Diagnostics are intentionally best-effort and cannot alter ledger facts.
    }
  }
}

interface ProjectionBatchResult {
  readonly pendingCount: number;
  readonly failedCount: number;
}
