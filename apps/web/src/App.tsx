import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
  SendHorizontal,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useMemo, useRef, useState } from "react";

import {
  checkGatewayHealth,
  GatewayRequestError,
  MAX_MESSAGE_LENGTH,
  sendMessage,
} from "./api.js";

const DEFAULT_GATEWAY_URL =
  import.meta.env.VITE_KAGUYA_API_URL ?? "http://127.0.0.1:3000";
const GATEWAY_URL_KEY = "kaguya.gatewayUrl";
const SESSION_ID_KEY = "kaguya.sessionId";
const TOKEN_KEY = "kaguya.gatewayToken";

type DeliveryState = "sending" | "accepted" | "failed";
type HealthState = "idle" | "checking" | "online" | "offline";

interface ChatMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: Date;
  readonly state: DeliveryState;
  readonly requestId?: string;
  readonly error?: string;
}

export function App() {
  const [gatewayUrl, setGatewayUrl] = useState(() =>
    readStorage(localStorage, GATEWAY_URL_KEY, DEFAULT_GATEWAY_URL),
  );
  const [sessionId, setSessionId] = useState(() =>
    readStorage(localStorage, SESSION_ID_KEY, createSessionId()),
  );
  const [token, setToken] = useState(() =>
    readStorage(sessionStorage, TOKEN_KEY, ""),
  );
  const [showToken, setShowToken] = useState(false);
  const [healthState, setHealthState] = useState<HealthState>("idle");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [formError, setFormError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isSending = messages.some((message) => message.state === "sending");
  const draftLength = useMemo(() => [...draft].length, [draft]);
  const canSend =
    !isSending && draft.trim().length > 0 && draftLength <= MAX_MESSAGE_LENGTH;

  const persistConnection = () => {
    localStorage.setItem(GATEWAY_URL_KEY, gatewayUrl.trim());
    localStorage.setItem(SESSION_ID_KEY, sessionId.trim());
    sessionStorage.setItem(TOKEN_KEY, token);
  };

  const checkConnection = async () => {
    setHealthState("checking");
    setFormError(undefined);
    persistConnection();
    try {
      await checkGatewayHealth(gatewayUrl);
      setHealthState("online");
    } catch (error) {
      setHealthState("offline");
      setFormError(errorMessage(error));
    }
  };

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) {
      return;
    }

    persistConnection();
    setFormError(undefined);
    const text = draft;
    const id = crypto.randomUUID();
    const pendingMessage: ChatMessage = {
      id,
      text,
      createdAt: new Date(),
      state: "sending",
    };
    setMessages((current) => [...current, pendingMessage]);
    setDraft("");

    try {
      const response = await sendMessage(
        { baseUrl: gatewayUrl, token },
        { sessionId, text },
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === id
            ? {
                ...message,
                state: "accepted",
                requestId: response.requestId,
              }
            : message,
        ),
      );
    } catch (error) {
      const message = errorMessage(error);
      setMessages((current) =>
        current.map((item) =>
          item.id === id ? { ...item, state: "failed", error: message } : item,
        ),
      );
      setFormError(message);
    } finally {
      textareaRef.current?.focus();
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submitMessage();
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          K
        </div>
        <div>
          <h1>Kaguya</h1>
          <p>应用消息网关</p>
        </div>
      </header>

      <main className="workspace">
        <aside className="connection-panel" aria-labelledby="connection-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">连接配置</p>
              <h2 id="connection-title">API 网关</h2>
            </div>
            <button
              type="button"
              className={`health-button ${healthState}`}
              onClick={() => void checkConnection()}
              disabled={healthState === "checking"}
              title="检测 API 网关连接"
            >
              <RefreshCw
                className={healthState === "checking" ? "spin" : undefined}
                size={15}
              />
              <span>{healthLabel(healthState)}</span>
            </button>
          </div>

          <label className="field">
            <span>网关地址</span>
            <input
              type="url"
              value={gatewayUrl}
              onChange={(event) => setGatewayUrl(event.target.value)}
              onBlur={persistConnection}
              placeholder="http://127.0.0.1:3000"
              autoComplete="url"
            />
          </label>

          <label className="field">
            <span>Bearer Token</span>
            <div className="password-field">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onBlur={persistConnection}
                placeholder="输入网关令牌"
                autoComplete="current-password"
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowToken((current) => !current)}
                aria-label={showToken ? "隐藏令牌" : "显示令牌"}
                title={showToken ? "隐藏令牌" : "显示令牌"}
              >
                {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          <label className="field">
            <span>会话 ID</span>
            <input
              type="text"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              onBlur={persistConnection}
              maxLength={256}
              placeholder="web-xxxxxxxx"
              autoComplete="off"
            />
          </label>

          <div className="boundary-note">
            <p>当前网关仅接收消息。</p>
            <span>模型配置和回复由核心层管理。</span>
          </div>
        </aside>

        <section className="chat-panel" aria-labelledby="chat-title">
          <header className="chat-heading">
            <div>
              <p className="eyebrow">当前会话</p>
              <h2 id="chat-title">消息</h2>
            </div>
            <span className="session-label" title={sessionId || "未设置会话"}>
              {sessionId || "未设置会话"}
            </span>
          </header>

          <div className="message-list" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <p>暂无消息</p>
              </div>
            ) : (
              messages.map((message) => (
                <article className="message-row" key={message.id}>
                  <div className="message-meta">
                    <strong>你</strong>
                    <time dateTime={message.createdAt.toISOString()}>
                      {formatTime(message.createdAt)}
                    </time>
                  </div>
                  <p className="message-body">{message.text}</p>
                  <DeliveryStatus message={message} />
                </article>
              ))
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => void submitMessage(event)}
          >
            {formError ? (
              <div className="error-banner" role="alert">
                <AlertCircle size={17} />
                <span>{formError}</span>
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={3}
              placeholder="输入消息"
              aria-label="消息内容"
            />
            <div className="composer-footer">
              <span
                className={
                  draftLength > MAX_MESSAGE_LENGTH ? "limit exceeded" : "limit"
                }
              >
                {draftLength.toLocaleString()} /{" "}
                {MAX_MESSAGE_LENGTH.toLocaleString()}
              </span>
              <button className="send-button" type="submit" disabled={!canSend}>
                {isSending ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <SendHorizontal size={18} />
                )}
                <span>{isSending ? "发送中" : "发送"}</span>
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

function DeliveryStatus({ message }: { message: ChatMessage }) {
  if (message.state === "sending") {
    return (
      <p className="delivery-status sending">
        <LoaderCircle className="spin" size={15} />
        正在提交
      </p>
    );
  }
  if (message.state === "accepted") {
    return (
      <p className="delivery-status accepted" title={message.requestId}>
        <CheckCircle2 size={15} />
        网关已接收
        <code>{shortRequestId(message.requestId)}</code>
      </p>
    );
  }
  return (
    <p className="delivery-status failed">
      <AlertCircle size={15} />
      {message.error ?? "提交失败"}
    </p>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof GatewayRequestError) {
    if (error.code === "core_unavailable") {
      return "核心消息入口尚未接入";
    }
    if (error.code === "unauthorized") {
      return "网关令牌无效";
    }
    if (error.code === "rate_limited") {
      return "请求过于频繁，请稍后再试";
    }
    return error.message;
  }
  return "发送消息时发生未知错误";
}

function healthLabel(state: HealthState): string {
  if (state === "checking") {
    return "检测中";
  }
  if (state === "online") {
    return "网关可用";
  }
  if (state === "offline") {
    return "连接失败";
  }
  return "检测连接";
}

function readStorage(storage: Storage, key: string, fallback: string): string {
  try {
    return storage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function createSessionId(): string {
  return `web-${crypto.randomUUID().slice(0, 8)}`;
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function shortRequestId(requestId: string | undefined): string {
  if (!requestId) {
    return "";
  }
  return requestId.length > 12 ? `${requestId.slice(0, 12)}...` : requestId;
}
