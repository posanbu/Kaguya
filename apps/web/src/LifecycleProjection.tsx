/** 最新注册的规则投影独立于历史筛选与模型冻结时间。 */
import { lifecycleInspectionSchema } from "@kaguya/schema";
import { situationAge } from "./situation-context.js";
import { Button, FieldMessage } from "./components/ui.js";
import { useInspection } from "./use-inspection.js";

export function LifecycleProjection({
  token,
  revision,
  openRecord,
}: {
  token: string;
  revision: number;
  openRecord: (id: string, button: HTMLButtonElement) => void;
}) {
  const state = useInspection(
    token,
    "lifecycle",
    lifecycleInspectionSchema,
    revision,
  );
  const root = state.data?.latest;
  const snapshot = root?.snapshot;
  const span = snapshot?.timeline.at(-1);
  const age =
    Date.parse(state.data?.readAt ?? "") - Date.parse(snapshot?.at ?? "");
  return (
    <section className="developer-card" aria-label="当前活动投影">
      <h3>当前活动投影</h3>
      {state.error ? (
        <FieldMessage tone="error">读取失败：{state.error}</FieldMessage>
      ) : !state.data ? (
        <FieldMessage>正在读取最新记录…</FieldMessage>
      ) : !root ? (
        <FieldMessage>尚无生命周期状态记录，当前活动未知。</FieldMessage>
      ) : (
        <>
          {snapshot ? (
            <>
              <p>
                {snapshot.state === "awake" ? "清醒" : "睡眠"} ·{" "}
                {span
                  ? {
                      idle: "空闲",
                      observing: "观察",
                      working: "处理任务",
                      sleeping: "睡眠",
                    }[span.activity]
                  : "活动未记录"}
                {span?.scopeKey && ` · ${span.scopeKey}`}
              </p>
              <p>
                最近推进{" "}
                <time dateTime={snapshot.at}>
                  {new Date(snapshot.at).toLocaleString()}
                </time>
                {" · "}
                {Number.isFinite(age) && age >= 0
                  ? `读取时距该次推进 ${situationAge(age)}`
                  : "推进时间差未知"}
              </p>
            </>
          ) : (
            <FieldMessage>最新记录缺少可读状态，当前活动未知。</FieldMessage>
          )}
          <Button
            onClick={(event) =>
              openRecord(root.informationId, event.currentTarget)
            }
          >
            查看投影来源
          </Button>
        </>
      )}
    </section>
  );
}
