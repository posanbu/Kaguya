/**
 * 功能概述：展示选中/生效配置并提供显式应用、冲突后重试与进程级重启指引。
 * 主要职责：读取安全状态快照，应用用户当前看到的 revision；过期时刷新快照但不自动重试写操作。
 * 代码库关系：App 的待应用视图挂载此组件，api.ts 负责认证与 DTO 校验；不读取 Profile 凭据。
 * 输入输出与副作用：发起受认证的 GET/POST；组件卸载后忽略读取结果，应用成功通知 App 刷新状态。
 */
import { useEffect, useState } from "react";
import {
  applyConfiguration,
  configurationApplyMessage,
  getConfigurationApplication,
  type ConfigurationApplicationStatus,
  type ConfigurationApplyResult,
} from "./api.js";

export function ConfigurationApplicationScreen({
  token,
  onApplied,
  onEdit,
}: {
  readonly token: string;
  readonly onApplied: () => Promise<unknown>;
  readonly onEdit: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ConfigurationApplicationStatus>();
  const [result, setResult] = useState<ConfigurationApplyResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void getConfigurationApplication({ token }).then(
      (value) => {
        if (live) setSnapshot(value);
      },
      () => {
        if (live) setError("无法读取配置，请返回检查配置或服务状态。");
      },
    );
    return () => {
      live = false;
    };
  }, [token]);
  const apply = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const value = await applyConfiguration({ token }, snapshot);
      setResult(value);
      setSnapshot(value.application);
      if (value.status === "applied") await onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "应用失败，请重试。");
      try {
        setSnapshot(await getConfigurationApplication({ token }));
      } catch {
        /* 保留最后可读快照。 */
      }
    } finally {
      setBusy(false);
    }
  };
  const restart =
    result?.status === "restart_required" ||
    result?.errorCode === "shutdown_failed";
  return (
    <div className="setup-shell">
      <section
        className="setup-card setup-status-card"
        aria-labelledby="configuration-apply-title"
      >
        <h1 id="configuration-apply-title">配置生效管理</h1>
        <p>
          模型、人设、Memory、平台和白名单可直接应用；切换期间消息入口会短暂暂停，访问链接保持有效。
        </p>
        {snapshot && (
          <dl>
            <dt>当前选中</dt>
            <dd>{snapshot.selectedProfileId}</dd>
            <dt>当前生效</dt>
            <dd>{snapshot.appliedProfileId ?? "尚未启动"}</dd>
            <dt>状态</dt>
            <dd>
              {busy || snapshot.state === "applying"
                ? "正在应用"
                : snapshot.state === "ready"
                  ? "已生效"
                  : snapshot.state === "pending"
                    ? "有待应用修改"
                    : "Runtime 暂不可用"}
            </dd>
          </dl>
        )}
        {result && <p role="status">{configurationApplyMessage(result)}</p>}
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {restart && (
          <div>
            {result?.restartFields && (
              <p>需要重启的字段：{result.restartFields.join("、")}</p>
            )}
            <p>
              在原终端按 Ctrl+C，执行 pnpm dev（生产模式 pnpm
              start），然后打开终端打印的新访问链接。
            </p>
          </div>
        )}
        <button
          type="button"
          className="setup-button"
          disabled={!snapshot || busy || restart}
          onClick={() => void apply()}
        >
          {busy ? "正在应用，请稍候" : "应用当前配置"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onEdit}
        >
          返回配置
        </button>
      </section>
    </div>
  );
}
