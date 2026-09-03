/**
 * 功能概述：本文件承载 WebUI 的顶层状态机，在匿名 setup 状态、Profile 管理、
 * 待重启提示与消息聊天之间做显式切换，落实“全局 selected Profile 唯一生效、
 * 切换后必须重启 Runtime”的产品契约。
 * 主要职责：`App` 负责首次读取 `/api/v1/setup`（并从中获取服务端分发的网关
 * token）、根据 selected Profile 的 readiness 决定当前视图，并在 ready 状态下
 * 提供聊天入口与 Settings
 * 按钮；`ProfileManagementScreen` 负责展示 Profile 元数据列表、按 ID 加载完整
 * Profile、独立执行 create/replace/select/delete 动作，并在切换 Profile 或离开
 * 管理页时清空包含 secret 的已加载正文与编辑字段；其余小组件负责重启提示、
 * readiness 呈现与消息投递反馈。
 * 代码库关系：本文件消费 `api.ts` 的匿名状态、消息接口与 Profile Registry 管理
 * API，以及 `profile-editor.ts` 的纯函数合并逻辑；样式由同目录 `styles.css`
 * 提供，服务端实现位于 `apps/server/src/app.ts` 与 `setup.ts`。
 * 输入输出与副作用：网关 token 由服务端在启动时分发、页面加载时自动获取，
 * 页面不持久化；所有 Profile 修改都通过 HTTP 请求落到服务端，不在浏览器端
 * 推断默认 Profile；当 selected
 * Profile 已 ready 且本次 replace/select 改变冻结运行配置时，本文件只切到
 * restart 视图提示用户重启，不做热切换。Profile 管理子组件会记忆同一
 * token 对应的网关配置对象，避免读取 Profile 的副作用 effect 因对象引用变化
 * 而重复请求并触发服务端限流。
 */
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  SendHorizontal,
  Settings2,
  Trash2,
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
  createProfile,
  deleteProfile,
  GatewayConfig,
  GatewayRequestError,
  getConfigurationStatus,
  getProfile,
  listProfiles,
  MAX_MESSAGE_LENGTH,
  ProfileMetadata,
  replaceProfile,
  selectProfile,
  sendMessage,
  type ConfigurationIssue,
  type ConfigurationStatus,
  type ConfigurationWarning,
  type ProfileRegistryMetadata,
  type UserConfigProfile,
} from "./api.js";
import {
  mergeProfileEditorFields,
  profileToEditorFields,
  type ProfileEditorFields,
} from "./profile-editor.js";

type DeliveryState = "sending" | "accepted" | "failed";
type HealthState = "idle" | "checking" | "online" | "offline";
type ConfigurationView = "checking" | "profiles" | "restart" | "chat" | "error";

interface ChatMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: Date;
  readonly state: DeliveryState;
  readonly requestId?: string;
  readonly error?: string;
}

interface ClearedLoadedProfileStateSnapshot {
  readonly requestSequence: number;
  readonly loadingProfile: boolean;
  readonly loadedProfile: UserConfigProfile | undefined;
  readonly editorFields: ProfileEditorFields | undefined;
  readonly showApiKey: boolean;
}

export function App() {
  const [token, setToken] = useState("");
  const [configurationView, setConfigurationView] =
    useState<ConfigurationView>("checking");
  const [configurationStatus, setConfigurationStatus] =
    useState<ConfigurationStatus>();
  const [configurationError, setConfigurationError] = useState<string>();
  const [healthState, setHealthState] = useState<HealthState>("idle");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [formError, setFormError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isSending = messages.some((message) => message.state === "sending");
  const draftLength = [...draft].length;
  const canSend =
    !isSending && draft.trim().length > 0 && draftLength <= MAX_MESSAGE_LENGTH;

  const loadConfigurationStatus = async (options?: {
    readonly keepProfilesOpen?: boolean;
  }) => {
    const status = await getConfigurationStatus();
    setConfigurationStatus(status);
    setConfigurationView((current) =>
      deriveConfigurationView(
        status,
        current,
        options?.keepProfilesOpen ?? false,
      ),
    );
    return status;
  };

  useEffect(() => {
    let active = true;
    void getConfigurationStatus().then(
      (status) => {
        if (!active) {
          return;
        }
        setToken(status.gatewayToken);
        setConfigurationStatus(status);
        setConfigurationView(
          deriveConfigurationView(status, "checking", false),
        );
      },
      (error) => {
        if (!active) {
          return;
        }
        setConfigurationError(errorMessage(error));
        setConfigurationView("error");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const checkConnection = async () => {
    setHealthState("checking");
    setFormError(undefined);
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

  if (configurationView === "profiles") {
    return (
      <ProfileManagementScreen
        token={token}
        initialStatus={configurationStatus}
        onStatusChange={(status) => {
          setConfigurationStatus(status);
        }}
        onReloadStatus={(options) => loadConfigurationStatus(options)}
        onClose={() => {
          setConfigurationView("chat");
        }}
        onRestartRequired={() => {
          setConfigurationView("restart");
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
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfigurationView("profiles")}
            >
              <Settings2 size={16} />
              <span>Settings</span>
            </button>
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

function ProfileManagementScreen({
  token,
  initialStatus,
  onStatusChange,
  onReloadStatus,
  onClose,
  onRestartRequired,
}: {
  readonly token: string;
  readonly initialStatus: ConfigurationStatus | undefined;
  readonly onStatusChange: (status: ConfigurationStatus) => void;
  readonly onReloadStatus: (options?: {
    readonly keepProfilesOpen?: boolean;
  }) => Promise<ConfigurationStatus>;
  readonly onClose: () => void;
  readonly onRestartRequired: () => void;
}) {
  const [registry, setRegistry] = useState<ProfileRegistryMetadata | undefined>(
    () => readRegistryMetadata(initialStatus),
  );
  const [statusSnapshot, setStatusSnapshot] = useState(initialStatus);
  const [openedProfileId, setOpenedProfileId] = useState<string | undefined>(
    initialStatus?.selectedProfileId,
  );
  const [loadedProfile, setLoadedProfile] = useState<UserConfigProfile>();
  const [editorFields, setEditorFields] = useState<ProfileEditorFields>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [createExpanded, setCreateExpanded] = useState(false);
  const [createName, setCreateName] = useState("");
  const [panelError, setPanelError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const requestSequence = useRef(0);

  const config: GatewayConfig = useMemo(() => ({ token }), [token]);

  useEffect(() => {
    const nextRegistry = readRegistryMetadata(initialStatus);
    setRegistry(nextRegistry);
    setStatusSnapshot(initialStatus);
    setOpenedProfileId(
      (current) => current ?? initialStatus?.selectedProfileId,
    );
  }, [initialStatus]);

  useEffect(() => {
    clearLoadedProfileState();
  }, [token]);

  useEffect(() => {
    if (!openedProfileId || token.trim().length === 0) {
      return;
    }
    const currentSequence = requestSequence.current + 1;
    requestSequence.current = currentSequence;
    setLoadingProfile(true);
    setPanelError(undefined);
    setNotice(undefined);
    void getProfile(config, openedProfileId).then(
      ({ profile }) => {
        if (requestSequence.current !== currentSequence) {
          return;
        }
        setLoadedProfile(profile);
        setEditorFields(profileToEditorFields(profile));
        setLoadingProfile(false);
      },
      (error) => {
        if (requestSequence.current !== currentSequence) {
          return;
        }
        clearLoadedProfileState();
        setPanelError(errorMessage(error));
        setLoadingProfile(false);
      },
    );
  }, [config, openedProfileId, token]);

  useEffect(() => {
    if (token.trim().length === 0) {
      return;
    }
    void refreshRegistry();
  }, [token]);

  if (registry === undefined) {
    return <ConfigurationLoading />;
  }

  const canClose = statusSnapshot?.status === "ready";
  const readinessIssues = statusSnapshot?.issues ?? [];
  const readinessWarnings = statusSnapshot?.warnings ?? [];
  const selectedProfileId = registry.selectedProfileId;
  const deleteDisabled =
    openedProfileId === undefined ||
    openedProfileId === "default" ||
    openedProfileId === selectedProfileId;
  const saveDisabled =
    mutating ||
    loadingProfile ||
    loadedProfile === undefined ||
    editorFields === undefined;

  function clearLoadedProfileState() {
    const snapshot = clearLoadedProfileStateSnapshot({
      requestSequence: requestSequence.current,
      loadingProfile,
      showApiKey,
    });
    requestSequence.current = snapshot.requestSequence;
    setLoadingProfile(snapshot.loadingProfile);
    setLoadedProfile(snapshot.loadedProfile);
    setEditorFields(snapshot.editorFields);
    setShowApiKey(snapshot.showApiKey);
  }

  async function refreshRegistry() {
    const nextRegistry = await listProfiles(config);
    setRegistry(nextRegistry);
    return nextRegistry;
  }

  async function refreshStatusAfterMutation() {
    const status = await onReloadStatus({ keepProfilesOpen: true });
    setStatusSnapshot(status);
    onStatusChange(status);
    return status;
  }

  const handleOpenProfile = (profileId: string) => {
    setOpenedProfileId(profileId);
    clearLoadedProfileState();
    setPanelError(undefined);
    setNotice(undefined);
  };

  const handleCreateProfile = async () => {
    if (createName.trim().length === 0) {
      setPanelError("Profile name is required.");
      return;
    }
    setMutating(true);
    setPanelError(undefined);
    setNotice(undefined);
    try {
      const result = await createProfile(config, { name: createName });
      const nextRegistry = await refreshRegistry();
      setOpenedProfileId(result.profile.id);
      setLoadedProfile(result.profile);
      setEditorFields(profileToEditorFields(result.profile));
      setCreateExpanded(false);
      setCreateName("");
      setRegistry(nextRegistry);
      setNotice("Profile created. Select it separately to make it active.");
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const handleSaveProfile = async () => {
    if (loadedProfile === undefined || editorFields === undefined) {
      return;
    }
    setMutating(true);
    setPanelError(undefined);
    setNotice(undefined);
    try {
      const replacement = mergeProfileEditorFields(loadedProfile, editorFields);
      const result = await replaceProfile(
        config,
        loadedProfile.id,
        replacement,
      );
      setLoadedProfile(result.profile);
      setEditorFields(profileToEditorFields(result.profile));
      await refreshRegistry();
      const status = await refreshStatusAfterMutation();
      if (result.restartRequired && status.status === "ready") {
        onRestartRequired();
        return;
      }
      setNotice("Profile saved.");
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const handleSelectProfile = async () => {
    if (openedProfileId === undefined) {
      return;
    }
    setMutating(true);
    setPanelError(undefined);
    setNotice(undefined);
    try {
      const result = await selectProfile(config, openedProfileId);
      setLoadedProfile(result.profile);
      setEditorFields(profileToEditorFields(result.profile));
      const nextRegistry = await refreshRegistry();
      const status = await refreshStatusAfterMutation();
      setRegistry(nextRegistry);
      if (result.restartRequired && status.status === "ready") {
        onRestartRequired();
        return;
      }
      setNotice(
        status.status === "ready"
          ? "Selected profile updated."
          : "Selected profile changed. Fix its readiness issues before restart.",
      );
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (openedProfileId === undefined || deleteDisabled) {
      return;
    }
    setMutating(true);
    setPanelError(undefined);
    setNotice(undefined);
    try {
      await deleteProfile(config, openedProfileId);
      clearLoadedProfileState();
      const nextRegistry = await refreshRegistry();
      const status = await refreshStatusAfterMutation();
      setRegistry(nextRegistry);
      setStatusSnapshot(status);
      setOpenedProfileId(nextRegistry.selectedProfileId);
      setNotice("Profile deleted.");
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setMutating(false);
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
          <p>配置引导</p>
        </div>
      </header>

      <main className="setup-main profile-main">
        <div className="profile-workspace">
          <aside
            className="setup-card profile-sidebar"
            aria-labelledby="profiles-title"
          >
            <div className="panel-heading profile-sidebar-heading">
              <div>
                <p className="eyebrow">第一步</p>
                <h2 id="profiles-title">选择配置</h2>
              </div>
              {canClose ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    clearLoadedProfileState();
                    onClose();
                  }}
                >
                  返回消息
                </button>
              ) : null}
            </div>

            <div className="profile-create">
              <button
                type="button"
                className="secondary-button"
                disabled={mutating}
                onClick={() => {
                  setCreateExpanded((current) => !current);
                  setPanelError(undefined);
                }}
              >
                <Plus size={16} />
                <span>新建 Profile</span>
              </button>
              {createExpanded ? (
                <div className="profile-create-form">
                  <label className="field compact-field">
                    <span>Profile 名称</span>
                    <input
                      value={createName}
                      onChange={(event) => setCreateName(event.target.value)}
                      placeholder="例如：生产环境"
                      autoComplete="off"
                    />
                  </label>
                  <button
                    type="button"
                    className="setup-button inline-button"
                    disabled={mutating}
                    onClick={() => void handleCreateProfile()}
                  >
                    {mutating ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Plus size={16} />
                    )}
                    <span>{mutating ? "创建中" : "创建"}</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="profile-list" role="list">
              {registry.profiles.map((profile) => {
                const active = profile.id === openedProfileId;
                const selected = profile.id === selectedProfileId;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    className={`profile-list-item${active ? " active" : ""}`}
                    onClick={() => handleOpenProfile(profile.id)}
                  >
                    <span className="profile-list-name">{profile.name}</span>
                    <span className="profile-list-meta">
                      {selected ? "当前选中" : "可用配置"}
                    </span>
                  </button>
                );
              })}
            </div>

            <ReadinessPanel
              selectedProfileId={selectedProfileId}
              status={statusSnapshot?.status ?? "setup_required"}
              issues={readinessIssues}
              warnings={readinessWarnings}
            />
          </aside>

          <section
            className="setup-card profile-editor-card"
            aria-labelledby="profile-editor-title"
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">第二步</p>
                <h2 id="profile-editor-title">
                  {openedProfileId === undefined
                    ? "请选择配置"
                    : "填写模型信息"}
                </h2>
              </div>
              <div className="editor-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={openedProfileId === undefined || mutating}
                  onClick={() => void handleSelectProfile()}
                >
                  选为当前配置
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={deleteDisabled || mutating}
                  onClick={() => void handleDeleteProfile()}
                >
                  <Trash2 size={16} />
                  <span>删除</span>
                </button>
              </div>
            </div>

            <p className="setup-intro profile-intro">
              填写模型服务地址和两个模型层级，保存后 Kaguya
              会在重启时加载当前配置。
              如果暂时不接入平台或插件，也可以在下方明确确认。
            </p>

            {panelError ? (
              <div className="error-banner" role="alert">
                <AlertCircle size={17} />
                <span>{panelError}</span>
              </div>
            ) : null}
            {notice ? (
              <div className="setup-success" role="status">
                <CheckCircle2 size={17} />
                <span>{notice}</span>
              </div>
            ) : null}

            {loadingProfile ? (
              <div className="profile-loading" role="status">
                <LoaderCircle className="spin" size={18} />
                <span>Loading profile</span>
              </div>
            ) : null}

            {openedProfileId !== undefined &&
            loadedProfile === undefined &&
            !loadingProfile ? (
              <div className="profile-placeholder">
                <p>Select a profile again if loading failed.</p>
              </div>
            ) : null}

            {loadedProfile !== undefined && editorFields !== undefined ? (
              <form
                className="setup-form profile-editor-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveProfile();
                }}
              >
                <label className="field">
                  <span>Profile 名称</span>
                  <input
                    value={editorFields.name}
                    disabled={loadedProfile.id === "default"}
                    onChange={(event) =>
                      setEditorFields((current) =>
                        current === undefined
                          ? current
                          : { ...current, name: event.target.value },
                      )
                    }
                    maxLength={100}
                    autoComplete="off"
                    placeholder="default"
                  />
                </label>
                <label className="field">
                  <span>模型服务地址</span>
                  <input
                    type="url"
                    value={editorFields.baseUrl}
                    onChange={(event) =>
                      setEditorFields((current) =>
                        current === undefined
                          ? current
                          : { ...current, baseUrl: event.target.value },
                      )
                    }
                    autoComplete="url"
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label className="field">
                  <span>模型服务 API Key</span>
                  <div className="password-field">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={editorFields.apiKey}
                      onChange={(event) =>
                        setEditorFields((current) =>
                          current === undefined
                            ? current
                            : { ...current, apiKey: event.target.value },
                        )
                      }
                      autoComplete="new-password"
                      placeholder="Enter provider API key"
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setShowApiKey((current) => !current)}
                      aria-label={showApiKey ? "Hide API key" : "Show API key"}
                      title={showApiKey ? "Hide API key" : "Show API key"}
                    >
                      {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </label>
                <div className="setup-model-grid">
                  <label className="field">
                    <span>轻量模型</span>
                    <input
                      value={editorFields.lightModel}
                      onChange={(event) =>
                        setEditorFields((current) =>
                          current === undefined
                            ? current
                            : { ...current, lightModel: event.target.value },
                        )
                      }
                      autoComplete="off"
                      placeholder="gpt-4o-mini"
                    />
                  </label>
                  <label className="field">
                    <span>重量模型</span>
                    <input
                      value={editorFields.heavyModel}
                      onChange={(event) =>
                        setEditorFields((current) =>
                          current === undefined
                            ? current
                            : { ...current, heavyModel: event.target.value },
                        )
                      }
                      autoComplete="off"
                      placeholder="gpt-4o"
                    />
                  </label>
                </div>
                <label className="setup-check">
                  <input
                    type="checkbox"
                    checked={editorFields.acknowledgeOptional}
                    onChange={(event) =>
                      setEditorFields((current) =>
                        current === undefined
                          ? current
                          : {
                              ...current,
                              acknowledgeOptional: event.target.checked,
                            },
                      )
                    }
                  />
                  <span>我确认当前尚未配置平台与插件，稍后再配置也可以。</span>
                </label>

                <button
                  className="setup-button"
                  type="submit"
                  disabled={saveDisabled}
                >
                  {mutating ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Save size={18} />
                  )}
                  <span>{mutating ? "保存中" : "保存配置"}</span>
                </button>
              </form>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}

function ReadinessPanel({
  selectedProfileId,
  status,
  issues,
  warnings,
}: {
  readonly selectedProfileId: string;
  readonly status: ConfigurationStatus["status"];
  readonly issues: readonly ConfigurationIssue[];
  readonly warnings: readonly ConfigurationWarning[];
}) {
  return (
    <section className="readiness-card" aria-labelledby="readiness-title">
      <div className="readiness-heading">
        <p className="eyebrow">配置检查</p>
        <h3 id="readiness-title">{selectedProfileId}</h3>
      </div>
      <p className="readiness-status">当前状态：{statusLabel(status)}</p>
      {issues.length > 0 ? (
        <div className="readiness-group">
          <strong>需要处理</strong>
          <ul className="readiness-list">
            {issues.map((issue) => (
              <li key={`${issue.id}:${issue.path}`}>
                <code>{issue.path}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="readiness-group">
          <strong>提醒</strong>
          <ul className="readiness-list">
            {warnings.map((warning) => (
              <li key={`${warning.id}:${warning.path}`}>
                <code>{warning.path}</code>
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {issues.length === 0 && warnings.length === 0 ? (
        <p className="readiness-empty">当前配置已通过检查。</p>
      ) : null}
    </section>
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
  readonly message: string | undefined;
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
        <p>
          请重启 Kaguya 服务，使 Runtime 加载新的选中 Profile，然后刷新页面。
        </p>
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

function DeliveryStatus({ message }: { readonly message: ChatMessage }) {
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

export function deriveConfigurationView(
  status: ConfigurationStatus,
  current: ConfigurationView,
  keepProfilesOpen: boolean,
): ConfigurationView {
  if (
    status.status === "setup_required" ||
    status.status === "invalid" ||
    status.status === "review_required"
  ) {
    return "profiles";
  }
  if (status.status === "restart_required") {
    return "restart";
  }
  if (keepProfilesOpen && current === "profiles") {
    return "profiles";
  }
  return "chat";
}

export function clearLoadedProfileStateSnapshot(input: {
  readonly requestSequence: number;
  readonly loadingProfile: boolean;
  readonly showApiKey: boolean;
}): ClearedLoadedProfileStateSnapshot {
  return {
    requestSequence: input.requestSequence + 1,
    loadingProfile: false,
    loadedProfile: undefined,
    editorFields: undefined,
    showApiKey: false,
  };
}

export function readRegistryMetadata(
  status: ConfigurationStatus | undefined,
): ProfileRegistryMetadata | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (
    typeof status.selectedProfileId !== "string" ||
    !Array.isArray(status.profiles)
  ) {
    throw new Error(
      "Configuration status is missing profile registry metadata",
    );
  }
  return {
    selectedProfileId: status.selectedProfileId,
    profiles: status.profiles,
  };
}

function statusLabel(status: ConfigurationStatus["status"]): string {
  switch (status) {
    case "setup_required":
      return "Setup required";
    case "invalid":
      return "Invalid";
    case "review_required":
      return "Review required";
    case "restart_required":
      return "Restart required";
    case "ready":
      return "Ready";
  }
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
    if (error.code === "configuration_unavailable") {
      return "配置仓库当前不可用";
    }
    if (error.code === "profile_name_conflict") {
      return "Profile 名称已存在";
    }
    if (error.code === "profile_not_found") {
      return "Profile 不存在";
    }
    if (error.code === "profile_protected") {
      return "default Profile 不可修改或删除";
    }
    if (error.code === "profile_in_use") {
      return "当前选中的 Profile 不能删除";
    }
    if (error.code === "profile_invalid") {
      return "Profile 内容不完整或无效";
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
