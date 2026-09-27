/** 工作台模型调用仪表盘：只读取聚合指标，不接触 Prompt、输出或配置凭据。 */
import type {
  ModelMetricHistogramBucket,
  ModelMetricsWindow,
  ModelRequestMetrics,
  ModelTierMetrics,
} from "@kaguya/schema";
import { useEffect, useState } from "react";

import { getModelRequestMetrics } from "./api.js";
import { Button } from "./components/ui.js";
import "./model-metrics.css";

const windows: readonly { id: ModelMetricsWindow; label: string }[] = [
  { id: "24h", label: "24 小时" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
];

interface MetricsReadState {
  readonly data?: ModelRequestMetrics;
  readonly error?: string;
  readonly loading: boolean;
}

export function ModelMetricsPanel({ token }: { token: string }) {
  const [window, setWindow] = useState<ModelMetricsWindow>("24h");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<MetricsReadState>({ loading: true });

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    void getModelRequestMetrics({ token }, window, controller.signal).then(
      (data) => setState({ data, loading: false }),
      (error) => {
        if (!controller.signal.aborted)
          setState({
            error: error instanceof Error ? error.message : "指标读取失败",
            loading: false,
          });
      },
    );
    return () => controller.abort();
  }, [token, window, revision]);

  return (
    <ModelMetricsView
      window={window}
      state={state}
      onWindowChange={setWindow}
      onRetry={() => setRevision((value) => value + 1)}
    />
  );
}

export function ModelMetricsView({
  window,
  state,
  onWindowChange,
  onRetry,
}: {
  window: ModelMetricsWindow;
  state: MetricsReadState;
  onWindowChange: (window: ModelMetricsWindow) => void;
  onRetry: () => void;
}) {
  const data = state.data;
  const scales = {
    calls: Math.max(
      1,
      ...(data?.series.flatMap((bucket) => [bucket.light, bucket.heavy]) ?? []),
    ),
    latency: Math.max(
      1,
      ...(data?.tiers.light.latencyMs.buckets.map((bucket) => bucket.count) ??
        []),
      ...(data?.tiers.heavy.latencyMs.buckets.map((bucket) => bucket.count) ??
        []),
    ),
    tokens: Math.max(
      1,
      ...(data?.tiers.light.tokens.buckets.map((bucket) => bucket.count) ?? []),
      ...(data?.tiers.heavy.tokens.buckets.map((bucket) => bucket.count) ?? []),
    ),
  };
  return (
    <section className="model-metrics" aria-labelledby="model-metrics-title">
      <header className="model-metrics-heading">
        <div>
          <h2 id="model-metrics-title">模型调用</h2>
          <p>按请求时间统计 light 与 heavy Model Task。</p>
        </div>
        <div className="model-metrics-window" aria-label="统计周期">
          {windows.map((option) => (
            <button
              type="button"
              key={option.id}
              aria-pressed={window === option.id}
              onClick={() => onWindowChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>
      {state.loading && !state.data ? (
        <p className="model-metrics-state" role="status">
          正在读取模型调用指标…
        </p>
      ) : state.error ? (
        <div className="model-metrics-state" role="alert">
          <p>{state.error}</p>
          <Button onClick={onRetry}>重新读取</Button>
        </div>
      ) : state.data &&
        state.data.tiers.light.requestCount === 0 &&
        state.data.tiers.heavy.requestCount === 0 ? (
        <p className="model-metrics-state">所选周期暂无模型调用记录。</p>
      ) : state.data ? (
        <div className="model-metrics-grid">
          <TierCard
            metrics={state.data.tiers.light}
            data={state.data}
            scales={scales}
          />
          <TierCard
            metrics={state.data.tiers.heavy}
            data={state.data}
            scales={scales}
          />
        </div>
      ) : null}
    </section>
  );
}

function TierCard({
  metrics,
  data,
  scales,
}: {
  metrics: ModelTierMetrics;
  data: ModelRequestMetrics;
  scales: { calls: number; latency: number; tokens: number };
}) {
  const tier = metrics.tier;
  const series = data.series.map((bucket) => ({
    ...bucket,
    count: bucket[tier],
  }));
  return (
    <article className={`model-tier-card model-tier-${tier}`}>
      <header>
        <div>
          <span className="model-tier-label">{tier}</span>
          <strong>{metrics.requestCount.toLocaleString("zh-CN")} 次</strong>
        </div>
        <span>平均 {formatNumber(metrics.callsPerHour)} 次/小时</span>
      </header>
      <CallDistribution series={series} maximum={scales.calls} tier={tier} />
      <dl className="model-outcomes">
        <Metric label="完成" value={metrics.outcomes.completed} />
        <Metric label="失败" value={metrics.outcomes.failed} />
        <Metric label="取消" value={metrics.outcomes.cancelled} />
        <Metric label="进行中" value={metrics.outcomes.pending} />
      </dl>
      <section className="model-distribution">
        <h3>延迟</h3>
        <dl className="model-summary-row">
          <Metric
            label="平均"
            value={formatDuration(metrics.latencyMs.average)}
          />
          <Metric label="P50" value={formatDuration(metrics.latencyMs.p50)} />
          <Metric label="P95" value={formatDuration(metrics.latencyMs.p95)} />
        </dl>
        <Histogram
          buckets={metrics.latencyMs.buckets}
          maximum={scales.latency}
        />
      </section>
      <section className="model-distribution">
        <h3>Token</h3>
        <dl className="model-summary-row model-token-summary">
          <Metric
            label="平均输入"
            value={formatToken(metrics.tokens.averageInput)}
          />
          <Metric
            label="平均输出"
            value={formatToken(metrics.tokens.averageOutput)}
          />
          <Metric
            label="平均总量"
            value={formatToken(metrics.tokens.averageTotal)}
          />
          <Metric
            label="P50 / P95"
            value={`${formatToken(metrics.tokens.p50Total)} / ${formatToken(metrics.tokens.p95Total)}`}
          />
        </dl>
        <Histogram buckets={metrics.tokens.buckets} maximum={scales.tokens} />
        {metrics.tokens.missingCount > 0 && (
          <p className="model-missing">
            {metrics.tokens.missingCount} 次已结束调用没有可用
            usage，未按零计入。
          </p>
        )}
      </section>
      <section className="model-cost">
        <h3>费用</h3>
        <strong>暂不可用</strong>
        <p>当前没有可信价格配置，因此不推测历史费用。</p>
      </section>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CallDistribution({
  series,
  maximum,
  tier,
}: {
  series: readonly { startedAt: string; endedAt: string; count: number }[];
  maximum: number;
  tier: "light" | "heavy";
}) {
  return (
    <div className="model-call-chart" aria-label={`${tier} 调用时间分布`}>
      {series.map((bucket) => (
        <span
          key={bucket.startedAt}
          className="model-call-bar"
          style={{
            height: `${Math.max(bucket.count ? 4 : 0, (bucket.count / maximum) * 100)}%`,
          }}
          title={`${displayDate(bucket.startedAt)}：${bucket.count} 次`}
        />
      ))}
      <span className="wb-sr-only">
        {series
          .map(
            (bucket) => `${displayDate(bucket.startedAt)} ${bucket.count} 次`,
          )
          .join("；")}
      </span>
    </div>
  );
}

function Histogram({
  buckets,
  maximum,
}: {
  buckets: readonly ModelMetricHistogramBucket[];
  maximum: number;
}) {
  return (
    <div className="model-histogram">
      {buckets.map((bucket) => (
        <div key={bucket.label}>
          <span>{bucket.label}</span>
          <span className="model-histogram-track">
            <span style={{ width: `${(bucket.count / maximum) * 100}%` }} />
          </span>
          <strong>{bucket.count}</strong>
        </div>
      ))}
    </div>
  );
}

function displayDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value < 1_000
    ? `${formatNumber(value)} ms`
    : `${formatNumber(value / 1_000)} s`;
}

function formatToken(value: number | null): string {
  return value === null ? "—" : formatNumber(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(
    value,
  );
}
