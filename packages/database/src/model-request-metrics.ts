/**
 * 从 append-only Information Ledger 读取 Model Task 聚合指标。查询只扫描所选时间窗内
 * 的 requested 原子，并通过 status-of 反向引用取得唯一终态；不会读取 Prompt 或输出。
 */
import {
  modelRequestMetricsSchema,
  type ModelMetricHistogramBucket,
  type ModelMetricsWindow,
  type ModelRequestMetrics,
  type ModelTierMetrics,
} from "@kaguya/schema";

import type { SqlDatabase } from "./driver.js";

type Tier = "light" | "heavy";
type TerminalKind =
  | "core.model.task.completed"
  | "core.model.task.failed"
  | "core.model.task.cancelled";

interface ModelRequestMetricRow extends Record<string, unknown> {
  information_id: string;
  occurred_at: string;
  request_payload: unknown;
  terminal_kind: TerminalKind | null;
  terminal_payload: unknown | null;
}

const windowDefinitions = {
  "24h": { durationMs: 24 * 60 * 60 * 1000, bucketDurationMs: 60 * 60 * 1000 },
  "7d": {
    durationMs: 7 * 24 * 60 * 60 * 1000,
    bucketDurationMs: 6 * 60 * 60 * 1000,
  },
  "30d": {
    durationMs: 30 * 24 * 60 * 60 * 1000,
    bucketDurationMs: 24 * 60 * 60 * 1000,
  },
} as const satisfies Record<
  ModelMetricsWindow,
  { durationMs: number; bucketDurationMs: number }
>;

const latencyBounds = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const tokenBounds = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

export class ModelRequestMetricsRepository {
  constructor(
    private readonly database: Pick<SqlDatabase, "query">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(window: ModelMetricsWindow): Promise<ModelRequestMetrics> {
    const definition = windowDefinitions[window];
    const endedAt = this.now();
    const startedAt = new Date(endedAt.getTime() - definition.durationMs);
    const rows = await this.database.query<ModelRequestMetricRow>(
      `SELECT requested.information_id,
              requested.occurred_at,
              requested.payload AS request_payload,
              terminal.kind AS terminal_kind,
              terminal.payload AS terminal_payload
       FROM information_atoms AS requested
       LEFT JOIN LATERAL (
         SELECT result.kind, result.payload, result.occurred_at, result.information_id
         FROM information_references AS reference
         JOIN information_atoms AS result
           ON result.information_id = reference.information_id
         WHERE reference.target_information_id = requested.information_id
           AND reference.relation = 'core:status-of'
           AND result.kind = ANY($3::text[])
         ORDER BY result.occurred_at DESC, result.information_id DESC
         LIMIT 1
       ) AS terminal ON true
       WHERE requested.kind = 'core.model.task.requested'
         AND requested.occurred_at >= $1
         AND requested.occurred_at < $2
       ORDER BY requested.occurred_at ASC, requested.information_id ASC`,
      [
        startedAt.toISOString(),
        endedAt.toISOString(),
        [
          "core.model.task.completed",
          "core.model.task.failed",
          "core.model.task.cancelled",
        ],
      ],
    );

    const buckets = Array.from(
      {
        length: Math.ceil(definition.durationMs / definition.bucketDurationMs),
      },
      (_, index) => {
        const bucketStart = new Date(
          startedAt.getTime() + index * definition.bucketDurationMs,
        );
        return {
          startedAt: bucketStart.toISOString(),
          endedAt: new Date(
            Math.min(
              endedAt.getTime(),
              bucketStart.getTime() + definition.bucketDurationMs,
            ),
          ).toISOString(),
          light: 0,
          heavy: 0,
        };
      },
    );
    const samples: Record<Tier, ModelSample[]> = { light: [], heavy: [] };

    for (const row of rows.rows) {
      const request = record(row.request_payload);
      const selection = record(request?.selectionPolicy);
      const tier = selection?.tier;
      if (tier !== "light" && tier !== "heavy") continue;
      const occurredAt = Date.parse(row.occurred_at);
      const bucketIndex = Math.floor(
        (occurredAt - startedAt.getTime()) / definition.bucketDurationMs,
      );
      const bucket = buckets[bucketIndex];
      if (bucket) bucket[tier] += 1;
      const terminal = record(row.terminal_payload);
      const durationMs = finiteNonnegative(terminal?.durationMs);
      const usage = readUsage(record(terminal?.usage));
      samples[tier].push({
        terminalKind: row.terminal_kind,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(usage === undefined ? {} : { usage }),
      });
    }

    return modelRequestMetricsSchema.parse({
      version: 1,
      window: {
        id: window,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        bucketDurationMs: definition.bucketDurationMs,
      },
      series: buckets,
      tiers: {
        light: summarizeTier("light", samples.light, definition.durationMs),
        heavy: summarizeTier("heavy", samples.heavy, definition.durationMs),
      },
    });
  }
}

interface UsageSample {
  input?: number;
  output?: number;
  total?: number;
}

interface ModelSample {
  terminalKind: TerminalKind | null;
  durationMs?: number;
  usage?: UsageSample;
}

function summarizeTier(
  tier: Tier,
  samples: readonly ModelSample[],
  durationMs: number,
): ModelTierMetrics {
  const ended = samples.filter((sample) => sample.terminalKind !== null);
  const latencies = ended.flatMap((sample) =>
    sample.durationMs === undefined ? [] : [sample.durationMs],
  );
  const usage = ended.flatMap((sample) =>
    sample.usage === undefined ? [] : [sample.usage],
  );
  const input = usage.flatMap((sample) =>
    sample.input === undefined ? [] : [sample.input],
  );
  const output = usage.flatMap((sample) =>
    sample.output === undefined ? [] : [sample.output],
  );
  const total = usage.flatMap((sample) =>
    sample.total === undefined ? [] : [sample.total],
  );
  return {
    tier,
    requestCount: samples.length,
    callsPerHour: rounded(samples.length / (durationMs / 3_600_000)),
    outcomes: {
      completed: countKind(samples, "core.model.task.completed"),
      failed: countKind(samples, "core.model.task.failed"),
      cancelled: countKind(samples, "core.model.task.cancelled"),
      pending: samples.filter((sample) => sample.terminalKind === null).length,
    },
    latencyMs: {
      sampleCount: latencies.length,
      average: average(latencies),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      buckets: histogram(latencies, latencyBounds, (bound) =>
        bound === null ? "≥30s" : `<${formatMilliseconds(bound)}`,
      ),
    },
    tokens: {
      sampleCount: usage.length,
      missingCount: ended.length - usage.length,
      averageInput: average(input),
      averageOutput: average(output),
      averageTotal: average(total),
      p50Total: percentile(total, 0.5),
      p95Total: percentile(total, 0.95),
      buckets: histogram(total, tokenBounds, (bound) =>
        bound === null ? "≥16k" : `<${formatTokenBound(bound)}`,
      ),
    },
    cost: { status: "unavailable", reason: "pricing-not-configured" },
  };
}

function readUsage(
  value: Record<string, unknown> | undefined,
): UsageSample | undefined {
  if (!value) return undefined;
  const input =
    finiteNonnegative(value.inputTokens) ??
    finiteNonnegative(value.promptTokens);
  const output =
    finiteNonnegative(value.outputTokens) ??
    finiteNonnegative(value.completionTokens);
  const total =
    finiteNonnegative(value.totalTokens) ??
    (input !== undefined && output !== undefined ? input + output : undefined);
  return input === undefined && output === undefined && total === undefined
    ? undefined
    : {
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(total === undefined ? {} : { total }),
      };
}

function histogram(
  values: readonly number[],
  bounds: readonly number[],
  label: (bound: number | null) => string,
): ModelMetricHistogramBucket[] {
  const buckets = [...bounds, null].map((upperBound) => ({
    label: label(upperBound),
    upperBound,
    count: 0,
  }));
  for (const value of values) {
    const index = bounds.findIndex((bound) => value < bound);
    buckets[index < 0 ? buckets.length - 1 : index]!.count += 1;
  }
  return buckets;
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value =
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  return rounded(value);
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function countKind(
  samples: readonly ModelSample[],
  kind: TerminalKind,
): number {
  return samples.filter((sample) => sample.terminalKind === kind).length;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMilliseconds(value: number): string {
  return value < 1_000 ? `${value}ms` : `${value / 1_000}s`;
}

function formatTokenBound(value: number): string {
  return value < 1_000 ? String(value) : `${value / 1_000}k`;
}
