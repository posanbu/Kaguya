import { useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "./components/ui.js";
import {
  situationAge,
  type SituationRequestContext,
} from "./situation-context.js";

type Tier = "light" | "heavy";
const bootstrapNames: Record<string, string> = {
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
          <dt>上下文</dt>
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
    | "behavior"
    | "platform"
    | "background"
    | "conversation"
    | "self"
    | "expression"
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
        aria-label={open ? "收起请求上下文" : "展开请求上下文"}
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
          aria-label="请求上下文"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <header>
            <div>
              <h2>请求上下文</h2>
              <p>
                {tick}
                {tier ? ` · ${tier === "heavy" ? "Heavy" : "Light"}` : ""}
              </p>
            </div>
            <Button aria-label="关闭请求上下文" onClick={close}>
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
            {(
              [
                ["conversation", "群聊属性"],
                ["self", "自我认识"],
                ["expression", "表达习惯"],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                aria-pressed={section === id}
                onClick={() => setSection(id)}
              >
                {label}
              </Button>
            ))}
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
            ) : section === "conversation" ||
              section === "self" ||
              section === "expression" ? (
              <>
                {section === "self" && (
                  <details>
                    <summary>自身身份 Prompt 原文</summary>
                    <pre className="situation-context-text">
                      {context.identityRaw ?? "未记录"}
                    </pre>
                  </details>
                )}
                <FixedMemoryEntries context={context} kind={section} />
              </>
            ) : (
              <PersonBackground context={context} />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function FixedMemoryEntries({
  context,
  kind,
  ownerId,
  excludeOwners,
}: {
  context: SituationRequestContext;
  kind: "person" | "conversation" | "self" | "expression";
  ownerId?: string;
  excludeOwners?: string[];
}) {
  if (context.memoryError) return <p role="alert">{context.memoryError}</p>;
  if (!context.memory) return <p>此请求未记录固定记忆。</p>;
  if (context.memory.status === "disabled")
    return <p>此请求的 Memory 已关闭。</p>;
  const items = context.memory.fixed.filter(
    (n) =>
      n.metadata.kind === kind &&
      (!ownerId || n.metadata.ownerId === ownerId) &&
      !excludeOwners?.includes(n.metadata.ownerId),
  );
  if (excludeOwners && !items.length) return null;
  return (
    <section aria-label="固定注入记忆">
      {!ownerId && (
        <>
          <h3>固定记忆</h3>
          <p>按对象与范围注入，不经过关键词或相似度筛选。</p>
        </>
      )}
      {items.length ? (
        items.map((node) => (
          <article key={node.id} className="situation-context-memory-entry">
            <p className="situation-context-text">{node.content}</p>
            <span>
              level 0 · 版本 {node.metadata.revision} · {node.metadata.status}
            </span>
            <details>
              <summary>范围与来源</summary>
              <p>对象：{node.metadata.ownerId}</p>
              <p>范围：{node.metadata.scope}</p>
              <p>记录时间：{node.metadata.occurredAt}</p>
              {node.metadata.evidence ? (
                <pre>{JSON.stringify(node.metadata.evidence, null, 2)}</pre>
              ) : (
                <p>证据类型未分类</p>
              )}
              <p>{node.metadata.sourceIds.join("、") || "手动记录"}</p>
            </details>
            <a href={`/memory?focusId=${encodeURIComponent(node.id)}`}>
              在记忆图中查看当前版本
            </a>
          </article>
        ))
      ) : (
        <p>此请求没有适用的固定摘要。</p>
      )}
    </section>
  );
}

/** Every displayed fact comes from this saved request, never the current graph. */
export function PersonBackground({
  context,
}: {
  context: SituationRequestContext;
}) {
  const people = context.background?.participants ?? [];
  const owners = people.flatMap((p) => (p.ownerId ? [p.ownerId] : []));
  return (
    <>
      <h3>{context.background?.name || "未记录会话名称"}</h3>
      <p className="situation-context-scope">
        {(
          { group: "群聊", private: "私聊", web: "网页会话" } as Record<
            string,
            string
          >
        )[context.background?.scope ?? ""] ?? context.background?.scope}
      </p>
      {people.length ? (
        people.map((person, index) => (
          <section
            className="situation-context-person"
            key={`${person.label}:${index}`}
            aria-label={person.name || person.label}
          >
            <h3>{person.name || person.label || "未记录姓名"}</h3>
            <p>
              {(
                {
                  speaker: "发言人",
                  mentioned: "被提及",
                  "replied-to": "被回复",
                  participant: "参与者",
                } as Record<string, string>
              )[person.relation] ?? person.relation}
            </p>
            {person.ownerId ? (
              <FixedMemoryEntries
                context={context}
                kind="person"
                ownerId={person.ownerId}
              />
            ) : (
              <p>此请求未记录人物关联。</p>
            )}
            <details>
              <summary>账号解析与来源原文</summary>
              <pre className="situation-context-text">{person.raw}</pre>
            </details>
          </section>
        ))
      ) : (
        <p>这条请求未记录参与者。</p>
      )}
      <FixedMemoryEntries
        context={context}
        kind="person"
        excludeOwners={owners}
      />
      {(context.memory?.recalled ?? [])
        .filter((r) => r.node.metadata.kind === "person")
        .map(({ node, truncated }) => (
          <article key={node.id} className="situation-context-memory-entry">
            <h3>本轮召回的人物背景</h3>
            <p>
              {node.content}
              {truncated ? "（已裁剪）" : ""}
            </p>
            <details>
              <summary>背景依据与时间</summary>
              <pre>{JSON.stringify(node.metadata, null, 2)}</pre>
            </details>
          </article>
        ))}
      {!!context.memory?.personCandidates?.length && (
        <section aria-label="人物候选">
          <h3>人物候选</h3>
          <p>这些结果是匹配线索，不表示已确认身份。</p>
          {context.memory.personCandidates.map((candidate) => (
            <article key={candidate.summary.id}>
              <p>{candidate.summary.content}</p>
              <details>
                <summary>匹配与来源</summary>
                <pre>{JSON.stringify(candidate, null, 2)}</pre>
              </details>
            </article>
          ))}
        </section>
      )}
      {context.recallRaw && (
        <details>
          <summary>本次表达已使用的补查结果</summary>
          <pre className="situation-context-text">{context.recallRaw}</pre>
        </details>
      )}
      <details>
        <summary>人物背景 Prompt 原文</summary>
        <pre className="situation-context-text">
          {context.backgroundRaw ?? "未记录"}
        </pre>
      </details>
      <details>
        <summary>上下文证据 Prompt 原文</summary>
        <pre className="situation-context-text">
          {context.evidenceRaw ?? "未记录"}
        </pre>
      </details>
    </>
  );
}
