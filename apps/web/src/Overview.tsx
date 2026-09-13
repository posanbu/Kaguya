/**
 * 功能概述：工作台根路径的只读系统概览，分别回答配置、Runtime 与 Adapter 是否就绪。
 * 主要职责：Overview 独立读取配置 readiness、生效版本及安全接入快照；StatusCard
 * 统一呈现原因与唯一修复入口。useRead 在重试、Token 变化及卸载时丢弃过期结果。
 * 代码库关系：App 挂载本页，复用 api.ts 安全 DTO 和 #144 基础组件与导航回调。
 * 输入输出与副作用：只发 GET，不读取凭据、不应用配置、不发送消息；共享接入请求的
 * Runtime 与 Adapter 分开显示，配置的两个读取结果也分别保留，失败不会推断为停机。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  getAdapterStatus,
  getConfigurationApplication,
  listProfiles,
} from "./api.js";
import {
  Button,
  FieldMessage,
  PageHeader,
  StatusBadge,
} from "./components/ui.js";
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
const readProfiles = (token: string) => listProfiles({ token });
const readApplication = (token: string) =>
  getConfigurationApplication({ token });
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
function StatusCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="overview-card" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function ReadFeedback({
  name,
  state,
}: {
  name: string;
  state: { loading: boolean; error: boolean; retry: () => void };
}) {
  if (state.error)
    return (
      <>
        <FieldMessage tone="error">{name}读取失败，当前状态未知。</FieldMessage>
        <Button onClick={state.retry}>重试{name}</Button>
      </>
    );
  if (state.loading) return <FieldMessage>正在读取{name}…</FieldMessage>;
  return null;
}
export function Overview({
  token,
  navigate,
}: {
  token: string;
  navigate: (path: string) => unknown;
}) {
  const profiles = useRead(token, readProfiles);
  const application = useRead(token, readApplication);
  const adapters = useRead(token, readAdapters);
  const config = profiles.data;
  const applied = application.data;
  const invalid =
    config?.status === "invalid" || config?.status === "review_required";
  const configAction = invalid ? "/profiles" : "/configuration/application";
  const runtime = adapters.data?.runtime;
  return (
    <>
      <PageHeader
        title="概览"
        description="查看当前配置、消息入口与平台接入状态。"
        actions={
          <Button
            onClick={() => {
              profiles.retry();
              application.retry();
              adapters.retry();
            }}
          >
            刷新概览
          </Button>
        }
      />
      <div className="overview-grid">
        <StatusCard title="配置">
          <ReadFeedback name="配置" state={profiles} />
          {config && (
            <>
              <p>
                当前选中：
                {config.profiles.find(
                  (profile) => profile.id === config.selectedProfileId,
                )?.name ?? config.selectedProfileId}
              </p>
              <StatusBadge
                tone={
                  invalid
                    ? "error"
                    : config.status === "restart_required"
                      ? "warning"
                      : "success"
                }
              >
                {invalid
                  ? config.status === "invalid"
                    ? "配置无效"
                    : "配置待确认"
                  : config.status === "restart_required"
                    ? "配置待应用"
                    : "配置校验通过"}
              </StatusBadge>
              {(config.issues ?? []).map((issue) => (
                <p key={issue.id}>{issue.message}</p>
              ))}
              {(config.warnings ?? []).map((warning) => (
                <p key={warning.id}>{warning.message}</p>
              ))}
              {invalid &&
                !config.issues?.length &&
                !config.warnings?.length && (
                  <p>当前 Profile 未通过校验或仍有待确认项，请进入配置检查。</p>
                )}
            </>
          )}
          <ReadFeedback name="生效状态" state={application} />
          {applied && (
            <>
              <p>当前生效：{applied.appliedProfileId ?? "尚未生效"}</p>
              <p>
                {
                  {
                    ready: "当前配置已生效。",
                    pending: "选中配置存在待应用修改。",
                    applying: "正在应用配置，消息入口可能短暂暂停。",
                    degraded: "运行实例不可用，请检查服务后重新应用。",
                  }[applied.state]
                }
              </p>
            </>
          )}
          {(config || applied) && (
            <Button onClick={() => navigate(configAction)}>
              {invalid ? "检查配置" : "管理配置生效"}
            </Button>
          )}
        </StatusCard>
        <StatusCard title="Runtime">
          <ReadFeedback name="Runtime 状态" state={adapters} />
          {runtime && (
            <>
              <StatusBadge
                tone={runtime.ingress === "ready" ? "success" : "warning"}
              >
                {label(runtime.ingress)}
              </StatusBadge>
              <p>
                {runtime.reason
                  ? label(runtime.reason)
                  : runtime.ingress === "ready"
                    ? "Runtime 消息入口已就绪；平台连接状态见接入区域。"
                    : "Runtime 正在停止、切换或尚未启动。"}
              </p>
              {runtime.reason === "database_unavailable" && (
                <p>请先恢复服务使用的数据库连接，再进入配置生效管理重试。</p>
              )}
              {runtime.ingress !== "ready" && (
                <Button
                  onClick={() =>
                    navigate(
                      runtime.reason === "configuration_not_ready"
                        ? "/profiles"
                        : "/configuration/application",
                    )
                  }
                >
                  {runtime.reason === "configuration_not_ready"
                    ? "检查配置"
                    : "管理配置生效"}
                </Button>
              )}
            </>
          )}
        </StatusCard>
        <StatusCard title="Adapter">
          <ReadFeedback name="Adapter 状态" state={adapters} />
          {adapters.data && (
            <>
              <p>Adapter Host：{label(adapters.data.adapterHostState)}</p>
              {!adapters.data.adapters.length && (
                <p>当前没有已启动的 Adapter，请检查接入配置与配置生效状态。</p>
              )}
              {adapters.data.adapters.map((adapter) => (
                <article className="overview-adapter" key={adapter.adapterId}>
                  <h3>
                    {adapter.type} · {adapter.adapterId}
                  </h3>
                  <StatusBadge
                    tone={
                      !adapter.enabled
                        ? "neutral"
                        : adapter.lifecycle === "failed" ||
                            adapter.connectivity === "disconnected" ||
                            adapter.connectivity === "retrying"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {!adapter.enabled ? "已禁用" : label(adapter.lifecycle)}
                  </StatusBadge>
                  <p>连接：{label(adapter.connectivity)}</p>
                  {adapter.errorType && <p>原因：{label(adapter.errorType)}</p>}
                </article>
              ))}
              <Button onClick={() => navigate("/adapters")}>检查接入</Button>
            </>
          )}
        </StatusCard>
      </div>
    </>
  );
}
