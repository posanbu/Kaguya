/**
 * Model Task 指标契约在 PGlite 与真实 PostgreSQL 上复用同一组事实，确保查询只按
 * requested 计数，并通过 status-of 终态计算结果、延迟与可用 token。
 */
import { afterEach, expect, it } from "vitest";

import { ModelRequestMetricsRepository, type KaguyaDatabase } from "./index.js";
import {
  createPostgresTestingDatabase,
  createTestingDatabase,
} from "./testing.js";

const now = new Date("2026-09-27T12:00:00.000Z");
const postgresUrl = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
const createDatabase = postgresUrl
  ? () => createPostgresTestingDatabase(postgresUrl)
  : createTestingDatabase;
let database: KaguyaDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

it("aggregates light and heavy requests without treating missing usage as zero", async () => {
  database = await createDatabase();
  await database.prepareSchema();
  await database.information.synchronizeKinds([
    "core.model.task.requested",
    "core.model.task.completed",
    "core.model.task.failed",
    "core.model.task.cancelled",
  ]);

  await addRequest("light-completed", "light", "2026-09-27T11:10:00.000Z");
  await addTerminal(
    "light-completed-terminal",
    "core.model.task.completed",
    "light-completed",
    1_000,
    { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  );
  await addRequest("light-failed", "light", "2026-09-27T10:10:00.000Z");
  await addTerminal(
    "light-failed-terminal",
    "core.model.task.failed",
    "light-failed",
    3_000,
    { promptTokens: 200, completionTokens: 100 },
  );
  await addRequest("light-pending", "light", "2026-09-27T09:10:00.000Z");
  await addRequest("heavy-cancelled", "heavy", "2026-09-27T06:10:00.000Z");
  await addTerminal(
    "heavy-cancelled-terminal",
    "core.model.task.cancelled",
    "heavy-cancelled",
    500,
  );
  await addRequest("heavy-completed", "heavy", "2026-09-26T13:00:00.000Z");
  await addTerminal(
    "heavy-completed-terminal",
    "core.model.task.completed",
    "heavy-completed",
    9_000,
    { totalTokens: 500 },
  );
  await addRequest("outside-window", "light", "2026-08-20T00:00:00.000Z");

  const metrics = await new ModelRequestMetricsRepository(
    database.sql,
    () => now,
  ).read("24h");

  expect(metrics.window).toEqual({
    id: "24h",
    startedAt: "2026-09-26T12:00:00.000Z",
    endedAt: now.toISOString(),
    bucketDurationMs: 3_600_000,
  });
  expect(metrics.series).toHaveLength(24);
  expect(metrics.series.reduce((sum, bucket) => sum + bucket.light, 0)).toBe(3);
  expect(metrics.series.reduce((sum, bucket) => sum + bucket.heavy, 0)).toBe(2);
  expect(metrics.tiers.light).toMatchObject({
    requestCount: 3,
    callsPerHour: 0.13,
    outcomes: { completed: 1, failed: 1, cancelled: 0, pending: 1 },
    latencyMs: { sampleCount: 2, average: 2_000, p50: 2_000, p95: 2_900 },
    tokens: {
      sampleCount: 2,
      missingCount: 0,
      averageInput: 150,
      averageOutput: 75,
      averageTotal: 225,
      p50Total: 225,
      p95Total: 292.5,
    },
    cost: { status: "unavailable", reason: "pricing-not-configured" },
  });
  expect(metrics.tiers.heavy).toMatchObject({
    requestCount: 2,
    outcomes: { completed: 1, failed: 0, cancelled: 1, pending: 0 },
    latencyMs: { sampleCount: 2, average: 4_750 },
    tokens: {
      sampleCount: 1,
      missingCount: 1,
      averageInput: null,
      averageOutput: null,
      averageTotal: 500,
    },
  });
  expect(
    metrics.tiers.light.tokens.buckets.reduce(
      (sum, bucket) => sum + bucket.count,
      0,
    ),
  ).toBe(2);

  const sevenDays = await new ModelRequestMetricsRepository(
    database.sql,
    () => now,
  ).read("7d");
  const thirtyDays = await new ModelRequestMetricsRepository(
    database.sql,
    () => now,
  ).read("30d");
  expect(sevenDays.window.bucketDurationMs).toBe(6 * 3_600_000);
  expect(sevenDays.series).toHaveLength(28);
  expect(thirtyDays.window.bucketDurationMs).toBe(24 * 3_600_000);
  expect(thirtyDays.series).toHaveLength(30);
  expect(
    thirtyDays.tiers.light.requestCount + thirtyDays.tiers.heavy.requestCount,
  ).toBe(5);
}, 30_000);

async function addRequest(id: string, tier: "light" | "heavy", at: string) {
  await addAtom(id, "core.model.task.requested", at, {
    selectionPolicy: { tier },
  });
}

async function addTerminal(
  id: string,
  kind:
    | "core.model.task.completed"
    | "core.model.task.failed"
    | "core.model.task.cancelled",
  requestId: string,
  durationMs: number,
  usage?: Record<string, number>,
) {
  await addAtom(id, kind, now.toISOString(), {
    durationMs,
    ...(usage === undefined ? {} : { usage }),
  });
  await database!.sql.query(
    `INSERT INTO information_references
       (information_id, ordinal, relation, target_information_id)
     VALUES ($1, 0, 'core:status-of', $2)`,
    [id, requestId],
  );
}

async function addAtom(
  id: string,
  kind: string,
  occurredAt: string,
  payload: Record<string, unknown>,
) {
  await database!.sql.query(
    `INSERT INTO information_atoms
       (information_id, kind, occurred_at, source, payload)
     VALUES ($1, $2, $3, 'test:model-metrics', $4::jsonb)`,
    [id, kind, occurredAt, JSON.stringify(payload)],
  );
}
