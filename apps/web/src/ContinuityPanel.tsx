import { useEffect, useState } from "react";
import type { ContinuityView, Activity } from "@kaguya/schema";
import {
  getContinuousAgent,
  controlActivity,
  GatewayRequestError,
} from "./api.js";
import { Button, FieldMessage } from "./components/ui.js";
import "./continuity.css";

export const activityStateLabels: Record<Activity["state"], string> = {
  candidate: "候选",
  active: "进行中",
  waiting: "等待",
  paused: "已暂停",
  completed: "已完成",
  abandoned: "已放弃",
  failed: "失败",
};
const validity = {
  current: "当前有效",
  expired: "已过期",
  unevaluated: "未评估",
  unavailable: "当前范围不可读",
};
const social = {
  available: "愿意交流",
  focused: "专注",
  solitude: "想独处",
  undetermined: "尚未确定",
};
export function scopeName(scope: string) {
  if (scope === "shared") return "共同可见";
  try {
    const [platform, , kind, id] = JSON.parse(scope);
    return platform === "kaguya"
      ? "自主活动"
      : `${kind === "private" ? "私聊" : kind === "group" ? "群聊" : "网页会话"} ${id ?? ""}`;
  } catch {
    return "原始范围";
  }
}
type Pending = {
  id: string;
  scope: string;
  operationId: string;
  expectedRevision: number;
  action: "pause" | "resume" | "abandon";
};
export function ContinuityPanel({
  token,
  revision,
  select,
}: {
  token: string;
  revision: number;
  select(id: string): void;
}) {
  const [scope, setScope] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [view, setView] = useState<ContinuityView | null>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setView(undefined);
    void getContinuousAgent({ token }, scope, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setView(data.view);
          setScopes(data.scopes);
        }
      },
      () => {
        if (!controller.signal.aborted) setError("活动读取失败。请刷新重试。");
      },
    );
    return () => controller.abort();
  }, [token, scope, revision, refresh]);
  async function act(operation: Pending) {
    setPending(operation);
    setSaving(true);
    setError("");
    try {
      const { id, ...input } = operation;
      await controlActivity({ token }, id, input);
      setPending(null);
      setRefresh((r) => r + 1);
    } catch (error) {
      if (error instanceof GatewayRequestError && error.status === 409)
        setPending(null);
      setError(
        error instanceof Error
          ? error.message
          : "操作结果未知。请核对后重试原操作。",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="continuous-agent" aria-label="持续状态与活动">
      <div className="continuous-toolbar">
        <h3>现在与接下来</h3>
        <label>
          查看范围
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setPending(null);
            }}
          >
            <option value="">当前范围</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {scopeName(s)}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => setRefresh((r) => r + 1)}>刷新</Button>
      </div>
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      {pending && !saving && (
        <Button onClick={() => void act(pending)}>重试原操作</Button>
      )}
      {view === undefined && !error && <p role="status">正在读取活动…</p>}
      {view === null && (
        <p>
          尚未启用持续自我与活动。启用模块后会保留状态和活动历史，自主运行需单独开启。
        </p>
      )}
      {view && (
        <>
          <dl className="continuous-summary">
            <div>
              <dt>自主运行</dt>
              <dd>{view.policy.enabled ? "已开启" : "已停用"}</dd>
            </div>
            <div>
              <dt>当前状态</dt>
              <dd>
                {validity[view.stateValidity]}
                {view.stateValidity === "current" && view.state
                  ? ` · ${social[view.state.subjective.social]}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>今日自主调用</dt>
              <dd>
                {view.budget.used} / {view.budget.limit} · 剩余{" "}
                {view.budget.remaining}
              </dd>
            </div>
            <div>
              <dt>实际专注</dt>
              <dd>
                {view.mainWorkKind === "request"
                  ? "正在处理聊天中的行动"
                  : view.busy
                    ? "有进行中的主活动"
                    : "当前没有主活动"}
              </dd>
            </div>
          </dl>
          {view.state && (
            <div className="continuous-appraisal">
              {view.stateValidity === "expired" && (
                <p>以下是已过期的历史评价。</p>
              )}
              <p>
                {view.state.subjective.appraisal || "本次评价没有文字说明。"}
              </p>
              <p>
                关注：{view.state.subjective.attention.join("、") || "未指定"}
                。兴趣：
                {view.state.subjective.interests
                  .map((i) => i.topic)
                  .join("、") || "未评估"}
                。
              </p>
              <p className="muted">
                评价时间 {new Date(view.state.evaluatedAt).toLocaleString()}
                ，有效至 {new Date(view.state.expiresAt).toLocaleString()}。
                <button
                  className="inspection-link"
                  onClick={() => select(view.state!.informationId)}
                >
                  查看评价依据
                </button>
              </p>
            </div>
          )}
          {!view.activities.length && (
            <p>当前范围没有活动记录。其他范围的私人正文不会在这里显示。</p>
          )}
          {view.activitiesTruncated && (
            <FieldMessage>
              仅显示主活动、开放活动及最近记录。完整历史可从“版本与来源”进入。
            </FieldMessage>
          )}
          <div className="continuous-activities">
            {view.activities.map((a) => (
              <article key={a.id} className="continuous-activity">
                <div className="continuous-activity-heading">
                  <h4>{a.title}</h4>
                  <span>
                    {activityStateLabels[a.state]}
                    {a.requestedState
                      ? ` · 正在${a.requestedState === "abandoned" ? "放弃" : a.requestedState === "paused" ? "暂停" : "等待安全边界"}`
                      : ""}
                  </span>
                </div>
                <p>{a.goal}</p>
                {a.reevaluationRequired && (
                  <FieldMessage>
                    依据已变化，未执行计划需要重新评价。
                  </FieldMessage>
                )}
                <dl>
                  <dt>下一步</dt>
                  <dd>{a.nextStep || "尚未确定"}</dd>
                  <dt>外部结果</dt>
                  <dd>
                    {
                      {
                        unknown: "未知",
                        partial: "部分完成",
                        verified: "已核对",
                        failed: "失败",
                      }[a.externalResult]
                    }
                  </dd>
                  <dt>再次检查</dt>
                  <dd>
                    {a.nextCheckAt
                      ? new Date(a.nextCheckAt).toLocaleString()
                      : "尚未安排"}
                  </dd>
                  {a.kind === "commitment" && (
                    <>
                      <dt>约定</dt>
                      <dd>
                        {
                          {
                            unknown: "未知",
                            pending: "待履约",
                            fulfilled: "已履约",
                            declined: "已撤回",
                          }[a.fulfillment]
                        }{" "}
                        · 投递 {a.deliveryIds.length} 条 · 反馈{" "}
                        {a.feedbackIds.length} 条
                      </dd>
                    </>
                  )}
                </dl>
                {a.completedSteps.length > 0 && (
                  <details>
                    <summary>已完成步骤与产物</summary>
                    <ol>
                      {a.completedSteps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                    {a.artifacts.map((id) => (
                      <button
                        className="inspection-link"
                        key={id}
                        onClick={() => select(id)}
                      >
                        查看产物依据
                      </button>
                    ))}
                  </details>
                )}
                <div className="continuous-controls">
                  {["candidate", "active", "waiting", "paused"].includes(
                    a.state,
                  ) && (
                    <>
                      {a.state !== "paused" && (
                        <Button
                          disabled={saving || !!pending || !!a.requestedState}
                          onClick={() =>
                            void act({
                              id: a.id,
                              scope: a.scope,
                              operationId: crypto.randomUUID(),
                              expectedRevision: a.revision,
                              action: "pause",
                            })
                          }
                        >
                          暂停
                        </Button>
                      )}
                      {a.state !== "active" && (
                        <Button
                          disabled={
                            saving ||
                            !!pending ||
                            !view.policy.enabled ||
                            !view.budget.remaining ||
                            a.reevaluationRequired
                          }
                          onClick={() =>
                            void act({
                              id: a.id,
                              scope: a.scope,
                              operationId: crypto.randomUUID(),
                              expectedRevision: a.revision,
                              action: "resume",
                            })
                          }
                        >
                          恢复
                        </Button>
                      )}
                      <Button
                        disabled={saving || !!pending || !!a.requestedState}
                        onClick={() =>
                          void act({
                            id: a.id,
                            scope: a.scope,
                            operationId: crypto.randomUUID(),
                            expectedRevision: a.revision,
                            action: "abandon",
                          })
                        }
                      >
                        放弃
                      </Button>
                    </>
                  )}
                  <button
                    className="inspection-link"
                    onClick={() => select(a.informationId)}
                  >
                    版本与来源
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
