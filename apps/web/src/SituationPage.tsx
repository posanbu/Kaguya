import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type SituationView,
  type SituationStepView,
  type EvidenceRecord,
} from "@kaguya/schema";
import { useSituation } from "./use-situation.js";
import { situationStreams, situationTickWindow } from "./situation-stream.js";
import { Button } from "./components/ui.js";
import { useSituationContext } from "./use-situation-context.js";
import {
  SituationContextFab,
  SituationContextSummary,
} from "./SituationContext.js";
import "./situation.css";

type Frame = SituationView["frames"][number];
const phases = {
  blocked: "接续受阻：预算或工具交互未闭合",
  requested: "调用中",
  completed: "模型已完成",
  failed: "模型调用失败",
  cancelled: "模型调用已取消",
};
const actions: Record<string, string> = {
  message: "回应",
  silent: "沉默",
  wait: "等待",
  tool: "工具调用",
};
const statuses: Record<string, string> = {
  completed: "已发送",
  silent: "保持沉默",
  waiting: "等待期限",
  failed: "执行失败",
  superseded: "已被替代",
  interrupted: "已中断",
  unknown: "投递结果未知",
  pending: "结果待确认",
};
function sceneName(id: string) {
  try {
    const [platform, , kind, target] = JSON.parse(id);
    return `${platform} · ${kind === "group" ? "群" : kind === "private" ? "私聊" : "对话"} ${target ?? ""}`;
  } catch {
    return id || "尚未选择情境";
  }
}
function clock(at: string) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}
function tickName(offset: number) {
  return offset < 0 ? "TICK 回看" : offset === 0 ? "TICK 0" : `TICK −${offset}`;
}
function ConsolePane({
  title,
  count,
  context,
  primary = false,
  children,
}: {
  title: string;
  count: number;
  context?: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`situation-console-pane${primary ? " situation-console-primary" : ""}`}
      aria-label={title}
    >
      <header className="situation-pane-heading">
        <div className="situation-pane-title">
          <h2>{title}</h2>
          {context && <span className="situation-pane-context">{context}</span>}
        </div>
        <span>{String(count).padStart(2, "0")}</span>
      </header>
      <div
        className="situation-console-scroll"
        role="region"
        aria-label={`${title}内容`}
        tabIndex={0}
      >
        {children}
      </div>
    </section>
  );
}
function Evidence({ items }: { items: readonly EvidenceRecord[] }) {
  return items.length ? (
    items.toReversed().map((item) => (
      <article className="situation-log-entry" key={item.id}>
        <div className="situation-log-meta">
          <time
            dateTime={item.occurredAt}
            title={new Date(item.occurredAt).toLocaleString()}
          >
            {clock(item.occurredAt)}
          </time>
          <span className="situation-log-actor">{item.actorId}</span>
          <span className="situation-log-kind">[{item.kind}]</span>
        </div>
        <p>{item.text || "（无文本）"}</p>
      </article>
    ))
  ) : (
    <p className="situation-console-empty">暂无证据</p>
  );
}
function Step({ step }: { step: SituationStepView }) {
  return (
    <article className="situation-action" data-phase={step.phase}>
      <div className="situation-action-heading">
        <span className="situation-action-tier">
          {step.tier === "heavy" ? "Heavy" : "Light"}
        </span>
        <h4>
          {step.action
            ? (actions[step.action] ?? step.action)
            : phases[step.phase]}
        </h4>
      </div>
      <p className="situation-action-status">
        {phases[step.phase]}
        {step.phase === "completed" &&
          step.tier === "heavy" &&
          ` · ${statuses[step.status] ?? step.status}`}
      </p>
      {step.text && <p className="situation-action-text">{step.text}</p>}
      <p className="situation-action-reasoning" aria-label="可读推理">
        {step.reasoning ??
          (step.phase === "requested" ? "等待模型返回推理" : "未提供可读推理")}
      </p>
    </article>
  );
}
export function SituationPage({ token }: { token: string }) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextTier, setContextTier] = useState<"light" | "heavy">("heavy");
  const [selection, setSelection] = useState<{
    token: string;
    frame: Frame;
  } | null>(null);
  const state = useSituation(token);
  const data = state.data;
  const selectedFrame = selection?.token === token ? selection.frame : null;
  const selectFrame = (frame: Frame | null) =>
    setSelection(frame ? { token, frame } : null);
  const streams = situationStreams(data?.frames ?? []);
  const displayedScene = selectedFrame?.current.sceneId;
  const stream = displayedScene
    ? streams.find((item) => item.sceneId === displayedScene)
    : streams[0];
  const revisions = stream?.revisions ?? [];
  const frame = selectedFrame ?? revisions[0];
  const selectedIndex = frame
    ? revisions.findIndex((item) => item.id === frame.id)
    : -1;
  const ticks = frame
    ? situationTickWindow(revisions, frame, data?.steps ?? [], 2)
    : [];
  const currentSteps = ticks.find((tick) => tick.selected)?.steps ?? [];
  const lightStep = currentSteps.findLast((step) => step.tier === "light");
  const heavyStep = currentSteps.findLast((step) => step.tier === "heavy");
  const planningStep = lightStep ?? heavyStep;
  const inspectedStep =
    contextTier === "heavy"
      ? (heavyStep ?? lightStep)
      : (lightStep ?? heavyStep);
  const planningContext = useSituationContext(token, planningStep?.id);
  const extraContext = useSituationContext(
    token,
    inspectedStep?.id !== planningStep?.id ? inspectedStep?.id : undefined,
  );
  const inspectedContext =
    inspectedStep?.id === planningStep?.id ? planningContext : extraContext;
  const nativeRecall = inspectedContext.data?.memory;
  const visibleRecalls =
    nativeRecall && frame
      ? [
          {
            sceneId: frame.current.sceneId,
            revision: frame.id,
            items: nativeRecall.recalled.map(({ node }) => ({
              id: node.id,
              text: node.content,
              ownerId: node.metadata.ownerId,
              evidenceIds: node.metadata.sourceIds,
            })),
          },
        ]
      : [];
  const timeline = revisions.toReversed();
  const lastPosition = Math.max(0, timeline.length - 1);
  const position = selectedIndex < 0 ? 0 : lastPosition - selectedIndex;
  const majorPositions = new Set(
    Array.from({ length: 5 }, (_, index) =>
      Math.round((index * lastPosition) / 4),
    ),
  );
  const background =
    frame?.background.evidence.filter(
      (item) => item.sceneId !== frame.current.sceneId,
    ) ?? [];
  const canGoBack = selectedIndex >= 0 && selectedIndex < revisions.length - 1;
  const canGoForward = selectedIndex > 0;
  useLayoutEffect(() => {
    const board = boardRef.current;
    const lane = board?.querySelector<HTMLElement>(".is-selected");
    if (!board || !lane) return;
    // Center the selected tick without moving the page or the evidence panes.
    const boardBox = board.getBoundingClientRect();
    const laneBox = lane.getBoundingClientRect();
    board.scrollLeft +=
      laneBox.left - boardBox.left - (board.clientWidth - laneBox.width) / 2;
  }, [frame?.id]);
  return (
    <div className="situation-page" aria-label="情境工作台">
      {state.error && (
        <p className="situation-feedback" role="alert">
          读取失败：{state.error}。正在重试，保留上次状态。
        </p>
      )}
      <div className="situation-workspace">
        <SituationContextSummary
          context={planningContext.data ?? null}
          loading={
            !!planningStep && !planningContext.data && !planningContext.error
          }
          error={planningContext.error ?? null}
          hasRequest={!!planningStep}
        />
        <div className="situation-console">
          <div className="situation-console-grid">
            <ConsolePane
              title="当前情境"
              count={frame?.current.evidence.length ?? 0}
              context={frame ? sceneName(frame.current.sceneId) : ""}
              primary
            >
              {frame ? (
                <Evidence items={frame.current.evidence} />
              ) : (
                <p className="situation-console-empty">
                  {data ? "等待输入" : "正在读取情境…"}
                </p>
              )}
            </ConsolePane>
            <ConsolePane title="总背景" count={background.length}>
              <Evidence items={background} />
            </ConsolePane>
            <ConsolePane
              title="召回"
              count={
                visibleRecalls.reduce(
                  (count, recall) => count + recall.items.length,
                  0,
                ) ?? 0
              }
            >
              {visibleRecalls.length ? (
                visibleRecalls.map((recall) => (
                  <div
                    className="situation-recall"
                    key={`${recall.sceneId}:${recall.revision}`}
                  >
                    <p className="situation-recall-scene">
                      {sceneName(recall.sceneId)}
                    </p>
                    {recall.items.map((item) => (
                      <article className="situation-log-entry" key={item.id}>
                        <p>{item.text}</p>
                        <a
                          href={`/memory?focusId=${encodeURIComponent(item.id)}`}
                        >
                          对象 {item.ownerId} · 查看当前记忆
                        </a>
                      </article>
                    ))}
                  </div>
                ))
              ) : (
                <p className="situation-console-empty">
                  {inspectedContext.error || inspectedContext.data?.memoryError
                    ? "召回快照读取失败"
                    : inspectedStep && !inspectedContext.data
                      ? "正在读取请求快照…"
                      : !nativeRecall
                        ? "未记录"
                        : nativeRecall.status === "disabled"
                          ? "Memory 已禁用"
                          : "无动态召回"}
                </p>
              )}
            </ConsolePane>
          </div>
        </div>
        <section
          className="situation-action-workspace"
          aria-label="tick 行动台"
        >
          <div className="situation-tick-controls">
            <div className="situation-tick-ruler">
              <div className="situation-tick-rail" aria-hidden="true">
                <span
                  style={{
                    width: `${(position / Math.max(1, lastPosition)) * 100}%`,
                  }}
                />
              </div>
              <div className="situation-ruler-marks" aria-hidden="true">
                {timeline.map((item, index) => (
                  <span
                    key={item.id}
                    className={`situation-ruler-mark${majorPositions.has(index) ? " is-major" : ""}${index === Math.round(lastPosition / 2) ? " is-midpoint" : ""}${index === 0 ? " is-start" : index === lastPosition ? " is-end" : ""}`}
                    style={{
                      left: `${(index / Math.max(1, lastPosition)) * 100}%`,
                    }}
                  >
                    <i />
                    {majorPositions.has(index) && (
                      <time dateTime={item.frozenAt}>
                        {clock(item.frozenAt)}
                      </time>
                    )}
                  </span>
                ))}
              </div>
              <input
                type="range"
                aria-label="选择 tick"
                min={0}
                max={lastPosition}
                step={1}
                value={position}
                disabled={revisions.length < 2 || selectedIndex < 0}
                aria-valuetext={
                  frame
                    ? `${tickName(selectedIndex)} · ${clock(frame.frozenAt)}`
                    : "暂无 tick"
                }
                onChange={(event) =>
                  selectFrame(timeline[Number(event.target.value)]!)
                }
              />
            </div>
            <div className="situation-timeline-transport">
              <div className="situation-tick-current">
                <Button
                  aria-label="上一个 tick"
                  disabled={!canGoBack}
                  onClick={() => selectFrame(revisions[selectedIndex + 1]!)}
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                </Button>
                <Button
                  aria-label="下一个 tick"
                  disabled={!canGoForward}
                  onClick={() => selectFrame(revisions[selectedIndex - 1]!)}
                >
                  <ChevronRight size={18} aria-hidden="true" />
                </Button>
                <output title="以当前情境的最新快照为 TICK 0">
                  {frame ? tickName(selectedIndex) : "TICK —"}
                </output>
                {frame && (
                  <time dateTime={frame.frozenAt}>{clock(frame.frozenAt)}</time>
                )}
              </div>
              <div className="situation-timeline-actions">
                <span className="situation-last-refreshed">
                  上次刷新
                  {state.refreshedAt ? (
                    <time
                      dateTime={state.refreshedAt}
                      title={new Date(state.refreshedAt).toLocaleString()}
                    >
                      {clock(state.refreshedAt)}
                    </time>
                  ) : (
                    <span>—</span>
                  )}
                </span>
                <Button
                  disabled={!selectedFrame}
                  onClick={() => selectFrame(null)}
                >
                  回到最新
                </Button>
              </div>
            </div>
          </div>
          <div
            className="situation-tick-board"
            ref={boardRef}
            role="region"
            aria-label="当前及附近 tick 的行动"
            tabIndex={0}
          >
            {ticks.length ? (
              ticks.map((tick) => (
                <section
                  className={`situation-tick-lane${tick.selected ? " is-selected" : ""}`}
                  key={tick.frame.id}
                  aria-label={`${tickName(tick.offset)} 的行动`}
                >
                  <button
                    type="button"
                    className="situation-tick-lane-heading"
                    aria-pressed={tick.selected}
                    onClick={() => selectFrame(tick.frame)}
                  >
                    <span>
                      {tickName(tick.offset)}
                      {tick.selected && (
                        <span className="situation-tick-marker">当前</span>
                      )}
                    </span>
                    <time dateTime={tick.frame.frozenAt}>
                      {clock(tick.frame.frozenAt)}
                    </time>
                  </button>
                  <div
                    className="situation-tick-lane-content"
                    role="region"
                    aria-label={`${tickName(tick.offset)} 行动内容`}
                    tabIndex={0}
                  >
                    {tick.steps.length ? (
                      tick.steps.map((step) => (
                        <Step key={step.id} step={step} />
                      ))
                    ) : (
                      <p className="situation-tick-empty">暂无行动</p>
                    )}
                  </div>
                </section>
              ))
            ) : (
              <p className="situation-tick-empty">等待 tick</p>
            )}
          </div>
        </section>
        <SituationContextFab
          open={contextOpen}
          onOpenChange={setContextOpen}
          context={inspectedContext.data ?? null}
          loading={
            !!inspectedStep && !inspectedContext.data && !inspectedContext.error
          }
          error={inspectedContext.error ?? null}
          tick={frame ? tickName(selectedIndex) : "TICK —"}
          tier={inspectedStep?.tier ?? null}
          tiers={[
            ...(lightStep ? ["light" as const] : []),
            ...(heavyStep ? ["heavy" as const] : []),
          ]}
          onTierChange={setContextTier}
        />
      </div>
      {data?.truncated && (
        <p className="situation-history-limit">
          已载入 {data.frames.length} 份快照、{data.steps.length}{" "}
          次调用。更早记录见“检查”。
        </p>
      )}
    </div>
  );
}
