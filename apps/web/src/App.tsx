import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
  Save,
  SendHorizontal,
  Settings2,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  checkGatewayHealth,
  GatewayRequestError,
  getConfigurationStatus,
  initializeConfiguration,
  MAX_MESSAGE_LENGTH,
  sendMessage,
} from "./api.js";

const TOKEN_KEY = "kaguya.gatewayToken";

type DeliveryState = "sending" | "accepted" | "failed";
type HealthState = "idle" | "checking" | "online" | "offline";
type ConfigurationView = "checking" | "setup" | "restart" | "chat" | "error";

interface ChatMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: Date;
  readonly state: DeliveryState;
  readonly requestId?: string;
  readonly error?: string;
}

export function App() {
  const [token, setToken] = useState(() =>
    readStorage(sessionStorage, TOKEN_KEY, ""),
  );
  const [configurationView, setConfigurationView] =
    useState<ConfigurationView>("checking");
  const [configurationError, setConfigurationError] = useState<string>();
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

  useEffect(() => {
    let active = true;
    void getConfigurationStatus().then(
      (status) => {
        if (!active) return;
        setConfigurationView(
          status.status === "setup_required" ||
            status.status === "invalid" ||
            status.status === "review_required"
            ? "setup"
            : status.status === "restart_required"
              ? "restart"
              : "chat",
        );
      },
      (error) => {
        if (!active) return;
        setConfigurationError(errorMessage(error));
        setConfigurationView("error");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const persistConnection = () => {
    sessionStorage.setItem(TOKEN_KEY, token);
  };

  const checkConnection = async () => {
    setHealthState("checking");
    setFormError(undefined);
    persistConnection();
    try {
      await checkGatewayHealth();
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
      const response = await sendMessage({ token }, { text });
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

  if (configurationView === "checking") {
    return <ConfigurationLoading />;
  }

  if (configurationView === "error") {
    return <ConfigurationStatusError message={configurationError} />;
  }

  if (configurationView === "setup") {
    return (
      <SetupScreen
        token={token}
        onTokenChange={(value) => {
          setToken(value);
          sessionStorage.setItem(TOKEN_KEY, value);
        }}
      />
    );
  }

  if (configurationView === "restart") {
    return <RestartRequired />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          K
        </div>
        <div>
          <h1>Kaguya</h1>
          <p>统一消息服务</p>
        </div>
      </header>

      <main className="workspace">
        <aside className="connection-panel" aria-labelledby="connection-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">连接配置</p>
              <h2 id="connection-title">Kaguya 服务</h2>
            </div>
            <button
              type="button"
              className={`health-button ${healthState}`}
              onClick={() => void checkConnection()}
              disabled={healthState === "checking"}
              title="检测 Kaguya 服务连接"
            >
              <RefreshCw
                className={healthState === "checking" ? "spin" : undefined}
                size={15}
              />
              <span>{healthLabel(healthState)}</span>
            </button>
          </div>

          <label className="field">
            <span>Bearer Token</span>
            <div className="password-field">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onBlur={persistConnection}
                placeholder="输入服务令牌"
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

          <div className="boundary-note">
            <p>当前服务仅接受消息。</p>
            <span>模型配置和回复由核心层管理。</span>
          </div>
        </aside>

        <section className="chat-panel" aria-labelledby="chat-title">
          <header className="chat-heading">
            <div>
              <p className="eyebrow">消息入口</p>
              <h2 id="chat-title">消息</h2>
            </div>
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

function ConfigurationLoading() {
  return (
    <div className="setup-shell">
      <div className="setup-status" role="status">
        <LoaderCircle className="spin" size={20} />
        <span>正在读取配置状态</span>
      </div>
    </div>
  );
}

function ConfigurationStatusError({
  message,
}: {
  message: string | undefined;
}) {
  return (
    <div className="setup-shell">
      <section className="setup-card setup-status-card" role="alert">
        <Settings2 size={22} />
        <h1>无法读取配置状态</h1>
        <p>{message ?? "请确认 Kaguya 服务正在运行"}</p>
        <button
          type="button"
          className="setup-button"
          onClick={() => window.location.reload()}
        >
          重新检查
        </button>
      </section>
    </div>
  );
}

function RestartRequired() {
  return (
    <div className="setup-shell">
      <section className="setup-card setup-status-card" role="status">
        <CheckCircle2 size={22} />
        <h1>配置已保存</h1>
        <p>请重启 Kaguya 服务，使 Runtime 加载新的模型配置，然后刷新页面。</p>
        <button
          type="button"
          className="setup-button"
          onClick={() => window.location.reload()}
        >
          已重启，重新检查
        </button>
      </section>
    </div>
  );
}

function SetupScreen({
  token,
  onTokenChange,
}: {
  readonly token: string;
  readonly onTokenChange: (value: string) => void;
}) {
  const [profileName, setProfileName] = useState("default");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [lightModel, setLightModel] = useState("");
  const [heavyModel, setHeavyModel] = useState("");
  const [acknowledgeOptional, setAcknowledgeOptional] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string>();

  const modelsAreDistinct = lightModel.trim() !== heavyModel.trim();
  const canSubmit =
    !submitting &&
    token.trim().length > 0 &&
    profileName.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    apiKey.length > 0 &&
    lightModel.trim().length > 0 &&
    heavyModel.trim().length > 0 &&
    modelsAreDistinct &&
    acknowledgeOptional;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      await initializeConfiguration(
        { token },
        {
          profileName,
          baseUrl,
          apiKey,
          lightModel,
          heavyModel,
          acknowledgeOptional,
        },
      );
      setSaved(true);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="setup-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          K
        </div>
        <div>
          <h1>Kaguya</h1>
          <p>配置向导</p>
        </div>
      </header>

      <main className="setup-main">
        <section className="setup-card" aria-labelledby="setup-title">
          <div className="setup-heading">
            <div className="setup-icon" aria-hidden="true">
              <Settings2 size={20} />
            </div>
            <div>
              <p className="eyebrow">运行前检查</p>
              <h1 id="setup-title">完成运行配置</h1>
            </div>
          </div>
          <p className="setup-intro">
            配置缺失或尚未确认时会停留在此页面。填写一个 OpenAI-compatible
            模型服务，保存后重启 Kaguya 即可开始聊天。
          </p>

          <form className="setup-form" onSubmit={(event) => void submit(event)}>
            <label className="field">
              <span>配置名称</span>
              <input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                maxLength={100}
                autoComplete="off"
                placeholder="default"
              />
            </label>
            <label className="field">
              <span>模型服务 URL</span>
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                autoComplete="url"
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label className="field">
              <span>模型服务 API Key</span>
              <div className="password-field">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="new-password"
                  placeholder="输入模型服务密钥"
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowApiKey((current) => !current)}
                  aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                  title={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <div className="setup-model-grid">
              <label className="field">
                <span>Light 模型</span>
                <input
                  value={lightModel}
                  onChange={(event) => setLightModel(event.target.value)}
                  autoComplete="off"
                  placeholder="gpt-4o-mini"
                />
              </label>
              <label className="field">
                <span>Heavy 模型</span>
                <input
                  value={heavyModel}
                  onChange={(event) => setHeavyModel(event.target.value)}
                  autoComplete="off"
                  placeholder="gpt-4o"
                />
              </label>
            </div>
            {!modelsAreDistinct && lightModel.trim() && heavyModel.trim() ? (
              <p className="setup-field-error">Light 和 Heavy 模型必须不同</p>
            ) : null}
            <label className="setup-check">
              <input
                type="checkbox"
                checked={acknowledgeOptional}
                onChange={(event) =>
                  setAcknowledgeOptional(event.target.checked)
                }
              />
              <span>我确认暂不配置平台和插件，稍后再补充</span>
            </label>

            <label className="field">
              <span>网关访问令牌</span>
              <input
                type="password"
                value={token}
                onChange={(event) => onTokenChange(event.target.value)}
                autoComplete="current-password"
                placeholder="KAGUYA_GATEWAY_TOKEN"
              />
            </label>

            {formError ? (
              <div className="error-banner" role="alert">
                <AlertCircle size={17} />
                <span>{formError}</span>
              </div>
            ) : null}
            {saved ? (
              <div className="setup-success" role="status">
                <CheckCircle2 size={17} />
                <span>配置已保存，请重启服务后刷新此页面。</span>
              </div>
            ) : null}
            <button
              className="setup-button"
              type="submit"
              disabled={!canSubmit || saved}
            >
              {submitting ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Save size={18} />
              )}
              <span>{submitting ? "保存中" : "保存配置"}</span>
            </button>
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
        服务已接收
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
      return "服务令牌无效";
    }
    if (error.code === "rate_limited") {
      return "请求过于频繁，请稍后再试";
    }
    if (error.code === "configuration_setup_required") {
      return "请先完成运行配置";
    }
    if (error.code === "configuration_invalid") {
      return "配置内容不完整或无效";
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
    return "服务可用";
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
