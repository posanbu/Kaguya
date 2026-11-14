/** 人物关系与共同经历只读取所选范围，不把承诺执行状态复制到 Memory。 */
import { useEffect, useState } from "react";
import type { PersonContinuity as PersonView } from "@kaguya/schema";
import { getPersonContinuity } from "./api.js";
import { scopeName, activityStateLabels } from "./ContinuityPanel.js";
import { Button, FieldMessage } from "./components/ui.js";

const basis = {
  "self-report": "本人自述",
  "third-party": "第三方描述",
  observation: "实际观察",
  inference: "Kaguya 的推断",
};
export function PersonContinuity({
  personId,
  token,
  onTrace,
}: {
  personId: string;
  token: string;
  onTrace(id: string): void;
}) {
  const [scope, setScope] = useState("");
  const [view, setView] = useState<PersonView>();
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setView(undefined);
    setError(false);
    void getPersonContinuity(
      { token },
      personId,
      scope,
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted) setView(data);
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
    return () => controller.abort();
  }, [personId, scope, token, refresh]);
  const experiences =
    view?.nodes.filter((n) => n.metadata.kind === "experience") ?? [];
  const impressions =
    view?.nodes.filter((n) => n.metadata.kind !== "experience") ?? [];
  return (
    <section className="person-readonly-section" aria-label="关系、经历与约定">
      <div className="continuous-toolbar">
        <h4>关系、经历与约定</h4>
        <label>
          查看范围
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">当前范围</option>
            {view?.scopes.map((s) => (
              <option key={s} value={s}>
                {scopeName(s)}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => setRefresh((n) => n + 1)}>刷新关系</Button>
      </div>
      {error ? (
        <FieldMessage tone="error">关系读取失败。请刷新重试。</FieldMessage>
      ) : !view ? (
        <p role="status">正在读取关系…</p>
      ) : (
        <>
          {view.truncated && (
            <FieldMessage>
              记录较多，仅显示部分当前有效认识。完整版本请进入记忆检视。
            </FieldMessage>
          )}
          {[
            { title: "怎样理解这个人", nodes: impressions },
            { title: "共同经历", nodes: experiences },
          ].map(({ title, nodes }) => (
            <div key={title}>
              <h5>{title}</h5>
              {!nodes.length ? (
                <p className="inspection-muted">当前范围尚无可读取的记录。</p>
              ) : (
                nodes.map((node) => (
                  <article className="continuous-activity" key={node.id}>
                    <p>{node.content}</p>
                    <p className="inspection-muted">
                      {node.metadata.tags.includes("对方反馈")
                        ? "对方反馈"
                        : node.metadata.evidence
                          ? basis[node.metadata.evidence.basis]
                          : node.metadata.kind === "experience"
                            ? "活动及回执来源"
                            : "未标注观点来源"}{" "}
                      · 版本 {node.metadata.revision} ·{" "}
                      {new Date(node.metadata.occurredAt).toLocaleString()}
                    </p>
                    {node.metadata.sourceIds.length ? (
                      node.metadata.sourceIds.map((id) => (
                        <button
                          className="inspection-link"
                          key={id}
                          onClick={() => onTrace(id)}
                        >
                          查看原始来源
                        </button>
                      ))
                    ) : (
                      <p>原始来源缺失，需核对。</p>
                    )}
                  </article>
                ))
              )}
            </div>
          ))}
          <h5>开放约定</h5>
          {!view.activities.some(
            (a) => a.kind === "commitment" && a.fulfillment === "pending",
          ) ? (
            <p className="inspection-muted">当前范围没有开放约定。</p>
          ) : (
            view.activities
              .filter(
                (a) => a.kind === "commitment" && a.fulfillment === "pending",
              )
              .map((a) => (
                <article className="continuous-activity" key={a.id}>
                  <h5>{a.title}</h5>
                  <p>{a.nextStep || a.goal}</p>
                  <p>
                    执行：{activityStateLabels[a.state]} · 投递{" "}
                    {a.deliveryIds.length} 条 · 反馈 {a.feedbackIds.length}{" "}
                    条。履约仍待确认。
                  </p>
                  {a.reevaluationRequired && (
                    <FieldMessage>
                      人物认识已变化，未执行计划需要重新评价。
                    </FieldMessage>
                  )}
                  <button
                    className="inspection-link"
                    onClick={() => onTrace(a.informationId)}
                  >
                    查看约定版本与来源
                  </button>
                </article>
              ))
          )}
        </>
      )}
    </section>
  );
}
