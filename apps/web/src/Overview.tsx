/**
 * 功能概述：工作台根路径的只读系统概览，分别回答 Runtime 与 Adapter 是否就绪。
 * 主要职责：Overview 读取安全接入快照；OverviewTile 用图标与核心状态快速表达就绪度。
 * useRead 在重试、Token 变化及卸载时丢弃过期结果。
 * 代码库关系：App 挂载本页，复用 api.ts 安全 DTO 和 #144 基础组件与导航回调。
 * 输入输出与副作用：只发 GET，不读取凭据、不应用配置、不发送消息；共享接入请求的
 * Runtime 与 Adapter 分开显示，读取失败不会推断为停机。
 */
import {
  Activity,
  Cable,
  Globe2,
  ServerCog,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getAdapterStatus } from "./api.js";
import { Button, PageHeader } from "./components/ui.js";
import "./overview.css";

type ReadState<T> = { data?: T; error: boolean; loading: boolean };
function useRead<T>(token: string, load: (token: string) => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState<T>>({
    error: false,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState({ error: false, loading: true });
    void load(token).then(
      (data) => {
        if (live) setState({ data, error: false, loading: false });
      },
      () => {
        if (live) setState({ error: true, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [token, load, revision]);
  return { ...state, retry: () => setRevision((value) => value + 1) };
}
const readAdapters = (token: string) =>
  getAdapterStatus({ token }, new AbortController().signal);
const labels: Record<string, string> = {
  ready: "可接收消息",
  runtime_unavailable: "消息入口不可用",
  stopping: "消息入口暂停中",
  configuration_not_ready: "AI 配置未就绪",
  database_unavailable: "数据库不可用",
  runtime_start_failed: "Runtime 启动失败",
  disabled: "已禁用",
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  failed: "失败",
  connected: "已连接",
  connecting: "连接中",
  retrying: "等待重连",
  disconnected: "已断开",
  not_applicable: "无需连接",
  configuration_invalid: "配置无效",
  connection_failed: "连接失败",
  start_failed: "启动失败",
  stop_failed: "停止失败",
};
const label = (value: string) => labels[value] ?? value;
type TileTone = "neutral" | "success" | "warning" | "error";

function OverviewTile({
  title,
  status,
  tone,
  icon: Icon,
  onClick,
  detail,
  meta,
}: {
  title: string;
  status: string;
  tone: TileTone;
  icon: LucideIcon;
  onClick?: (() => unknown) | undefined;
  detail?: string | undefined;
  meta?: string | undefined;
}) {
  return (
    <button
      type="button"
      className={`overview-tile overview-tile-${tone}`}
      onClick={onClick}
      disabled={!onClick}
      aria-label={`${title}：${status}${meta ? `，${meta}` : ""}${onClick ? "，打开" : ""}`}
    >
      <span className="overview-tile-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="overview-tile-title">{title}</span>
      <strong className="overview-tile-status">{status}</strong>
      {meta ? <span className="overview-tile-meta">{meta}</span> : null}
      {detail && <span className="wb-sr-only">{detail}</span>}
    </button>
  );
}

function lifecycleTone(value: string): TileTone {
  if (value === "running") return "success";
  if (value === "starting" || value === "stopping") return "warning";
  if (value === "failed" || value === "stopped") return "error";
  return "neutral";
}

function adapterStatus(adapter: {
  enabled: boolean;
  lifecycle: string;
  connectivity: string;
  errorType?: string;
}) {
  if (!adapter.enabled) return { label: "已禁用", tone: "neutral" as const };
  if (adapter.errorType)
    return { label: label(adapter.errorType), tone: "error" as const };
  if (adapter.lifecycle !== "running")
    return {
      label: label(adapter.lifecycle),
      tone: lifecycleTone(adapter.lifecycle),
    };
  if (adapter.connectivity === "connected")
    return { label: "已连接", tone: "success" as const };
  if (adapter.connectivity === "not_applicable")
    return { label: "运行中", tone: "success" as const };
  return {
    label: label(adapter.connectivity),
    tone:
      adapter.connectivity === "connecting" ||
      adapter.connectivity === "retrying"
        ? ("warning" as const)
        : ("error" as const),
  };
}

function adapterTitle(type: string) {
  if (type.toLowerCase() === "napcat") return "NapCat";
  if (type.toLowerCase() === "web") return "Web";
  return type;
}

export function napCatEndpointLabel(wsUrl: string | undefined) {
  if (!wsUrl) return undefined;
  try {
    const endpoint = new URL(wsUrl);
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:")
      return undefined;
    const protocol = endpoint.protocol.slice(0, -1).toUpperCase();
    const port = endpoint.port || (endpoint.protocol === "wss:" ? "443" : "80");
    return `${protocol} · ${port}`;
  } catch {
    return undefined;
  }
}

function adapterOrder(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "web") return 0;
  if (normalized === "napcat") return 1;
  return 2;
}

export function Overview({
  token,
  navigate,
  onConfigureNapCat,
  napCatWsUrl,
  napCatEndpointState,
  focusAdapters = false,
}: {
  token: string;
  navigate: (path: string) => unknown;
  onConfigureNapCat: () => unknown;
  napCatWsUrl?: string | undefined;
  napCatEndpointState: "loading" | "ready" | "error";
  focusAdapters?: boolean;
}) {
  const adapters = useRead(token, readAdapters);
  const runtime = adapters.data?.runtime;
  const adapterHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusAdapters) return;
    adapterHeading.current?.scrollIntoView({ block: "start" });
    adapterHeading.current?.focus({ preventScroll: true });
  }, [focusAdapters]);
  return (
    <>
      <PageHeader
        title="概览"
        actions={
          <Button
            onClick={() => {
              adapters.retry();
            }}
          >
            刷新概览
          </Button>
        }
      />
      <div className="overview-grid" aria-live="polite">
        <OverviewTile
          title="Runtime"
          status={
            adapters.loading
              ? "读取中"
              : adapters.error || !runtime
                ? "状态未知"
                : label(runtime.reason ?? runtime.ingress)
          }
          tone={
            adapters.loading
              ? "neutral"
              : adapters.error || !runtime
                ? "error"
                : runtime.ingress === "ready"
                  ? "success"
                  : runtime.ingress === "stopping"
                    ? "warning"
                    : "error"
          }
          icon={Activity}
          detail={
            adapters.error
              ? "Runtime 状态读取失败，可刷新概览重试。"
              : undefined
          }
          onClick={() => navigate("/profiles")}
        />
        <OverviewTile
          title="Adapter"
          status={
            adapters.loading
              ? "读取中"
              : adapters.error || !adapters.data
                ? "状态未知"
                : label(adapters.data.adapterHostState)
          }
          tone={
            adapters.loading
              ? "neutral"
              : adapters.error || !adapters.data
                ? "error"
                : lifecycleTone(adapters.data.adapterHostState)
          }
          icon={ServerCog}
          detail={
            adapters.error
              ? "Adapter 状态读取失败，可刷新概览重试。"
              : undefined
          }
          onClick={adapters.data ? () => navigate("/adapters") : undefined}
        />
      </div>
      <section
        className="overview-adapter-section"
        aria-labelledby="overview-adapter-title"
      >
        <h2 id="overview-adapter-title" ref={adapterHeading} tabIndex={-1}>
          接入
        </h2>
        <div className="overview-grid overview-adapter-grid" aria-live="polite">
          {adapters.data?.adapters
            .toSorted(
              (left, right) =>
                adapterOrder(left.type) - adapterOrder(right.type),
            )
            .map((adapter) => {
              const status = adapterStatus(adapter);
              const type = adapter.type.toLowerCase();
              return (
                <OverviewTile
                  key={adapter.adapterId}
                  title={adapterTitle(adapter.type)}
                  status={status.label}
                  tone={status.tone}
                  icon={type === "web" ? Globe2 : Cable}
                  detail={`Adapter ${adapter.adapterId}`}
                  meta={
                    type === "napcat"
                      ? napCatEndpointState === "loading"
                        ? "端点读取中"
                        : napCatEndpointState === "error"
                          ? "端点读取失败"
                          : (napCatEndpointLabel(napCatWsUrl) ??
                            "协议/端口未配置")
                      : type === "web"
                        ? "默认组件 · 无需配置"
                        : undefined
                  }
                  onClick={type === "napcat" ? onConfigureNapCat : undefined}
                />
              );
            })}
        </div>
      </section>
    </>
  );
}
