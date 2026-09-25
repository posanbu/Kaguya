/**
 * 功能概述：工作台概览展示基础设施状态，并提供 Memory 与 NapCat 的即时开关。
 * 主要职责：Overview 读取安全接入快照和当前 Profile 的脱敏 Memory 存储摘要；
 * OverviewTile 用等尺寸图标、核心状态和紧凑元数据表达就绪度。
 * useRead 在重试、Token 变化及卸载时丢弃过期结果。
 * 代码库关系：App 挂载本页，复用 api.ts 安全 DTO 和 #144 基础组件与导航回调。
 * 输入输出与副作用：读取状态并在用户切换时提交版本校验请求；共享接入请求的
 * Runtime 与 Adapter 分开显示，读取失败不会推断为停机。
 */
import {
  Activity,
  Cable,
  Database,
  Globe2,
  ServerCog,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getAdapterStatus, type MemoryInfrastructureSummary } from "./api.js";
import {
  FEATURE_CHANGED_EVENT,
  getFeatures,
  putFeature,
  type FeatureId,
  type FeatureStatus,
  type FeatureView,
} from "./feature-api.js";
import { Button, Dialog, PageHeader, StatusBadge } from "./components/ui.js";
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
const readFeatures = (token: string) => getFeatures(token);
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
  opensDialog = false,
  detail,
  meta,
}: {
  title: string;
  status: string;
  tone: TileTone;
  icon: LucideIcon;
  onClick?: (() => unknown) | undefined;
  opensDialog?: boolean;
  detail?: string | undefined;
  meta?: string | undefined;
}) {
  return (
    <button
      type="button"
      className={`overview-tile overview-tile-${tone}`}
      onClick={onClick}
      disabled={!onClick}
      aria-haspopup={opensDialog ? "dialog" : undefined}
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

function FeatureTile({
  title,
  icon: Icon,
  feature,
  busy,
  onSwitch,
  onDetails,
  meta,
}: {
  title: string;
  icon: LucideIcon;
  feature: FeatureStatus | undefined;
  busy: boolean;
  onSwitch: (enabled: boolean) => void;
  onDetails: () => void;
  meta?: string;
}) {
  const blocked = !!feature?.blocker && !feature.enabled;
  const status = !feature
    ? "读取中"
    : busy
      ? "切换中"
      : feature.lifecycle === "retrying"
        ? "已开启，重连中"
        : feature.active
          ? "运行中"
          : feature.enabled
            ? "启动失败"
            : "已关闭";
  return (
    <article
      className={`overview-tile overview-feature-tile overview-tile-${feature?.active ? "success" : feature?.enabled ? "error" : "neutral"}`}
    >
      <span className="overview-tile-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="overview-tile-title">{title}</span>
      <strong className="overview-tile-status">{status}</strong>
      <div className="overview-feature-actions">
        <label className="overview-switch">
          <span className="wb-sr-only">{title}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={`${title}开关`}
            checked={feature?.enabled ?? false}
            disabled={!feature || busy || blocked}
            onChange={(event) => onSwitch(event.target.checked)}
          />
          <span aria-hidden="true" className="overview-switch-track" />
        </label>
        <button
          type="button"
          className="overview-feature-detail"
          onClick={onDetails}
        >
          配置
        </button>
      </div>
      {meta && <span className="overview-tile-meta">{meta}</span>}
      {blocked && <span className="overview-tile-meta">先开启原始记忆</span>}
    </article>
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

export function memoryDatabaseModeLabel(
  mode: MemoryInfrastructureSummary["databaseMode"],
) {
  if (mode === "managed") return "本机托管";
  if (mode === "external") return "外部 PostgreSQL";
  return "未配置";
}

export function memoryStorageKindLabel(
  kind: MemoryInfrastructureSummary["storageKind"],
) {
  if (kind === "docker-volume") return "Docker 命名卷";
  if (kind === "external") return "外部存储";
  return "未配置";
}

export function Overview({
  token,
  memoryInfrastructure,
  onRefreshConfiguration,
  navigate,
  onConfigureNapCat,
  napCatWsUrl,
  napCatEndpointState,
  focusAdapters = false,
}: {
  token: string;
  memoryInfrastructure?: MemoryInfrastructureSummary | undefined;
  onRefreshConfiguration: () => unknown;
  navigate: (path: string) => unknown;
  onConfigureNapCat: () => unknown;
  napCatWsUrl?: string | undefined;
  napCatEndpointState: "loading" | "ready" | "error";
  focusAdapters?: boolean;
}) {
  const adapters = useRead(token, readAdapters);
  const featureRead = useRead(token, readFeatures);
  const [featureView, setFeatureView] = useState<FeatureView>();
  const [featureBusy, setFeatureBusy] = useState<FeatureId>();
  const [featureError, setFeatureError] = useState("");
  useEffect(() => setFeatureView(featureRead.data), [featureRead.data]);
  useEffect(() => {
    const refresh = () => featureRead.retry();
    window.addEventListener(FEATURE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(FEATURE_CHANGED_EVENT, refresh);
  }, [featureRead.retry]);
  const feature = (id: FeatureId) =>
    featureView?.features.find((item) => item.id === id);
  const switchFeature = async (id: FeatureId, enabled: boolean) => {
    if (!featureView || featureBusy) return;
    setFeatureBusy(id);
    setFeatureError("");
    try {
      setFeatureView(
        await putFeature(token, id, enabled, featureView.revision),
      );
      adapters.retry();
      window.dispatchEvent(new Event(FEATURE_CHANGED_EVENT));
    } catch (error) {
      setFeatureError(error instanceof Error ? error.message : "切换失败");
      featureRead.retry();
    } finally {
      setFeatureBusy(undefined);
    }
  };
  const runtime = adapters.data?.runtime;
  const adapterHeading = useRef<HTMLHeadingElement>(null);
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
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
              featureRead.retry();
              onRefreshConfiguration();
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
        <OverviewTile
          title="PostgreSQL"
          status={
            adapters.loading
              ? "读取中"
              : runtime?.reason === "database_unavailable"
                ? "不可用"
                : runtime?.ingress === "ready"
                  ? "运行中"
                  : "状态未知"
          }
          tone={
            runtime?.reason === "database_unavailable"
              ? "error"
              : runtime?.ingress === "ready"
                ? "success"
                : "neutral"
          }
          icon={Database}
          meta={
            memoryInfrastructure
              ? `${memoryInfrastructure.engine} · ${
                  memoryInfrastructure.databaseMode === "managed"
                    ? "托管"
                    : memoryInfrastructure.databaseMode === "external"
                      ? "外部"
                      : "未配置"
                }`
              : undefined
          }
          onClick={() => setMemoryDialogOpen(true)}
          opensDialog
        />
      </div>
      <section
        className="overview-adapter-section"
        aria-labelledby="overview-memory-title"
      >
        <h2 id="overview-memory-title">记忆</h2>
        {featureError && <p role="alert">{featureError}</p>}
        {featureRead.error && (
          <p role="alert">无法读取功能状态，请刷新概览。</p>
        )}
        <div className="overview-grid" aria-live="polite">
          {(
            [
              ["memory.writeback", "原始记忆", Database],
              ["memory.knowledge", "事件 / Wiki", Globe2],
              ["memory.index", "向量索引", Activity],
              ["memory.cognition", "Mem0 认知记忆", ServerCog],
            ] as const
          ).map(([id, title, icon]) => (
            <FeatureTile
              key={id}
              title={title}
              icon={icon}
              feature={feature(id)}
              busy={featureBusy !== undefined}
              onSwitch={(enabled) => void switchFeature(id, enabled)}
              onDetails={() =>
                navigate(`/developer/modules/${encodeURIComponent(id)}`)
              }
            />
          ))}
        </div>
      </section>
      <section
        className="overview-adapter-section"
        aria-labelledby="overview-adapter-title"
      >
        <h2 id="overview-adapter-title" ref={adapterHeading} tabIndex={-1}>
          接入
        </h2>
        <div className="overview-grid overview-adapter-grid" aria-live="polite">
          <FeatureTile
            title="NapCat"
            icon={Cable}
            feature={feature("adapter.napcat")}
            busy={featureBusy !== undefined}
            onSwitch={(enabled) =>
              void switchFeature("adapter.napcat", enabled)
            }
            onDetails={onConfigureNapCat}
            meta={
              napCatEndpointState === "loading"
                ? "端点读取中"
                : napCatEndpointState === "error"
                  ? "端点读取失败"
                  : (napCatEndpointLabel(napCatWsUrl) ?? "协议/端口未配置")
            }
          />
          {adapters.data?.adapters
            .filter((adapter) => adapter.type.toLowerCase() !== "napcat")
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
                  meta={type === "web" ? "默认组件 · 无需配置" : undefined}
                />
              );
            })}
        </div>
      </section>
      <Dialog.Root open={memoryDialogOpen} onOpenChange={setMemoryDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="wb-overlay" />
          <Dialog.Content className="wb-dialog memory-infrastructure-dialog">
            <Dialog.Title>Memory 基础设施</Dialog.Title>
            <Dialog.Description>
              当前选中 Profile 的脱敏物理配置。凭据和完整连接串不会显示。
            </Dialog.Description>
            {memoryInfrastructure ? (
              <>
                <StatusBadge
                  tone={memoryInfrastructure.enabled ? "success" : "neutral"}
                >
                  {memoryInfrastructure.enabled
                    ? "PostgreSQL 已配置"
                    : "PostgreSQL 未配置"}
                </StatusBadge>
                <dl className="memory-infrastructure-details">
                  <div>
                    <dt>数据库引擎</dt>
                    <dd>{memoryInfrastructure.engine}</dd>
                  </div>
                  <div>
                    <dt>运行模式</dt>
                    <dd>
                      {memoryDatabaseModeLabel(
                        memoryInfrastructure.databaseMode,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>存储类型</dt>
                    <dd>
                      {memoryStorageKindLabel(memoryInfrastructure.storageKind)}
                    </dd>
                  </div>
                  <div>
                    <dt>存储位置</dt>
                    <dd>{memoryInfrastructure.storageLocation ?? "未配置"}</dd>
                  </div>
                  <div>
                    <dt>主机</dt>
                    <dd>{memoryInfrastructure.host ?? "未配置"}</dd>
                  </div>
                  <div>
                    <dt>端口</dt>
                    <dd>{memoryInfrastructure.port ?? "未配置"}</dd>
                  </div>
                  <div>
                    <dt>数据库</dt>
                    <dd>{memoryInfrastructure.database ?? "未配置"}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <div className="profile-loading" role="status">
                正在读取 Memory 基础设施配置
              </div>
            )}
            <div className="editor-actions memory-infrastructure-dialog-actions">
              <Dialog.Close asChild>
                <Button>关闭</Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
