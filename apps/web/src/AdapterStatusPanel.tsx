/**
 * 功能概述：轮询并展示当前 AdapterHost/Runtime 的真实连接与入站状态。
 * 主要职责：挂载时启动可取消轮询、卸载时停止；通过状态标签区分热应用暂停与平台断线。
 * 代码库关系：复用 api 与 adapter-status；Server 动态状态门面确保切换后不显示旧实例。
 * 输入输出与副作用：仅 GET 安全状态 DTO，修复配置后引导重新应用，不要求普通配置重启。
 */
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { getAdapterStatus } from "./api.js";
import { pollAdapterStatus, type StatusPollState } from "./adapter-status.js";

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
export function AdapterStatusPanel({ token }: { token: string }) {
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
        <h2 id="adapter-status-title">Gateway / Adapter 状态</h2>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void poller.current?.refresh()}
          aria-label="刷新 Adapter 状态"
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      {state.failed && (
        <p className="error-banner" role="alert">
          状态服务失联。
          {state.snapshot ? "当前显示最后一次快照。" : "尚未取得状态快照。"}
          请尝试刷新。
        </p>
      )}
      {!state.snapshot && !state.failed && (
        <p role="status">正在读取接入状态…</p>
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
          <p className="setup-intro">
            连接状态与消息处理能力分别显示。修复配置或下游故障后，可在配置生效管理中重新应用。
          </p>
          <div className="adapter-status-grid">
            {state.snapshot.adapters.map((adapter) => (
              <article
                className="adapter-status-card"
                key={adapter.adapterId}
                aria-label={`${adapter.type} 状态`}
              >
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
                <dl>
                  <div>
                    <dt>启用</dt>
                    <dd>{adapter.enabled ? "是" : "否"}</dd>
                  </div>
                  <div>
                    <dt>生命周期</dt>
                    <dd>{label(adapter.lifecycle)}</dd>
                  </div>
                  <div>
                    <dt>连接</dt>
                    <dd>{label(adapter.connectivity)}</dd>
                  </div>
                  <div>
                    <dt>消息提交</dt>
                    <dd>{label(adapter.ingress)}</dd>
                  </div>
                  {adapter.attempt !== undefined && (
                    <div>
                      <dt>连接尝试</dt>
                      <dd>{adapter.attempt}</dd>
                    </div>
                  )}
                  {adapter.nextRetryAt && (
                    <div>
                      <dt>下次重连</dt>
                      <dd>
                        {new Date(adapter.nextRetryAt).toLocaleTimeString()}
                      </dd>
                    </div>
                  )}
                  {adapter.errorType && (
                    <div>
                      <dt>原因</dt>
                      <dd>{label(adapter.errorType)}</dd>
                    </div>
                  )}
                </dl>
              </article>
            ))}
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
