/**
 * 功能概述：主导航中的独立“记忆录入”页，以自然语言连续补充并核对实际持久化结果。
 * 主要职责：MemoryIngestion 维护来源类型、定向修改目标和可恢复会话，提交稳定 requestId；
 * JobResult 展示来源、歧义选择及新增/关联/修订/未处理结果。仅处理中轮询，失败保留草稿并可重试。
 * 代码库关系：复用工作台组件与共享 DTO；memory-ingestion-api.ts 负责认证和错误归一。
 * 输入输出与副作用：会话 ID 与未提交草稿保存在当前标签页 sessionStorage；Token 不保存。
 * 新录入显式切换上下文；旧会话可从历史选择恢复；服务器记录列表跨会话提供修改、删除及撤销；卸载取消读取，服务端已接受任务继续完成。
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { BookOpen, Send, Plus, X } from "lucide-react";
import {
  memoryIngestionJobSchema,
  memoryIngestionJobsSchema,
  GLOBAL_MEMORY_SCOPE_ID,
  type MemoryIngestionJob,
  type MemoryIngestionSubmission,
  type MemoryIngestionRecord,
} from "@kaguya/schema";
import {
  Button,
  FieldMessage,
  PageHeader,
  StatusBadge,
} from "./components/ui.js";
import {
  requestMemoryIngestion,
  ingestionErrorMessage,
  MemoryIngestionRequestError,
} from "./memory-ingestion-api.js";
import "./memory-ingestion.css";
import { MemoryRecords } from "./MemoryRecords.js";

const STORAGE_KEY = "memory:access-ingestion:v2";
interface Draft {
  sessionId: string;
  text: string;
  target?: MemoryIngestionRecord;
  sourceType: MemoryIngestionSubmission["sourceType"];
  sessions: { id: string; label: string }[];
  pending?: MemoryIngestionSubmission;
}
function loadDraft(): Draft {
  try {
    const stored = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Draft | null;
    if (stored?.sessionId && Array.isArray(stored.sessions)) return stored;
  } catch {
    /* 存储不可用时继续使用内存草稿。 */
  }
  return {
    sessionId: crypto.randomUUID(),
    text: "",
    sourceType: "user_statement",
    sessions: [],
  };
}
export const ingestionStatus: Record<MemoryIngestionJob["status"], string> = {
  queued: "已提交，等待整理",
  processing: "正在整理",
  clarification: "需要补充",
  succeeded: "已入库",
  partial: "部分完成",
  failed: "处理失败",
};
export function MemoryIngestion({ token }: { token: string }) {
  const [draft, setDraft] = useState(loadDraft);
  const [jobs, setJobs] = useState<MemoryIngestionJob[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const activeSession = useRef(draft.sessionId);
  activeSession.current = draft.sessionId;
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      /* 内存草稿仍可提交。 */
    }
  }, [draft]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setJobs([]);
    setResolutions({});
    const refresh = async () => {
      try {
        const data = await requestMemoryIngestion(
          token,
          `sessions/${encodeURIComponent(draft.sessionId)}`,
          memoryIngestionJobsSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setJobs(data.jobs);
        const latest = data.jobs.at(-1);
        if (
          latest?.targetClaimId &&
          (latest.status === "succeeded" || latest.status === "partial") &&
          latest.results.some(
            (result) =>
              result.status === "revised" || result.status === "linked",
          )
        )
          setDraft((current) => {
            const { target: _target, ...rest } = current;
            return rest;
          });
        setLoading(false);
        if (data.jobs[0])
          setDraft((current) => ({
            ...current,
            sourceType: data.jobs[0]!.sourceType,
          }));
        if (
          data.jobs.some(
            (j) => j.status === "queued" || j.status === "processing",
          )
        )
          timer = setTimeout(() => void refresh(), 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(message(cause));
          setLoading(false);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [token, draft.sessionId, revision]);
  const busy =
    sending ||
    jobs.some((j) => j.status === "queued" || j.status === "processing");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !draft.text.trim()) return;
    const input = draft.pending ?? {
      requestId: crypto.randomUUID(),
      sessionId: draft.sessionId,
      text: draft.text.trim(),
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      targetClaimId:
        draft.target?.claimId ??
        (jobs.at(-1)?.status === "clarification"
          ? (jobs.at(-1)?.targetClaimId ?? null)
          : null),
      sourceType: draft.sourceType,
      resolutions: Object.entries(resolutions).map(
        ([label, entityInformationId]) => ({ label, entityInformationId }),
      ),
    };
    setDraft((current) => ({ ...current, pending: input }));
    setSending(true);
    setError(undefined);
    try {
      await requestMemoryIngestion(token, "jobs", memoryIngestionJobSchema, {
        body: input,
      });
      if (!mounted.current || activeSession.current !== input.sessionId) return;
      setDraft((current) => {
        const { pending: _pending, ...rest } = current;
        return {
          ...rest,
          text: "",
          sessions: current.sessions.some((s) => s.id === input.sessionId)
            ? current.sessions
            : [
                ...current.sessions,
                { id: input.sessionId, label: input.text.slice(0, 28) },
              ].slice(-30),
        };
      });
      setRevision((r) => r + 1);
      textarea.current?.focus();
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof MemoryIngestionRequestError
          ? cause.message
          : "无法确认提交结果。请用“重新提交”确认，系统会复用同一条记录。",
      );
      if (cause instanceof MemoryIngestionRequestError && cause.status < 500)
        setDraft((current) => {
          const { pending: _pending, ...rest } = current;
          return rest;
        });
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  const retry = async (id: string) => {
    setSending(true);
    setError(undefined);
    try {
      await requestMemoryIngestion(
        token,
        `jobs/${encodeURIComponent(id)}/retry`,
        memoryIngestionJobSchema,
        { body: {} },
      );
      setRevision((r) => r + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSending(false);
    }
  };
  const newSession = () => {
    if (
      draft.text.trim() &&
      !window.confirm("开始新录入会清除尚未提交的草稿，是否继续？")
    )
      return;
    setDraft((current) => ({
      sessionId: crypto.randomUUID(),
      text: "",
      sourceType: current.sourceType,
      sessions: current.sessions,
    }));
    setError(undefined);
    setJobs([]);
    setResolutions({});
    textarea.current?.focus();
  };
  return (
    <main className="memory-ingestion-page">
      <PageHeader
        title="记忆录入"
        actions={
          <Button onClick={newSession} disabled={busy || !!draft.pending}>
            <Plus size={16} aria-hidden="true" />
            新录入
          </Button>
        }
      />
      <div className="ingestion-settings">
        <label>
          信息来源
          <select
            value={draft.sourceType}
            disabled={
              jobs.length > 0 || busy || !!draft.pending || !!draft.target
            }
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                sourceType: e.target.value as Draft["sourceType"],
              }))
            }
          >
            <option value="user_statement">用户陈述</option>
            <option value="character_setting">角色设定</option>
          </select>
        </label>
        {draft.sessions.length > 0 && (
          <label>
            录入记录
            <select
              aria-label="查看录入记录"
              value={
                draft.sessions.some((s) => s.id === draft.sessionId)
                  ? draft.sessionId
                  : ""
              }
              disabled={busy || !!draft.pending}
              onChange={(e) => {
                if (
                  draft.text.trim() &&
                  !window.confirm("切换记录会清除尚未提交的草稿，是否继续？")
                )
                  return;
                setDraft((d) => {
                  const { target: _target, ...rest } = d;
                  return { ...rest, sessionId: e.target.value, text: "" };
                });
                setError(undefined);
              }}
            >
              <option value="" disabled>
                当前新录入
              </option>
              {draft.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ingestion-workspace">
        <div className="ingestion-dialogue">
          {error && (
            <FieldMessage tone="error">
              {error}{" "}
              <Button
                onClick={() => {
                  setError(undefined);
                  setRevision((r) => r + 1);
                }}
              >
                刷新状态
              </Button>
            </FieldMessage>
          )}
          <section
            className="ingestion-conversation"
            aria-label="录入对话"
            aria-busy={loading}
          >
            {loading && !jobs.length ? (
              <FieldMessage>正在读取录入记录…</FieldMessage>
            ) : (
              !jobs.length && (
                <div className="ingestion-empty">
                  <BookOpen size={28} aria-hidden="true" />
                  <h2>{draft.target ? "修改已有记忆" : "从一段描述开始"}</h2>
                  <p>
                    {draft.target
                      ? "在下方告诉 Agent 这条记忆需要怎样修改。"
                      : "可以一次介绍多个人物，也可以在同一录入中继续补充或纠正。身份不明确时会请你确认。"}
                  </p>
                  {!draft.target && (
                    <Button
                      onClick={() => {
                        setDraft((d) => ({
                          ...d,
                          text: "小夏喜欢天文，和小林是从小认识的朋友。她不太喜欢咖啡。",
                        }));
                        textarea.current?.focus();
                      }}
                      disabled={!!draft.pending}
                    >
                      试填一段示例
                    </Button>
                  )}
                </div>
              )
            )}
            <ol className="ingestion-turns">
              {jobs.map((job, index) => (
                <li key={job.requestId}>
                  <div className="ingestion-original">
                    <span>你提供的内容</span>
                    <p>{job.text}</p>
                    <time dateTime={job.createdAt}>
                      {new Date(job.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <JobResult
                    job={job}
                    busy={busy}
                    onRetry={() => void retry(job.requestId)}
                    resolutions={resolutions}
                    onResolve={(label, id) =>
                      setResolutions((r) => ({ ...r, [label]: id }))
                    }
                    allowResolution={index === jobs.length - 1}
                  />
                </li>
              ))}
            </ol>
          </section>
          <form
            className="ingestion-composer"
            onSubmit={(event) => void submit(event)}
          >
            {draft.target && (
              <div className="ingestion-edit-target">
                <span>
                  修改：{draft.target.subjectLabel} · {draft.target.predicate}：
                  {draft.target.value}
                </span>
                <Button
                  disabled={busy || !!draft.pending}
                  aria-label="取消修改目标"
                  onClick={newSession}
                >
                  <X size={16} aria-hidden="true" />
                </Button>
              </div>
            )}
            <label htmlFor="memory-input">
              {draft.target
                ? "告诉 Agent 怎么修改"
                : jobs.at(-1)?.status === "clarification"
                  ? "补充说明"
                  : "要记住的内容"}
            </label>
            <textarea
              ref={textarea}
              id="memory-input"
              value={draft.text}
              disabled={!!draft.pending || sending}
              maxLength={12000}
              rows={4}
              placeholder={
                draft.target
                  ? "例如：把喜好改成绘画，其他信息保持不变。"
                  : "告诉 Agent 要记住什么，或说明需要怎样修改已有记忆……"
              }
              onChange={(e) =>
                setDraft((d) => ({ ...d, text: e.target.value }))
              }
            />
            <div className="ingestion-composer-actions">
              <span aria-live="polite">
                {busy
                  ? "处理完成后可以继续补充。"
                  : "提交后可核对新增、关联和修订的记录。"}
              </span>
              <Button
                type="submit"
                disabled={busy || loading || !draft.text.trim()}
              >
                <Send size={16} aria-hidden="true" />
                {sending
                  ? "正在提交…"
                  : draft.pending
                    ? "重新提交"
                    : draft.target
                      ? "发送修改指令"
                      : "发送给 Agent"}
              </Button>
            </div>
          </form>
        </div>
        <MemoryRecords
          token={token}
          revision={`${revision}:${jobs.map((job) => job.status).join(",")}`}
          busy={busy || !!draft.pending}
          onEdit={(record) => {
            setDraft((current) => ({
              ...current,
              sessionId: crypto.randomUUID(),
              sourceType: record.sourceType,
              target: record,
            }));
            setError(undefined);
            setJobs([]);
            textarea.current?.focus();
            textarea.current?.scrollIntoView({
              behavior: "auto",
              block: "center",
            });
          }}
          onChanged={(record) => {
            if (
              draft.target?.subjectInformationId ===
                record.subjectInformationId &&
              draft.target.predicate === record.predicate
            )
              setDraft((current) => {
                const { target: _target, ...rest } = current;
                return rest;
              });
          }}
        />
      </div>
    </main>
  );
}
export function JobResult({
  job,
  busy,
  onRetry,
  resolutions,
  onResolve,
  allowResolution,
}: {
  job: MemoryIngestionJob;
  busy: boolean;
  onRetry: () => void;
  resolutions: Record<string, string>;
  onResolve: (label: string, id: string) => void;
  allowResolution: boolean;
}) {
  const labels = {
    new: "新增",
    linked: "关联已有",
    revised: "修订",
    unprocessed: "未处理",
  };
  return (
    <div className="ingestion-result">
      <div className="ingestion-result-heading" aria-live="polite">
        <strong>整理结果</strong>
        <StatusBadge
          tone={
            job.status === "failed"
              ? "error"
              : job.status === "succeeded"
                ? "success"
                : "neutral"
          }
        >
          {ingestionStatus[job.status]}
        </StatusBadge>
      </div>
      {job.errorCode && (
        <FieldMessage tone="error">
          {ingestionErrorMessage(job.errorCode)}
        </FieldMessage>
      )}
      {job.questions.map((question, index) => (
        <p key={index}>{question}</p>
      ))}
      {allowResolution &&
        job.ambiguities.map((ambiguity) => (
          <fieldset key={ambiguity.label} className="ingestion-candidates">
            <legend>选择“{ambiguity.label}”的身份</legend>
            {ambiguity.candidates.map((candidate) => (
              <label key={candidate.entityInformationId}>
                <input
                  type="radio"
                  name={`identity-${ambiguity.label}`}
                  value={candidate.entityInformationId}
                  checked={
                    resolutions[ambiguity.label] ===
                    candidate.entityInformationId
                  }
                  onChange={() =>
                    onResolve(ambiguity.label, candidate.entityInformationId)
                  }
                />
                <span>
                  {candidate.label}
                  <small>
                    {candidate.description} · {candidate.entityInformationId}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      {job.results.length > 0 && (
        <ul className="ingestion-records">
          {job.results.map((result, index) => (
            <li key={index}>
              <span>{labels[result.status]}</span>
              <div>
                {result.label}
                {result.sourceInformationId && (
                  <details>
                    <summary>查看来源与记录</summary>
                    <dl>
                      {Object.entries({
                        原文来源: result.sourceInformationId,
                        记忆记录: result.claimId,
                        主体: result.entityInformationId,
                        修订自: result.supersedesClaimId,
                      })
                        .filter(([, value]) => value)
                        .map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                    </dl>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {job.status === "failed" && job.errorCode !== "incompatible_contract" && (
        <Button onClick={onRetry} disabled={busy}>
          重试这一条
        </Button>
      )}
    </div>
  );
}
function message(error: unknown): string {
  return error instanceof MemoryIngestionRequestError
    ? error.message
    : "暂时无法连接服务。请刷新状态，已输入的内容会保留。";
}
