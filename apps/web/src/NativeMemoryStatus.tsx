/**
 * 功能概述：现有 Memory 模块页的持久处理摘要、失败批次和冻结目录入口。
 * NativeMemoryStatus 按 token/revision/refresh 隔离读取；模块装配与实际执行分开措辞。
 * 来自 memory-graph-api 与模块设置的摘要不代替精确历史；明确失败批次才允许显式重新排队。
 * 精确观察、修订与来源通过情境中的领域检视读取，不把泛化链接称为所选请求。
 */
import { useEffect, useState } from "react";
import {
  readNativeMemoryStatus,
  retryMemoryBatch,
} from "./memory-graph-api.js";
import { requestModuleSettings } from "./module-settings-api.js";
import { FieldMessage } from "./components/ui.js";
export function NativeMemoryStatus({
  token,
  revision = 0,
  active = false,
}: {
  token: string;
  revision?: number;
  active?: boolean;
}) {
  const [status, setStatus] = useState<
    Awaited<ReturnType<typeof readNativeMemoryStatus>> & {
      configuration: Record<string, unknown>;
    }
  >();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [statusKey, setStatusKey] = useState("");
  const key = `${token}:${revision}:${refresh}`;
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void Promise.all([
      readNativeMemoryStatus(token, controller.signal),
      requestModuleSettings(
        token,
        "memory.native",
        undefined,
        controller.signal,
      ),
    ]).then(
      ([value, settings]) => {
        if (!controller.signal.aborted) {
          setStatus({
            ...value,
            configuration: settings.instances[0]?.settings ?? {},
          });
          setStatusKey(key);
        }
      },
      (reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "状态读取失败");
      },
    );
    return () => controller.abort();
  }, [token, revision, refresh, key]);
  if (error) return <FieldMessage tone="error">{error}</FieldMessage>;
  if (!status || statusKey !== key)
    return <FieldMessage>正在读取 Memory 状态…</FieldMessage>;
  return (
    <section aria-label="Memory 处理状态">
      <p>
        {active
          ? "统一 Memory 模块已装配，以下为已保存的处理记录。"
          : "统一 Memory 未运行。以下为已保存的处理记录。"}
      </p>
      <p>
        等待形成 {status.counts.queued} 条来源 · 待完成 {status.counts.pending}{" "}
        个批次 · 失败或拒绝 {status.counts.rejected} 个批次
      </p>
      <p>
        有效记忆 {status.counts.nodes} 条 · 固定摘要 {status.counts.fixed} 条
      </p>
      <dl>
        {(["semantic", "language"] as const).map((role) => {
          const stage = status.stages.find((s) => s.stage === role);
          const configured = status.configuration[`${role}Embedding`] as
            { enabled?: boolean } | undefined;
          return (
            <div key={role}>
              <dt>{role === "semantic" ? "语义索引" : "语言与字面索引"}</dt>
              <dd>
                {configured?.enabled !== true && (
                  <span>未配置或已关闭（保存配置） · </span>
                )}
                {!stage
                  ? "未记录索引运行"
                  : stage.status === "ready"
                    ? "最近构建完成"
                    : stage.status === "rebuilding"
                      ? "重建中"
                      : "已降级，图和文本检索仍可用"}
                {stage && (
                  <time dateTime={stage.updated_at}>
                    {" "}
                    · {new Date(stage.updated_at).toLocaleString()}
                  </time>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {!!status.batches.length && (
        <details>
          <summary>失败批次与重试</summary>
          <ul>
            {status.batches.map((batch) => (
              <li key={batch.id}>
                <code>{batch.id}</code> ·{" "}
                {batch.status === "rejected" ? "发布被拒绝" : "形成失败"}{" "}
                <button
                  type="button"
                  disabled={
                    !active ||
                    retrying ||
                    !["failed", "rejected"].includes(batch.status)
                  }
                  onClick={() => {
                    setRetrying(true);
                    void retryMemoryBatch(token, batch.id)
                      .then(
                        () => setRefresh((n) => n + 1),
                        (e) =>
                          setError(e instanceof Error ? e.message : "重试失败"),
                      )
                      .finally(() => setRetrying(false));
                  }}
                >
                  重新排队
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <h3>最近召回与上下文冻结</h3>
      {status.snapshots.length ? (
        <ul>
          {status.snapshots.map((s) => (
            <li key={s.id}>
              <time dateTime={s.frozenAt}>
                {new Date(s.frozenAt).toLocaleString()}
              </time>{" "}
              ·{" "}
              {s.status === "disabled"
                ? "已禁用"
                : `固定 ${s.fixed} 条，动态 ${s.recalled} 条`}
              {s.degraded.length
                ? ` · 辅助检索降级：${s.degraded.join("、")}`
                : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p>尚未记录上下文冻结。</p>
      )}
      <p>
        <a href="/situation?inspect=observation">查看观察与冻结记忆</a>
        。以上是冻结阶段计数，最终 Prompt 的预算裁剪见情境页。
      </p>
      <p>
        是否启用由下方配置与实际模块状态决定。固定注入和动态召回的实际内容见情境页。
      </p>
    </section>
  );
}
