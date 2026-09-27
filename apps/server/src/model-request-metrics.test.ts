/** 验证模型指标端点的认证、严格窗口参数、缓存策略和数据库故障边界。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modelRequestMetricsSchema,
  type ModelMetricsWindow,
  type ModelRequestMetrics,
} from "@kaguya/schema";

import { createHttpApplication } from "./app.js";
import type { ServerConfig } from "./config.js";

const token = "metrics-test-token";
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 3000,
  gatewayToken: token,
  corsOrigins: [],
  trustProxy: false,
  rateLimitMax: 1_000,
  rateLimitWindowMs: 60_000,
  databaseUrl: "postgresql://localhost/test",
  configRoot: "/tmp/model-metrics-test",
  development: false,
  webDistPath: "/tmp/web",
  logLevel: "silent",
  logFormat: "json",
  inboundAllowlist: [],
  outboundAllowlist: [],
  napcat: { enabled: false, adapterId: "test", reconnectMs: 3_000 },
};
const applications: Awaited<ReturnType<typeof createHttpApplication>>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("model request metrics endpoint", () => {
  it("requires the gateway token before reading metrics", async () => {
    const read = vi.fn<ModelMetricsReader>();
    const app = await create({ read });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/model-requests?window=24h",
    });

    expect(response.statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a stable no-store DTO for the selected window", async () => {
    const read = vi
      .fn<ModelMetricsReader>()
      .mockResolvedValue(metricsFixture());
    const app = await create({ read });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/model-requests?window=7d",
      headers: authorization(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ data: metricsFixture() });
    expect(read).toHaveBeenCalledWith("7d");
  });

  it.each([
    "/api/v1/metrics/model-requests?window=1h",
    "/api/v1/metrics/model-requests?window=24h&extra=true",
    "/api/v1/metrics/model-requests",
  ])("rejects an invalid query: %s", async (url) => {
    const read = vi.fn<ModelMetricsReader>();
    const app = await create({ read });
    const response = await app.inject({
      method: "GET",
      url,
      headers: authorization(),
    });

    expect(response.statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports unavailable and failed readers without leaking internals", async () => {
    const unavailable = await create();
    const unavailableResponse = await unavailable.inject({
      method: "GET",
      url: "/api/v1/metrics/model-requests?window=30d",
      headers: authorization(),
    });
    expect(unavailableResponse.statusCode).toBe(503);

    const failing = await create({
      read: vi
        .fn<ModelMetricsReader>()
        .mockRejectedValue(new Error("postgresql://secret")),
    });
    const failedResponse = await failing.inject({
      method: "GET",
      url: "/api/v1/metrics/model-requests?window=30d",
      headers: authorization(),
    });
    expect(failedResponse.statusCode).toBe(500);
    expect(failedResponse.body).not.toContain("postgresql://secret");
  });
});

type ModelMetricsReader = (
  window: ModelMetricsWindow,
) => Promise<ModelRequestMetrics>;

async function create(service?: { read: ModelMetricsReader }) {
  const app = await createHttpApplication({
    config,
    ...(service === undefined ? {} : { modelRequestMetrics: () => service }),
  });
  applications.push(app);
  return app;
}

function authorization() {
  return { authorization: `Bearer ${token}` };
}

function metricsFixture() {
  const emptyDistribution = {
    sampleCount: 0,
    average: null,
    p50: null,
    p95: null,
    buckets: [{ label: "all", upperBound: null, count: 0 }],
  };
  const tier = (name: "light" | "heavy") => ({
    tier: name,
    requestCount: 0,
    callsPerHour: 0,
    outcomes: { completed: 0, failed: 0, cancelled: 0, pending: 0 },
    latencyMs: emptyDistribution,
    tokens: {
      sampleCount: 0,
      missingCount: 0,
      averageInput: null,
      averageOutput: null,
      averageTotal: null,
      p50Total: null,
      p95Total: null,
      buckets: [{ label: "all", upperBound: null, count: 0 }],
    },
    cost: { status: "unavailable", reason: "pricing-not-configured" },
  });
  return modelRequestMetricsSchema.parse({
    version: 1,
    window: {
      id: "7d",
      startedAt: "2026-09-20T12:00:00.000Z",
      endedAt: "2026-09-27T12:00:00.000Z",
      bucketDurationMs: 21_600_000,
    },
    series: [],
    tiers: { light: tier("light"), heavy: tier("heavy") },
  });
}
