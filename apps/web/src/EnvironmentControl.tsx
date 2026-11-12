/**
 * 功能概述：现有领域检视中的小型 GUI 管理区，明确区分自动任务与人工控制。
 * EnvironmentControl 用 GET 读取实际控制状态；HumanDesktop 显式接管/续期/关闭/恢复，截图绑定 generation 与观察有效期。
 * GuiTaskForm 在发送前把原 UUID 写入 URL；丢回执只查询原任务，不在刷新时重新提交。
 * 人工操作按 operationId 查询；任何输入消费旧观察，断网/隐藏/401/代际变化立即停止本地输入并清截图。
 * 身份仅为共享管理员通道；会话秘密仍由服务端持有，Blob URL 在替换和卸载时撤销；不连接外部模型。
 */
import { useEffect, useRef, useState } from "react";
import { Button, FieldMessage } from "./components/ui.js";
import { useWorkbenchNavigate } from "./components/AppShell.js";
import { GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
import { InspectionReference } from "./InspectionReference.js";
import { readInspectionLocation } from "./inspection-navigation.js";
import {
  environmentRequest,
  environmentPath,
  environmentListSchema,
  environmentControlSchema,
  guiTaskSchema,
  humanReceiptSchema,
  desktopCaptureSchema,
  readEnvironmentImage,
  type Control,
  type GuiTask,
  type HumanReceipt,
} from "./environment-api.js";
const controlLabels: Record<Control["state"], string> = {
  preparing: "准备中",
  ready: "自动控制就绪",
  human: "人工控制",
  draining: "输入排空中",
  quarantined: "已隔离",
  isolation_failed: "隔离未确认",
};
const taskLabels: Record<GuiTask["status"], string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "结果未确认";
export function EnvironmentControl({
  token,
  scope,
  location,
}: {
  token: string;
  scope: string;
  location: string;
}) {
  const navigate = useWorkbenchNavigate();
  const selected = readInspectionLocation(location).selected;
  const [state, setState] = useState<{
    key: string;
    controls?: Control[];
    error?: string;
  }>({ key: "" });
  const [revision, setRevision] = useState(0);
  const key = `${token}:${scope}`;
  useEffect(() => {
    const controller = new AbortController();
    void environmentRequest(
      token,
      "/api/v1/environments",
      environmentListSchema,
      controller.signal,
    ).then(
      (data) => {
        if (!controller.signal.aborted)
          setState({
            key,
            controls: data.environments.filter((c) => c.scope === scope),
          });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ key, error: message(error) });
      },
    );
    return () => controller.abort();
  }, [token, scope, revision, key]);
  const controls = state.key === key ? state.controls : undefined;
  const control =
    controls?.find((c) => c.environmentId === selected) ??
    (!selected ? controls?.[0] : undefined);
  return (
    <section className="environment-control" aria-label="隔离桌面管理">
      <header className="domain-heading">
        <h3>隔离桌面</h3>
        <Button onClick={() => setRevision((n) => n + 1)}>刷新环境</Button>
      </header>
      {state.key === key && state.error ? (
        <FieldMessage tone="error">{state.error}</FieldMessage>
      ) : !controls ? (
        <p>正在读取已配置桌面…</p>
      ) : !controls.length ? (
        <p>此范围没有已配置的 GUI 桌面。</p>
      ) : (
        <>
          <label>
            桌面环境
            <select
              value={control?.environmentId ?? ""}
              onChange={(event) => {
                const params = new URLSearchParams(location.split("?")[1]);
                params.set("selected", event.target.value);
                params.delete("task");
                params.delete("operation");
                void navigate(`${location.split("?")[0]}?${params}`);
              }}
            >
              <option value="" disabled>
                选择已配置环境
              </option>
              {controls.map((c) => (
                <option key={c.environmentId}>{c.environmentId}</option>
              ))}
            </select>
          </label>
          {control ? (
            <ManagedDesktop
              key={`${token}:${control.environmentId}`}
              token={token}
              initial={control}
              location={location}
            />
          ) : (
            <p>所选环境不在当前范围。</p>
          )}
        </>
      )}
    </section>
  );
}
function ManagedDesktop({
  token,
  initial,
  location,
}: {
  token: string;
  initial: Control;
  location: string;
}) {
  const navigate = useWorkbenchNavigate();
  const [control, setControl] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const current = useRef(control);
  current.current = control;
  const alive = useRef(true),
    locked = useRef(false),
    sequence = useRef(0);
  const pending = useRef(new Set<AbortController>());
  const [capture, setCapture] = useState<{
    key: string;
    url: string;
    data: ReturnType<typeof desktopCaptureSchema.parse>;
  }>();
  const imageUrl = useRef<string | undefined>(undefined);
  const [receipt, setReceipt] = useState<HumanReceipt>();
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const operationId =
    new URLSearchParams(location.split("?")[1]).get("operation") ?? "";
  const expectedOperation = useRef(operationId);
  const controlRequest = useRef<
    | { action: string; generation: number; id: string; confirmed?: boolean }
    | undefined
  >(undefined);
  const clearImage = () => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = undefined;
    setCapture(undefined);
  };
  const disarm = () => {
    sequence.current++;
    setArmed(false);
    clearImage();
  };
  useEffect(() => {
    if (expectedOperation.current !== operationId) {
      disarm();
      setReceipt(undefined);
      expectedOperation.current = operationId;
    }
  }, [operationId]);
  const acceptControl = (value: Control) => {
    if (
      value.environmentId !== initial.environmentId ||
      value.scope !== initial.scope
    )
      throw new Error("桌面范围不匹配。");
    if (value.generation < current.current.generation) return;
    if (
      value.generation !== current.current.generation ||
      value.human?.sessionId !== current.current.human?.sessionId ||
      value.state !== "human"
    )
      disarm();
    current.current = value;
    setControl(value);
  };
  useEffect(() => {
    alive.current = true;
    const stop = () => {
      disarm();
      for (const c of pending.current) c.abort();
    };
    const hide = () => {
      if (document.visibilityState === "hidden") stop();
    };
    window.addEventListener("offline", stop);
    window.addEventListener(GATEWAY_UNAUTHORIZED_EVENT, stop);
    document.addEventListener("visibilitychange", hide);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const controller = new AbortController();
      pending.current.add(controller);
      try {
        if (document.visibilityState !== "hidden") {
          const ticket = sequence.current;
          const value = await environmentRequest(
            token,
            environmentPath(initial.environmentId, "control"),
            environmentControlSchema,
            controller.signal,
          );
          if (
            alive.current &&
            !controller.signal.aborted &&
            ticket === sequence.current
          )
            acceptControl(value);
        }
      } catch (e) {
        if (alive.current && !controller.signal.aborted) {
          disarm();
          setError(message(e));
        }
      } finally {
        pending.current.delete(controller);
        if (alive.current) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      alive.current = false;
      sequence.current++;
      clearTimeout(timer);
      for (const c of pending.current) c.abort();
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      window.removeEventListener("offline", stop);
      window.removeEventListener(GATEWAY_UNAUTHORIZED_EVENT, stop);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [token, initial.environmentId, initial.scope]);
  const expiry = Math.min(
    Date.parse(control.human?.expiresAt ?? "") || Infinity,
    Date.parse(capture?.data.expiresAt ?? "") || Infinity,
  );
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(disarm, Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry]);
  const execute = async (
    work: (signal: AbortSignal, ticket: number) => Promise<void>,
  ) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    pending.current.add(controller);
    const ticket = sequence.current;
    const timer = setTimeout(() => controller.abort(), 65000);
    try {
      await work(controller.signal, ticket);
    } catch (e) {
      if (alive.current) {
        disarm();
        setError(message(e));
      }
    } finally {
      clearTimeout(timer);
      pending.current.delete(controller);
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const valid = (signal: AbortSignal, ticket: number) =>
    alive.current && !signal.aborted && sequence.current === ticket;
  const session = () => {
    const c = current.current;
    if (
      !c.human ||
      c.state !== "human" ||
      Date.parse(c.human.expiresAt) <= Date.now() ||
      !navigator.onLine ||
      document.visibilityState === "hidden"
    )
      throw new Error("人工会话不可输入，请重新接管或续期。");
    return { generation: c.generation, sessionId: c.human.sessionId };
  };
  const manage = (
    action: "handoff" | "resume" | "human/renew" | "human/close",
  ) =>
    void execute(async (signal, ticket) => {
      disarm();
      const actionTicket = sequence.current;
      const c = current.current;
      const saved = window.history.state?.kaguyaControlRequest;
      if (
        !controlRequest.current &&
        saved?.environmentId === c.environmentId &&
        saved?.action === action &&
        (saved?.generation === c.generation ||
          saved?.generation + 1 === c.generation) &&
        typeof saved.id === "string"
      )
        controlRequest.current = saved;
      if (
        !controlRequest.current ||
        controlRequest.current.action !== action ||
        (controlRequest.current.generation !== c.generation &&
          (controlRequest.current.confirmed ||
            controlRequest.current.generation + 1 !== c.generation))
      )
        controlRequest.current = {
          action,
          generation: c.generation,
          id: crypto.randomUUID(),
          confirmed: false,
        };
      window.history.replaceState(
        {
          ...window.history.state,
          kaguyaControlRequest: {
            ...controlRequest.current,
            environmentId: c.environmentId,
          },
        },
        "",
      );
      const body =
        action === "handoff" || action === "resume"
          ? {
              generation: controlRequest.current.generation,
              controlAuthorizationId: controlRequest.current.id,
            }
          : session();
      const value = await environmentRequest(
        token,
        environmentPath(c.environmentId, action),
        environmentControlSchema,
        signal,
        body,
      );
      if (!valid(signal, actionTicket)) return;
      acceptControl(value);
      const confirmed = await environmentRequest(
        token,
        environmentPath(c.environmentId, "control"),
        environmentControlSchema,
        signal,
      );
      if (
        !alive.current ||
        signal.aborted ||
        confirmed.generation !== value.generation ||
        confirmed.state !== value.state ||
        current.current.generation !== value.generation
      )
        return;
      acceptControl(confirmed);
      controlRequest.current.confirmed = true;
      window.history.replaceState(
        {
          ...window.history.state,
          kaguyaControlRequest: {
            ...controlRequest.current,
            environmentId: c.environmentId,
          },
        },
        "",
      );
      if (
        (action === "handoff" || action === "human/renew") &&
        value.state === "human" &&
        value.human
      )
        setArmed(true);
      void ticket;
    });
  const humanOperation = (
    action: "human/observe" | "human/input",
    args: unknown,
  ) =>
    void execute(async (signal, ticket) => {
      if (!armed) throw new Error("请先明确接管或续期人工控制。");
      const human = session();
      const id = crypto.randomUUID();
      setReceipt(undefined);
      expectedOperation.current = id;
      const params = new URLSearchParams(window.location.search);
      params.set("operation", id);
      if (!(await navigate(`${window.location.pathname}?${params}`))) return;
      clearImage();
      const value = await environmentRequest(
        token,
        environmentPath(control.environmentId, action),
        humanReceiptSchema,
        signal,
        { ...human, operationId: id, arguments: args },
      );
      if (
        !valid(signal, ticket) ||
        new URLSearchParams(window.location.search).get("operation") !== id ||
        value.operationId !== id
      )
        return;
      setReceipt(value);
      if (action === "human/observe" && value.outcome.status === "succeeded") {
        const data = desktopCaptureSchema.parse(value.outcome.result);
        const artifact = value.outcome.artifacts.find(
          (a) => a.mime === "image/png" && a.hash === data.image.sha256,
        );
        if (
          !artifact ||
          data.observation.environmentId !== control.environmentId ||
          data.observation.generation !== human.generation ||
          Date.parse(data.expiresAt) <= Date.now()
        )
          throw new Error("截图与当前观察不匹配，请重新观察。");
        const blob = await readEnvironmentImage(
          token,
          control.environmentId,
          artifact.id,
          signal,
        );
        const hash = [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
          ),
        ]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        if (hash !== artifact.hash) throw new Error("截图校验失败。");
        if (
          !valid(signal, ticket) ||
          current.current.generation !== human.generation ||
          Date.parse(data.expiresAt) <= Date.now()
        )
          return;
        const url = URL.createObjectURL(blob);
        imageUrl.current = url;
        setCapture({
          key: `${human.generation}:${human.sessionId}`,
          url,
          data,
        });
      }
    });
  const image =
    capture?.key === `${control.generation}:${control.human?.sessionId}`
      ? capture
      : undefined;
  const canInput =
    armed &&
    control.state === "human" &&
    Boolean(control.human) &&
    !busy &&
    !!image &&
    Date.parse(image.data.expiresAt) > Date.now();
  const pendingControlRequest =
    controlRequest.current ??
    (typeof window !== "undefined"
      ? window.history.state?.kaguyaControlRequest
      : undefined);
  const canRetryHandoff =
    !pendingControlRequest?.confirmed &&
    pendingControlRequest?.action === "handoff" &&
    (pendingControlRequest?.generation === control.generation ||
      pendingControlRequest?.generation + 1 === control.generation);
  const canRetryResume =
    !pendingControlRequest?.confirmed &&
    pendingControlRequest?.action === "resume" &&
    (pendingControlRequest?.generation === control.generation ||
      pendingControlRequest?.generation + 1 === control.generation);
  const input = (args: Record<string, unknown>) => {
    if (!canInput || !image) return;
    humanOperation("human/input", {
      ...args,
      observation: image.data.observation,
    });
  };
  return (
    <>
      <div className="environment-state" role="status">
        {controlLabels[control.state]} · 代际 {control.generation}
        {control.human && <> · 人工会话有效至 {control.human.expiresAt}</>}
        {control.pendingControl && (
          <p>
            控制切换待确认：
            {control.pendingControl.mode === "human"
              ? "人工"
              : "自动"}，代际 {control.pendingControl.generation}
          </p>
        )}
      </div>
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      <div className="domain-controls">
        <Button
          disabled={
            busy ||
            canRetryResume ||
            (control.state !== "ready" && !canRetryHandoff)
          }
          onClick={() => manage("handoff")}
        >
          {canRetryHandoff ? "重试接管（原请求）" : "接管桌面"}
        </Button>
        <Button
          disabled={busy || control.state !== "human" || !control.human}
          onClick={() => manage("human/renew")}
        >
          续期并启用人工操作
        </Button>
        <Button
          disabled={busy || !armed || control.state !== "human"}
          onClick={() =>
            humanOperation("human/observe", { target: { kind: "desktop" } })
          }
        >
          观察桌面
        </Button>
        <Button
          disabled={busy || !control.human}
          onClick={() => manage("human/close")}
        >
          关闭人工输入
        </Button>
        <Button
          disabled={
            busy ||
            canRetryHandoff ||
            (!canRetryResume && !["human", "draining"].includes(control.state))
          }
          onClick={() => manage("resume")}
        >
          {canRetryResume ? "重试恢复（原请求）" : "恢复自动控制"}
        </Button>
      </div>
      <p>
        管理员通道。关闭、断网或过期停止人工输入并保持人工控制；恢复自动控制须等待服务端确认排空和新代际。
      </p>
      {image && (
        <figure className="gui-capture">
          <button
            type="button"
            aria-label="选择桌面点击坐标"
            disabled={!canInput}
            onClick={(event) => {
              const box = event.currentTarget
                .querySelector("img")!
                .getBoundingClientRect();
              setPoint({
                x: Math.min(
                  image.data.image.width - 1,
                  Math.max(
                    0,
                    Math.floor(
                      ((event.clientX - box.left) * image.data.image.width) /
                        box.width,
                    ),
                  ),
                ),
                y: Math.min(
                  image.data.image.height - 1,
                  Math.max(
                    0,
                    Math.floor(
                      ((event.clientY - box.top) * image.data.image.height) /
                        box.height,
                    ),
                  ),
                ),
              });
            }}
          >
            <img src={image.url} alt="当前人工桌面截图" />
          </button>
          <figcaption>
            原图 {image.data.image.width} × {image.data.image.height} ·
            观察有效至 {image.data.expiresAt}
          </figcaption>
        </figure>
      )}
      <div className="gui-input">
        <label>
          横坐标
          <input
            type="number"
            min={0}
            max={image ? image.data.image.width - 1 : 0}
            value={point.x}
            onChange={(e) => setPoint({ ...point, x: Number(e.target.value) })}
          />
        </label>
        <label>
          纵坐标
          <input
            type="number"
            min={0}
            max={image ? image.data.image.height - 1 : 0}
            value={point.y}
            onChange={(e) => setPoint({ ...point, y: Number(e.target.value) })}
          />
        </label>
        <Button
          disabled={
            !canInput ||
            point.x < 0 ||
            point.y < 0 ||
            point.x >= (image?.data.image.width ?? 0) ||
            point.y >= (image?.data.image.height ?? 0)
          }
          onClick={() =>
            input({ action: "click", selector: { kind: "pixel", ...point } })
          }
        >
          点击所选坐标
        </Button>
      </div>
      <form
        className="gui-input"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          input({
            action: "insert",
            selector: { kind: "pixel", ...point },
            text: String(form.get("text") ?? ""),
          });
        }}
      >
        <label>
          在所选坐标插入文本
          <input
            name="text"
            maxLength={4096}
            pattern="[\x09\x0a\x0d\x20-\x7e]+"
            title="当前坐标插入支持英文、数字及 ASCII 符号"
            placeholder="英文、数字及 ASCII 符号"
            required
          />
        </label>
        <Button type="submit" disabled={!canInput}>
          插入文本
        </Button>
      </form>
      <form
        className="gui-input"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          input({ action: "key", key: String(form.get("key")), modifiers: [] });
        }}
      >
        <label>
          按键
          <select name="key">
            {[
              "enter",
              "tab",
              "escape",
              "space",
              "backspace",
              "up",
              "down",
              "left",
              "right",
            ].map((key) => (
              <option key={key}>{key}</option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={!canInput}>
          发送按键
        </Button>
      </form>
      {operationId && (
        <section aria-label="人工操作结果">
          <p>
            操作 ID <code>{operationId}</code>
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void execute(async (signal, ticket) => {
                const value = await environmentRequest(
                  token,
                  environmentPath(
                    control.environmentId,
                    `human/operations/${encodeURIComponent(operationId)}`,
                  ),
                  humanReceiptSchema,
                  signal,
                );
                if (
                  valid(signal, ticket) &&
                  value.operationId === operationId &&
                  new URLSearchParams(window.location.search).get(
                    "operation",
                  ) === operationId
                )
                  setReceipt(value);
              })
            }
          >
            查询原操作
          </Button>
          {receipt && receipt.operationId === operationId && (
            <p>
              尝试 <code>{receipt.attemptId}</code> ·{" "}
              {
                {
                  succeeded: "已执行",
                  rejected: "已拒绝",
                  cancelled: "已取消",
                  partial: "部分完成",
                  unknown: "结果未知",
                }[receipt.outcome.status]
              }{" "}
              · 证据 {receipt.outcome.evidence}
              {receipt.outcome.truncated ? " · 回执已截断" : ""}
            </p>
          )}
        </section>
      )}
      <GuiTaskForm
        key={control.environmentId}
        token={token}
        control={control}
        location={location}
      />
    </>
  );
}
function GuiTaskForm({
  token,
  control,
  location,
}: {
  token: string;
  control: Control;
  location: string;
}) {
  const navigate = useWorkbenchNavigate();
  const taskId = new URLSearchParams(location.split("?")[1]).get("task") ?? "";
  const [task, setTask] = useState<GuiTask>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false),
    controller = useRef<AbortController | undefined>(undefined);
  const submitting = useRef(false),
    mounted = useRef(true);
  const requestIdentity = useRef(taskId);
  requestIdentity.current = taskId;
  const pendingIdentity = useRef("");
  useEffect(() => {
    if (pendingIdentity.current && pendingIdentity.current !== taskId)
      controller.current?.abort();
    if (!taskId) submitting.current = false;
    setError("");
  }, [taskId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const request = async (
    id: string,
    action: "read" | "cancel" | "submit",
    prompt?: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const c = new AbortController();
    controller.current = c;
    pendingIdentity.current = id;
    const timer = setTimeout(() => c.abort(), 65000);
    try {
      const value = await environmentRequest(
        token,
        environmentPath(
          control.environmentId,
          action === "submit"
            ? "tasks"
            : `tasks/${encodeURIComponent(id)}${action === "cancel" ? "/cancel" : ""}`,
        ),
        guiTaskSchema,
        c.signal,
        action === "read"
          ? undefined
          : action === "cancel"
            ? {}
            : { taskRequestId: id, prompt },
      );
      if (
        c.signal.aborted ||
        new URLSearchParams(window.location.search).get("task") !== id
      )
        return;
      if (
        value.taskRequestId !== id ||
        value.environmentId !== control.environmentId
      )
        throw new Error("任务身份不匹配。");
      setTask(value);
    } catch (e) {
      if (mounted.current && requestIdentity.current === id)
        setError(
          c.signal.aborted
            ? "请求结果未确认，请保留原任务 ID 查询。"
            : message(e),
        );
    } finally {
      clearTimeout(timer);
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const activeTask =
    task?.taskRequestId === taskId &&
    task.environmentId === control.environmentId
      ? task
      : undefined;
  return (
    <section className="gui-task" aria-label="GUI 任务">
      <h3>运行 GUI 任务</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (taskId || busy || lock.current || submitting.current) return;
          const prompt = String(
            new FormData(event.currentTarget).get("prompt") ?? "",
          ).trim();
          if (!prompt) return;
          submitting.current = true;
          const id = crypto.randomUUID(),
            params = new URLSearchParams(location.split("?")[1]);
          params.set("task", id);
          params.set("selected", control.environmentId);
          void navigate(`${location.split("?")[0]}?${params}`).then(
            (allowed) => {
              if (allowed) void request(id, "submit", prompt);
              else submitting.current = false;
            },
          );
        }}
      >
        <label>
          任务目标
          <textarea
            name="prompt"
            required
            maxLength={16000}
            disabled={Boolean(taskId)}
            placeholder="描述希望在隔离桌面中完成的任务"
          />
        </label>
        <Button
          type="submit"
          disabled={busy || Boolean(taskId) || control.state !== "ready"}
        >
          运行 GUI 任务
        </Button>
      </form>
      {taskId && (
        <>
          <p>
            用户任务 ID <code>{taskId}</code>
          </p>
          <div className="domain-controls">
            <Button
              disabled={busy}
              onClick={() => void request(taskId, "read")}
            >
              查询任务状态
            </Button>
            <Button
              disabled={
                busy ||
                activeTask?.status === "stopped" ||
                (activeTask?.cancellation !== null &&
                  activeTask?.cancellation !== undefined)
              }
              onClick={() => void request(taskId, "cancel")}
            >
              请求停止任务
            </Button>
            {activeTask?.terminal && (
              <Button
                disabled={busy}
                onClick={() => {
                  const params = new URLSearchParams(location.split("?")[1]);
                  params.delete("task");
                  setTask(undefined);
                  submitting.current = false;
                  void navigate(`${location.split("?")[0]}?${params}`);
                }}
              >
                新任务
              </Button>
            )}
          </div>
        </>
      )}
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
      {activeTask && (
        <>
          <p role="status">
            任务状态：{taskLabels[activeTask.status]}
            {activeTask.cancellation
              ? ` · ${activeTask.cancellation.state === "pending" ? "停止请求待转发" : "停止请求已转发"}`
              : ""}
          </p>
          {activeTask.cancellation && (
            <p>停止请求与执行结果分别记录；转发不表示效果撤回。</p>
          )}
          <InspectionReference
            reference={{
              domain: "gui-task",
              id: activeTask.requestedInformationId,
              relation: "查看任务来源与终态",
              availability: "available",
            }}
            location={location}
            context={readInspectionLocation(location, control.scope)}
          />
        </>
      )}
    </section>
  );
}
