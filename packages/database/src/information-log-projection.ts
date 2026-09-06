/**
 * Durable, post-commit information-log projection runner.
 *
 * It deliberately receives a one-way sink instead of a Core or Ledger writer.
 * A sink can write to Pino/console, but it cannot append another atom through
 * this path, so projection failures cannot recurse into new log atoms.
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
    const pending = await this.#repository.listPendingLogProjections(
      this.#batchSize,
    );
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
          continue;
        }
        await this.report({
          informationId: job.informationId,
          errorType: "sink_failed",
        });
      }
    }
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
