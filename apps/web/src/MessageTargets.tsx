/**
 * 功能概述：提供管理端跨会话消息的目标选择和两阶段确认界面。
 * 主要职责：选择来源对话、检索目录、明确选择候选并批准发送要求，查看生成正文后确认发送。
 * 代码库关系：App 路由到本页面，api.ts 复用 management Token；后台统一 message intent 处理生成与投递。
 * 输入输出与副作用：仅点击按钮时发起操作；页面离开清除本地内容，不自动批准、不持久化 Token 或消息。
 */
import "./message-targets.css";
import { useState } from "react";
import { z } from "@kaguya/schema";
import { messageTargetRequest } from "./api.js";
const target = z.object({
  adapterId: z.string(),
  platform: z.string(),
  destination: z.union([
    z.object({ kind: z.literal("group"), groupId: z.string() }),
    z.object({ kind: z.literal("private"), userId: z.string() }),
    z.object({ kind: z.literal("web") }),
  ]),
});
type Target = z.infer<typeof target>;
const candidate = z.object({ reference: z.string(), name: z.string(), target });
const source = z.object({
  informationId: z.string(),
  occurredAt: z.string(),
  target,
});
function label(value: Target) {
  const d = value.destination;
  return `${value.platform} / ${value.adapterId} / ${d.kind === "group" ? `群 ${d.groupId}` : d.kind === "private" ? `用户 ${d.userId}` : "Web 对话"}`;
}
const statusLabels: Record<string, string> = {
  resolved: "请选择目标并确认发送要求",
  ambiguous: "请明确选择候选，不会自动发送",
  "not-found": "未找到目标",
  unavailable: "目录暂不可用",
  unauthorized: "目标未授权",
  expired: "批准已过期，请重新查询并确认",
  composing: "正在生成正文，请稍后刷新",
  "confirmation-required": "请审阅生成正文后确认",
  confirmed: "正文已确认，已提交投递处理",
  conflict: "确认已处理或正文不匹配",
};
export function MessageTargets({
  token,
  onBack,
}: {
  token: string;
  onBack: () => void;
}) {
  const [sources, setSources] = useState<z.infer<typeof source>[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"id" | "name" | "description">("name");
  const [candidates, setCandidates] = useState<z.infer<typeof candidate>[]>([]);
  const [chosen, setChosen] = useState("");
  const [instruction, setInstruction] = useState("");
  const [requestId, setRequestId] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch {
      setStatus("请求失败，请检查权限或重新选择目标");
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const result = z
      .object({
        status: z.string(),
        assistantInformationId: z.string().optional(),
        text: z.string().optional(),
      })
      .parse(await messageTargetRequest({ token }, "status", { requestId }));
    setStatus(statusLabels[result.status] ?? result.status);
    setAssistantId(result.assistantInformationId ?? "");
    setText(result.text ?? "");
  }
  return (
    <main className="app-shell message-targets">
      <header className="topbar">
        <h1>跨会话消息</h1>
        <button className="secondary-button" onClick={onBack}>
          返回
        </button>
      </header>
      <section className="connection-panel target-form">
        <p>
          仅向获准目标发送。发送要求和最终正文均需由你确认，原对话历史不会自动带入。
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setSources(
                z
                  .array(source)
                  .parse(await messageTargetRequest({ token }, "sources", {})),
              ),
            )
          }
        >
          加载近期来源对话
        </button>
        <label>
          来源对话
          <select
            disabled={busy || !!requestId}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">请选择</option>
            {sources.map((s) => (
              <option key={s.informationId} value={s.informationId}>
                {label(s.target)} · {s.occurredAt}
              </option>
            ))}
          </select>
        </label>
        <label>
          查找方式
          <select
            disabled={busy || !!requestId}
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="name">完整名称</option>
            <option value="id">精确号码</option>
            <option value="description">描述中的名称</option>
          </select>
        </label>
        <label>
          目标
          <input
            disabled={busy || !!requestId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          disabled={busy || !query.trim() || !!requestId}
          onClick={() =>
            void run(async () => {
              setCandidates([]);
              setChosen("");
              const result = z
                .object({
                  status: z.string(),
                  candidates: z.array(candidate).optional(),
                })
                .parse(
                  await messageTargetRequest({ token }, "resolve", {
                    mode,
                    value: query,
                  }),
                );
              setCandidates(result.candidates ?? []);
              setStatus(statusLabels[result.status] ?? result.status);
            })
          }
        >
          查询可达目标
        </button>
        {candidates.map((c) => (
          <label key={c.reference}>
            <input
              type="radio"
              name="target"
              disabled={busy || !!requestId}
              checked={chosen === c.reference}
              onChange={() => setChosen(c.reference)}
            />
            {c.name} · {label(c.target)}
          </label>
        ))}
        <label>
          批准发送的要求与资料
          <textarea
            disabled={busy || !!requestId}
            maxLength={16000}
            rows={5}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
        <button
          disabled={
            busy || !chosen || !sourceId || !instruction.trim() || !!requestId
          }
          onClick={() =>
            void run(async () => {
              const result = z
                .object({
                  status: z.string(),
                  requestId: z.string().optional(),
                })
                .parse(
                  await messageTargetRequest({ token }, "authorize", {
                    reference: chosen,
                    sourceTurnContextInformationId: sourceId,
                    instruction,
                  }),
                );
              setRequestId(result.requestId ?? "");
              setStatus(statusLabels[result.status] ?? result.status);
            })
          }
        >
          确认目标与发送要求，生成正文
        </button>
        {requestId && (
          <>
            <button disabled={busy} onClick={() => void run(refresh)}>
              刷新生成结果
            </button>
            <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
            <button
              disabled={busy || !assistantId || !text}
              onClick={() =>
                void run(async () => {
                  const result = z.object({ status: z.string() }).parse(
                    await messageTargetRequest({ token }, "confirm", {
                      requestId,
                      assistantInformationId: assistantId,
                      text,
                    }),
                  );
                  setStatus(statusLabels[result.status] ?? result.status);
                  setAssistantId("");
                })
              }
            >
              确认以上正文并发送
            </button>
          </>
        )}
        {requestId && (
          <button
            disabled={busy}
            onClick={() => {
              setRequestId("");
              setAssistantId("");
              setText("");
              setCandidates([]);
              setChosen("");
              setStatus("");
            }}
          >
            新建请求
          </button>
        )}
        <p role="status">{status}</p>
      </section>
    </main>
  );
}
