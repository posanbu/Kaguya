/**
 * 模型调用仪表盘的稳定 wire contract。统计以 Model Task 请求时间归属窗口，
 * 只暴露聚合后的频率、耗时和 token，不包含 Prompt、模型输出或凭据。
 */
import { z } from "zod";

export const modelMetricsWindowSchema = z.enum(["24h", "7d", "30d"]);
export type ModelMetricsWindow = z.infer<typeof modelMetricsWindowSchema>;

const histogramBucketSchema = z
  .object({
    label: z.string().min(1),
    upperBound: z.number().nonnegative().nullable(),
    count: z.number().int().nonnegative(),
  })
  .strict();

const distributionSchema = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    average: z.number().nonnegative().nullable(),
    p50: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable(),
    buckets: z.array(histogramBucketSchema),
  })
  .strict();

const modelTierMetricsSchema = z
  .object({
    tier: z.enum(["light", "heavy"]),
    requestCount: z.number().int().nonnegative(),
    callsPerHour: z.number().nonnegative(),
    outcomes: z
      .object({
        completed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
    latencyMs: distributionSchema,
    tokens: z
      .object({
        sampleCount: z.number().int().nonnegative(),
        missingCount: z.number().int().nonnegative(),
        averageInput: z.number().nonnegative().nullable(),
        averageOutput: z.number().nonnegative().nullable(),
        averageTotal: z.number().nonnegative().nullable(),
        p50Total: z.number().nonnegative().nullable(),
        p95Total: z.number().nonnegative().nullable(),
        buckets: z.array(histogramBucketSchema),
      })
      .strict(),
    cost: z
      .object({
        status: z.literal("unavailable"),
        reason: z.literal("pricing-not-configured"),
      })
      .strict(),
  })
  .strict();

export const modelRequestMetricsSchema = z
  .object({
    version: z.literal(1),
    window: z
      .object({
        id: modelMetricsWindowSchema,
        startedAt: z.iso.datetime({ offset: true }),
        endedAt: z.iso.datetime({ offset: true }),
        bucketDurationMs: z.number().int().positive(),
      })
      .strict(),
    series: z.array(
      z
        .object({
          startedAt: z.iso.datetime({ offset: true }),
          endedAt: z.iso.datetime({ offset: true }),
          light: z.number().int().nonnegative(),
          heavy: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    tiers: z
      .object({
        light: modelTierMetricsSchema,
        heavy: modelTierMetricsSchema,
      })
      .strict(),
  })
  .strict();

export type ModelRequestMetrics = z.infer<typeof modelRequestMetricsSchema>;
export type ModelTierMetrics = z.infer<typeof modelTierMetricsSchema>;
export type ModelMetricHistogramBucket = z.infer<typeof histogramBucketSchema>;
