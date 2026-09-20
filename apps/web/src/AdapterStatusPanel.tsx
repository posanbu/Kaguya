/**
 * 功能概述：轮询并展示当前 AdapterHost/Runtime 的真实连接与入站状态。
 * 展示层复用工作台 Button/FieldMessage/StatusBadge，不改变轮询、取消或状态映射。
 * 主要职责：挂载时启动可取消轮询、卸载时停止；通过状态标签区分热应用暂停与平台断线。
 * 代码库关系：复用 api 与 adapter-status；Server 动态状态门面确保切换后不显示旧实例。
 * 输入输出与副作用：仅 GET 安全状态 DTO，修复配置后引导重新应用，不要求普通配置重启。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, FieldMessage, StatusBadge } from "./components/ui.js";
import { RefreshCw, Settings2 } from "lucide-react";
import { getAdapterStatus } from "./api.js";
import {
  pollAdapterStatus,
  type AdapterStatus,
  type StatusPollState,
} from "./adapter-status.js";

const labels: Record<string, string> = {
  disabled: "已禁用",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  failed: "失败",
  not_applicable: "无需连接",
  connecting: "连接中",
  connected: "已连接",
  retrying: "等待重连",
  disconnected: "已断开",
  ready: "可提交消息",
  runtime_unavailable: "无法提交消息",
  configuration_not_ready: "AI 配置未就绪",
  database_unavailable: "数据库不可用",
  runtime_start_failed: "Runtime 启动失败",
  configuration_invalid: "配置无效",
  connection_failed: "连接失败",
  start_failed: "启动失败",
  stop_failed: "停止失败",
};
const label = (value: string) => labels[value] ?? value;
type StatusTone = "neutral" | "success" | "warning" | "error";
export function adapterStatusValues(
  adapter: AdapterStatus["adapters"][number],
): { label: string; tone: StatusTone }[] {
  const tone = (value: string): StatusTone => {
    if (
      [
        "failed",
        "disconnected",
        "runtime_unavailable",
        "configuration_invalid",
        "connection_failed",
        "start_failed",
        "stop_failed",
      ].includes(value)
    )
      return "error";
    if (["starting", "stopping", "connecting", "retrying"].includes(value))
      return "warning";
    if (["running", "connected", "ready"].includes(value)) return "success";
    return "neutral";
  };
  const values: { label: string; tone: StatusTone }[] = [
    {
      label: adapter.enabled ? "已启用" : "已禁用",
      tone: adapter.enabled ? "success" : "neutral",
    },
    { label: label(adapter.lifecycle), tone: tone(adapter.lifecycle) },
    { label: label(adapter.connectivity), tone: tone(adapter.connectivity) },
    { label: label(adapter.ingress), tone: tone(adapter.ingress) },
  ];
  if (adapter.errorType)
    values.push({ label: label(adapter.errorType), tone: "error" });
  return values;
}
export function AdapterStatusPanel({
  token,
  onConfigureNapCat,
}: {
  token: string;
  onConfigureNapCat?: () => void;
}) {
  const [state, setState] = useState<StatusPollState>({
    failed: false,
    loading: true,
  });
  const poller = useRef<ReturnType<typeof pollAdapterStatus>>(undefined);
  useEffect(() => {
    const current = pollAdapterStatus({
      load: (signal) => getAdapterStatus({ token }, signal),
      visibility: document,
      onChange: setState,
    });
    poller.current = current;
    return () => {
      current.stop();
      poller.current = undefined;
    };
  }, [token]);
  return (
    <section
      className="setup-card adapter-status-panel"
      aria-labelledby="adapter-status-title"
    >
      <div className="panel-heading">
        <h3 id="adapter-status-title">Gateway / Adapter 状态</h3>
        <Button
          type="button"
          className="secondary-button"
          onClick={() => void poller.current?.refresh()}
          aria-label="刷新 Adapter 状态"
        >
          <RefreshCw size={16} />
          刷新
        </Button>
      </div>
      {state.failed && (
        <FieldMessage tone="error">
          状态服务失联。
          {state.snapshot ? "当前显示最后一次快照。" : "尚未取得状态快照。"}
          请尝试刷新。
        </FieldMessage>
      )}
      {!state.snapshot && !state.failed && (
        <FieldMessage>正在读取接入状态…</FieldMessage>
      )}
      {state.snapshot && (
        <>
          <dl className="adapter-summary">
            <div>
              <dt>Adapter Host</dt>
              <dd>{label(state.snapshot.adapterHostState)}</dd>
            </div>
            <div>
              <dt>Runtime ingress</dt>
              <dd>
                {label(state.snapshot.runtime.ingress)}
                {state.snapshot.runtime.reason &&
                  ` · ${label(state.snapshot.runtime.reason)}`}
              </dd>
            </div>
          </dl>
          <div className="adapter-status-grid">
            {state.snapshot.adapters.map((adapter) => {
              const configurable =
                adapter.type === "napcat" && onConfigureNapCat !== undefined;
              const activate = (event: KeyboardEvent<HTMLElement>) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onConfigureNapCat?.();
              };
              const details = [
                adapter.attempt !== undefined
                  ? `连接尝试 ${adapter.attempt}`
                  : undefined,
                adapter.nextRetryAt
                  ? `${new Date(adapter.nextRetryAt).toLocaleTimeString()} 重连`
                  : undefined,
              ].filter(Boolean);
              return (
                <article
                  className={`adapter-status-card${configurable ? " adapter-status-card-action" : ""}`}
                  key={adapter.adapterId}
                  aria-label={`${adapter.type} 状态${configurable ? "，打开配置" : ""}`}
                  aria-haspopup={configurable ? "dialog" : undefined}
                  role={configurable ? "button" : undefined}
                  tabIndex={configurable ? 0 : undefined}
                  onClick={configurable ? onConfigureNapCat : undefined}
                  onKeyDown={configurable ? activate : undefined}
                >
                  <div className="adapter-status-card-header">
                    <div>
                      <h3>
                        {adapter.type === "web"
                          ? "Web"
                          : adapter.type === "napcat"
                            ? "NapCat"
                            : adapter.type}
                      </h3>
                      <p className="adapter-identity">
                        {adapter.adapterId} · {adapter.platform}
                      </p>
                    </div>
                    {configurable && <Settings2 size={17} aria-hidden="true" />}
                  </div>
                  <div className="adapter-status-values" aria-label="状态">
                    {adapterStatusValues(adapter).map((value, index) => (
                      <StatusBadge
                        key={`${value.label}:${index}`}
                        tone={value.tone}
                      >
                        {value.label}
                      </StatusBadge>
                    ))}
                  </div>
                  {details.length > 0 && (
                    <p className="adapter-status-detail">
                      {details.join(" · ")}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      <p className="adapter-refresh-status">
        {state.updatedAt
          ? `最后获取：${new Date(state.updatedAt).toLocaleTimeString()}`
          : "尚无快照"}
        {state.loading ? " · 刷新中" : " · 页面可见时每 2 秒刷新"}
      </p>
    </section>
  );
}
