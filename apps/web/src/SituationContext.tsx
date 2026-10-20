import { useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "./components/ui.js";
import {
  situationAge,
  type SituationRequestContext,
} from "./situation-context.js";

type Tier = "light" | "heavy";
const bootstrapNames: Record<string, string> = {
  "cold-start": "冷启动",
  warming: "补充中",
  established: "已有上下文",
  contextual: "部分上下文",
  bootstrap: "证据不足",
};
const targetStatuses: Record<string, string> = {
  resolved: "已解析",
  ambiguous: "有歧义",
  unauthorized: "未授权",
  unrecognized: "未识别",
};
export function SituationContextSummary({
  context,
  loading,
  error,
  hasRequest,
}: {
  context: SituationRequestContext | null;
  loading: boolean;
  error: string | null;
  hasRequest: boolean;
}) {
  const missing = !hasRequest ? "未载入" : loading || error ? "—" : "未记录";
  const resolved =
    context?.targets.filter((target) => target.status === "resolved").length ??
    0;
  const targets = context?.targets
    .map(
      (target) =>
        `${target.kind === "group" ? "群" : "私聊"} ${target.name} · ${targetStatuses[target.status] ?? target.status}`,
    )
    .join("\n");
  const routes =
    context?.resolution === "unavailable"
      ? "不可用"
      : context?.resolution
        ? `${context.targets.length} 候选 · ${resolved} 已解析`
        : missing;
  return (
    <div
      className="situation-context-summary"
      aria-label="当前 tick 的请求状态"
    >
      <dl>
        <div>
          <dt>目标</dt>
          <dd title={targets || undefined}>{routes}</dd>
        </div>
        <div>
          <dt>冷启动</dt>
          <dd
            title={
              context?.historyCount !== null &&
              context?.historyCount !== undefined
                ? `该请求可见历史 ${context.historyCount} 条`
                : undefined
            }
          >
            {context?.bootstrap
              ? (bootstrapNames[context.bootstrap] ?? context.bootstrap)
              : missing}
          </dd>
        </div>
        <div>
          <dt>等待</dt>
          <dd
            title={
              context?.canWait === null || context?.canWait === undefined
                ? undefined
                : context.canWait
                  ? "该请求允许等待"
                  : "该请求未开放等待动作"
            }
          >
            {context?.attempt !== null &&
            context?.attempt !== undefined &&
            context.waitBudget !== null
              ? `已用 ${context.attempt}/${context.waitBudget}`
              : missing}
          </dd>
        </div>
        <div>
          <dt>积压</dt>
          <dd
            className={context?.backlog?.active ? "is-warning" : undefined}
            title={
              context?.backlog
                ? `最新 ${situationAge(context.backlog.newestMs)}，积压阈值 ${situationAge(context.backlog.thresholdMs)}`
                : undefined
            }
          >
            {context?.backlog
              ? `${context.backlog.active ? "有" : "无"} · 最旧 ${situationAge(context.backlog.oldestMs)}`
              : missing}
          </dd>
        </div>
      </dl>
      {(loading || error) && (
        <span className="situation-context-load" role="status">
          {error ? "请求上下文读取失败，稍后重试" : "读取请求中…"}
        </span>
      )}
    </div>
  );
}
export function SituationContextFab({
  open,
  onOpenChange,
  context,
  loading,
  error,
  tick,
  tier,
  tiers,
  onTierChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: SituationRequestContext | null;
  loading: boolean;
  error: string | null;
  tick: string;
  tier: Tier | null;
  tiers: Tier[];
  onTierChange: (tier: Tier) => void;
}) {
  const [section, setSection] = useState<
    "behavior" | "platform" | "background"
  >("background");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    onOpenChange(false);
    trigger.current?.focus();
  };
  return (
    <div className="situation-context-tools">
      <Button
        ref={trigger}
        className="situation-context-fab"
        aria-label={open ? "收起动态上下文" : "展开动态上下文"}
        aria-expanded={open}
        aria-controls="situation-context-panel"
        onClick={() => onOpenChange(!open)}
      >
        <SlidersHorizontal size={19} aria-hidden="true" />
        <span>上下文</span>
      </Button>
      {open && (
        <section
          id="situation-context-panel"
          className="situation-context-panel"
          aria-label="动态上下文"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <header>
            <div>
              <h2>动态上下文</h2>
              <p>
                {tick}
                {tier ? ` · ${tier === "heavy" ? "Heavy" : "Light"}` : ""}
              </p>
            </div>
            <Button aria-label="关闭动态上下文" onClick={close}>
              <X size={18} aria-hidden="true" />
            </Button>
          </header>
          {tiers.length > 1 && (
            <div
              className="situation-context-tiers"
              role="group"
              aria-label="查看模型请求"
            >
              {tiers.map((item) => (
                <Button
                  key={item}
                  aria-pressed={tier === item}
                  onClick={() => onTierChange(item)}
                >
                  {item === "heavy" ? "Heavy" : "Light"}
                </Button>
              ))}
            </div>
          )}
          <div
            className="situation-context-tabs"
            role="group"
            aria-label="上下文内容"
          >
            <Button
              aria-pressed={section === "behavior"}
              onClick={() => setSection("behavior")}
            >
              行为规则
            </Button>
            <Button
              aria-pressed={section === "platform"}
              onClick={() => setSection("platform")}
            >
              平台策略
            </Button>
            <Button
              aria-pressed={section === "background"}
              onClick={() => setSection("background")}
            >
              人物背景
            </Button>
          </div>
          <div
            className="situation-context-body"
            tabIndex={0}
            role="region"
            aria-label="请求上下文内容"
          >
            {loading ? (
              <p role="status">正在读取这条请求…</p>
            ) : error ? (
              <p role="alert">{error}。稍后自动重试。</p>
            ) : !context ? (
              <p>本 tick 尚无可读取的模型请求。</p>
            ) : section === "behavior" ? (
              <p className="situation-context-text">
                {context.behavior || "这条请求未单独记录行为规则。"}
              </p>
            ) : section === "platform" ? (
              <p className="situation-context-text">
                {context.platform || "这条请求未记录平台策略。"}
              </p>
            ) : context.background ? (
              <>
                <h3>{context.background.name || "未命名会话"}</h3>
                <p className="situation-context-scope">
                  {context.background.scope === "group"
                    ? "群聊"
                    : context.background.scope === "private"
                      ? "私聊"
                      : context.background.scope === "web"
                        ? "网页会话"
                        : context.background.scope}
                </p>
                {context.background.participants.length ? (
                  context.background.participants.map((person, index) => (
                    <div
                      className="situation-context-person"
                      key={`${person.label}:${index}`}
                    >
                      <strong>
                        {person.name || person.label || "未记录姓名"}
                      </strong>
                      <span>
                        {person.relation === "speaker"
                          ? "发言人"
                          : person.relation === "mentioned"
                            ? "被提及"
                            : "参与者"}{" "}
                        ·{" "}
                        {person.identityStatus === "complete"
                          ? "身份已解析"
                          : person.identityStatus || "身份未记录"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>未记录参与者。</p>
                )}
              </>
            ) : (
              <p>这条请求未记录会话人物背景。</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
