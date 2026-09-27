/** 以纯视图渲染验证模型指标的周期选择、双 tier、分布和各类读取状态。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { modelRequestMetricsSchema } from "@kaguya/schema";

import { ModelMetricsView } from "./ModelMetricsPanel.js";

describe("model metrics dashboard", () => {
  it("renders comparable light and heavy summaries with unavailable cost", () => {
    const html = renderToStaticMarkup(
      <ModelMetricsView
        window="7d"
        state={{ loading: false, data: fixture() }}
        onWindowChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain("7 天");
    expect(html).toContain('aria-pressed="true">7 天');
    expect(html).toContain("light");
    expect(html).toContain("heavy");
    expect(html).toContain("平均输入");
    expect(html).toContain("P50 / P95");
    expect(html).toContain("2 次已结束调用没有可用");
    expect(html).toContain("暂不可用");
    expect(html).toContain("当前没有可信价格配置");
    expect(html.match(/model-call-chart/g)).toHaveLength(2);
  });

  it.each([
    [{ loading: true }, "正在读取模型调用指标"],
    [{ loading: false, error: "指标读取失败" }, "指标读取失败"],
    [{ loading: false, data: fixture(true) }, "所选周期暂无模型调用记录"],
  ])("renders read state %s", (state, text) => {
    const html = renderToStaticMarkup(
      <ModelMetricsView
        window="24h"
        state={state}
        onWindowChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(html).toContain(text);
  });
});

function fixture(empty = false) {
  const tier = (name: "light" | "heavy") => ({
    tier: name,
    requestCount: empty ? 0 : name === "light" ? 8 : 3,
    callsPerHour: empty ? 0 : name === "light" ? 0.33 : 0.13,
    outcomes: {
      completed: empty ? 0 : 1,
      failed: empty ? 0 : 1,
      cancelled: 0,
      pending: 0,
    },
    latencyMs: {
      sampleCount: empty ? 0 : 2,
      average: empty ? null : 1_500,
      p50: empty ? null : 1_000,
      p95: empty ? null : 2_000,
      buckets: [{ label: "<2s", upperBound: 2_000, count: empty ? 0 : 2 }],
    },
    tokens: {
      sampleCount: empty ? 0 : 1,
      missingCount: empty ? 0 : 2,
      averageInput: empty ? null : 100,
      averageOutput: empty ? null : 50,
      averageTotal: empty ? null : 150,
      p50Total: empty ? null : 150,
      p95Total: empty ? null : 150,
      buckets: [{ label: "<500", upperBound: 500, count: empty ? 0 : 1 }],
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
    series: [
      {
        startedAt: "2026-09-20T12:00:00.000Z",
        endedAt: "2026-09-20T18:00:00.000Z",
        light: empty ? 0 : 2,
        heavy: empty ? 0 : 1,
      },
    ],
    tiers: { light: tier("light"), heavy: tier("heavy") },
  });
}
