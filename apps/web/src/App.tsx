import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Eye,
  EyeOff,
  LoaderCircle,
  Menu,
  MessageSquare,
  PanelLeftClose,
  Plus,
  RefreshCw,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    writeStorage(localStorage, GATEWAY_URL_KEY, gatewayUrl.trim());
    writeStorage(localStorage, SESSION_ID_KEY, sessionId.trim());
    writeStorage(sessionStorage, TOKEN_KEY, token);
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

  const createNewSession = () => {
    const nextSessionId = createSessionId();
    setSessionId(nextSessionId);
    setMessages([]);
    setFormError(undefined);
    writeStorage(localStorage, SESSION_ID_KEY, nextSessionId);
    setSidebarOpen(false);
    textareaRef.current?.focus();
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
      setHealthState("online");
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
    <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div
        className="sidebar-scrim"
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside className="sidebar" aria-label="会话导航">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            K
          </div>
          <div className="brand-copy">
            <strong>Kaguya</strong>
            <span>Gateway Console</span>
          </div>
          <button
            type="button"
            className="icon-action sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="关闭侧栏"
            title="关闭侧栏"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        <button
          type="button"
          className="new-session"
          onClick={createNewSession}
        >
          <Plus size={17} />
          <span>新建会话</span>
        </button>

        <div className="sidebar-section">
          <div className="sidebar-label">会话</div>
          <button type="button" className="nav-item active">
            <MessageSquare size={17} />
            <span>当前会话</span>
            <span className="nav-count">{messages.length}</span>
          </button>
        </div>

        <div className="sidebar-spacer" />

        <div className="gateway-status">
          <div className="status-line">
            <span className={`status-dot ${healthState}`} />
            <span>{healthLabel(healthState)}</span>
            <button
              type="button"
              className="status-refresh"
              onClick={() => void checkConnection()}
              disabled={healthState === "checking"}
              aria-label="刷新网关状态"
              title="刷新网关状态"
            >
              <RefreshCw
                size={13}
                className={healthState === "checking" ? "spin" : undefined}
              />
            </button>
          </div>
          <code title={gatewayUrl}>
            {gatewayUrl.replace(/^https?:\/\//u, "")}
          </code>
        </div>

        <button
          type="button"
          className="nav-item settings-link"
          onClick={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}
        >
          <Settings2 size={17} />
          <span>连接设置</span>
        </button>
        <div className="sidebar-footer">
          <span>SESSION</span>
          <code title={sessionId}>{sessionId}</code>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button
            type="button"
            className="icon-action menu-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开侧栏"
            title="打开侧栏"
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>工作区</span>
            <span className="breadcrumb-divider">/</span>
            <strong>当前会话</strong>
          </div>
          <div className="topbar-actions">
            <span className={`connection-pill ${healthState}`}>
              <Wifi size={14} />
              {healthLabel(healthState)}
            </span>
            <button
              type="button"
              className="icon-action"
              onClick={() => setSettingsOpen(true)}
              aria-label="打开连接设置"
              title="连接设置"
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>

        <main className="chat-panel">
          <header className="chat-heading">
            <div>
              <div className="chat-title-row">
                <div className="conversation-icon">
                  <MessageSquare size={18} />
                </div>
                <h1>当前会话</h1>
              </div>
              <p className="session-subtitle">{sessionId}</p>
            </div>
            <button
              type="button"
              className="icon-action subtle"
              onClick={() => setMessages([])}
              disabled={messages.length === 0}
              aria-label="清空消息"
              title="清空消息"
            >
              <Trash2 size={17} />
            </button>
          </header>

          <div className="message-list" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <MessageSquare size={23} />
                </div>
                <h2>开始一段对话</h2>
                <p>消息会通过当前网关提交给核心层</p>
                <button
                  type="button"
                  className="empty-action"
                  onClick={() => textareaRef.current?.focus()}
                >
                  <Plus size={16} /> 新建消息
                </button>
              </div>
            ) : (
              messages.map((message) => (
                <article className="message-row" key={message.id}>
                  <div className="message-avatar">你</div>
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>你</strong>
                      <time dateTime={message.createdAt.toISOString()}>
                        {formatTime(message.createdAt)}
                      </time>
                    </div>
                    <p className="message-body">{message.text}</p>
                    <DeliveryStatus message={message} />
                  </div>
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
                <AlertCircle size={16} />
                <span>{formError}</span>
                <button
                  type="button"
                  className="error-dismiss"
                  onClick={() => setFormError(undefined)}
                  aria-label="关闭错误提示"
                  title="关闭错误提示"
                >
                  <X size={15} />
                </button>
              </div>
            ) : null}
            <div className="composer-box">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={3}
                placeholder="输入消息，按 Enter 发送"
                aria-label="消息内容"
              />
              <div className="composer-footer">
                <div className="composer-hint">
                  <CircleHelp size={14} /> Shift + Enter 换行
                </div>
                <div className="composer-controls">
                  <span
                    className={
                      draftLength > MAX_MESSAGE_LENGTH
                        ? "limit exceeded"
                        : "limit"
                    }
                  >
                    {draftLength.toLocaleString()} /{" "}
                    {MAX_MESSAGE_LENGTH.toLocaleString()}
                  </span>
                  <button
                    className="send-button"
                    type="submit"
                    disabled={!canSend}
                  >
                    {isSending ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <SendHorizontal size={17} />
                    )}
                    <span>{isSending ? "发送中" : "发送"}</span>
                  </button>
                </div>
              </div>
            </div>
          </form>
        </main>
      </div>

      {settingsOpen ? (
        <div
          className="settings-layer"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <header className="settings-header">
              <div>
                <span className="eyebrow">工作区</span>
                <h2 id="settings-title">连接设置</h2>
              </div>
              <button
                type="button"
                className="icon-action"
                onClick={() => setSettingsOpen(false)}
                aria-label="关闭连接设置"
                title="关闭连接设置"
              >
                <X size={19} />
              </button>
            </header>
            <div className="settings-body">
              <div className="settings-note">
                <ShieldCheck size={17} />
                <span>令牌仅保存在当前浏览器会话中。</span>
              </div>
              <label className="field">
                <span>网关地址</span>
                <input
                  type="url"
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
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
                    placeholder="输入网关令牌"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="icon-action field-action"
                    onClick={() => setShowToken((current) => !current)}
                    aria-label={showToken ? "隐藏令牌" : "显示令牌"}
                    title={showToken ? "隐藏令牌" : "显示令牌"}
                  >
                    {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>会话 ID</span>
                <input
                  type="text"
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                  maxLength={256}
                  placeholder="web-xxxxxxxx"
                  autoComplete="off"
                />
              </label>
            </div>
            <footer className="settings-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  persistConnection();
                  setSettingsOpen(false);
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void checkConnection()}
                disabled={healthState === "checking"}
              >
                <RefreshCw
                  size={16}
                  className={healthState === "checking" ? "spin" : undefined}
                />{" "}
                {healthState === "checking" ? "检测中" : "检测连接"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function DeliveryStatus({ message }: { message: ChatMessage }) {
  if (message.state === "sending")
    return (
      <p className="delivery-status sending">
        <LoaderCircle className="spin" size={14} /> 正在提交
      </p>
    );
  if (message.state === "accepted")
    return (
      <p className="delivery-status accepted">
        <CheckCircle2 size={14} /> 网关已接收{" "}
        <code>{shortRequestId(message.requestId)}</code>
      </p>
    );
  return (
    <p className="delivery-status failed">
      <AlertCircle size={14} /> {message.error ?? "提交失败"}
    </p>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof GatewayRequestError) {
    if (error.code === "core_unavailable") return "核心消息入口尚未接入";
    if (error.code === "unauthorized") return "网关令牌无效";
    if (error.code === "rate_limited") return "请求过于频繁，请稍后再试";
    return error.message;
  }
  return "发送消息时发生未知错误";
}

function healthLabel(state: HealthState): string {
  if (state === "checking") return "检测中";
  if (state === "online") return "网关可用";
  if (state === "offline") return "连接失败";
  return "未检测";
}

function readStorage(storage: Storage, key: string, fallback: string): string {
  try {
    return storage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* private browsing can reject storage writes */
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
  if (!requestId) return "";
  return requestId.length > 12 ? `${requestId.slice(0, 12)}...` : requestId;
}
