/**
 * 功能概述：本文件承载 WebUI 的顶层状态机，在匿名 setup 状态、Profile 管理、
 * 待重启提示与消息聊天之间做显式切换，落实“全局 selected Profile 唯一生效、
 * 切换后必须重启 Runtime”的产品契约。
 * 主要职责：`App` 负责首次读取 `/api/v1/setup`，从当前页面会话或首次启动 URL
 * fragment 获取网关 token，根据 selected Profile 的 readiness 决定当前视图，并在 ready 状态下
 * 提供聊天入口与 Settings
 * 按钮；`ProfileManagementScreen` 负责展示 Profile 元数据列表、按 ID 加载完整
 * Profile、独立执行 create/replace/select/delete 动作，并在切换 Profile 或离开
 * 管理页时清空包含 secret 的已加载正文与编辑字段；其余小组件负责重启提示、
 * readiness 呈现与消息投递反馈。
 * 代码库关系：本文件消费 `api.ts` 的匿名状态、消息接口与 Profile Registry 管理
 * API，以及 `profile-editor.ts` 的纯函数合并逻辑；样式由同目录 `styles.css`
 * 提供，服务端实现位于 `apps/server/src/app.ts` 与 `setup.ts`。
 * 输入输出与副作用：bootstrap token 只在当前页面内存中使用，正式 token 在首次
 * 配置成功后写入 sessionStorage；所有 Profile 修改都通过 HTTP 请求落到服务端，不在浏览器端
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
  Save,
  Search,
  SendHorizontal,
  Settings2,
  Sun,
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
  completeInitialConfiguration,
  createProfile,
  deleteProfile,
  GatewayConfig,
  GatewayRequestError,
  getConfigurationStatus,
  getNapCatStatus,
  getProfile,
  listProfiles,
  MAX_MESSAGE_LENGTH,
  ProfileMetadata,
  replaceProfile,
  saveNapCatSettings,
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
type ConfigurationView =
  "checking" | "profiles" | "napcat" | "restart" | "chat" | "error";

const DOCS_BASE_URL = "https://posanbu.github.io/Kaguya";
const DOCS_LINKS = [
  { label: "使用指南", path: "/guide/" },
  { label: "开发文档", path: "/developers/" },
  { label: "参考资料", path: "/reference/" },
  { label: "项目", path: "/project/" },
] as const;

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
  const [bootstrapMode, setBootstrapMode] = useState(() => readBootstrapToken() !== "");
  const [token, setToken] = useState(() => readGatewayToken() || readBootstrapToken());
  const [configurationView, setConfigurationView] =
    useState<ConfigurationView>("checking");
  const [configurationStatus, setConfigurationStatus] =
    useState<ConfigurationStatus>();
  const [configurationError, setConfigurationError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [formError, setFormError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (readBootstrapToken() !== "") {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }, []);

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
        setConfigurationStatus(status);
        if (status.gatewayToken !== undefined) {
          setToken(status.gatewayToken);
        }
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
        bootstrapMode={bootstrapMode}
        onBootstrapCompleted={(nextToken) => {
          setBootstrapMode(false);
          setToken(nextToken);
        }}
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
        onOpenNapCat={() => setConfigurationView("napcat")}
      />
    );
  }

  if (configurationView === "napcat") {
    return (
      <NapCatManagementScreen
        token={token}
        onBack={() => setConfigurationView("profiles")}
        onOpenChat={() => setConfigurationView("chat")}
        onRestartRequired={() => setConfigurationView("restart")}
      />
    );
  }

  if (configurationView === "restart") {
    return <RestartRequired />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <img className="brand-mark" src="/kaguya-logo.png" alt="Kaguya" />
        <div>
          <h1>Kaguya</h1>
          <p>统一消息服务</p>
        </div>
      </header>

      <main className="workspace">
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
  bootstrapMode,
  onBootstrapCompleted,
  initialStatus,
  onStatusChange,
  onReloadStatus,
  onClose,
  onRestartRequired,
  onOpenNapCat,
}: {
  readonly token: string;
  readonly bootstrapMode: boolean;
  readonly onBootstrapCompleted: (token: string) => void;
  readonly initialStatus: ConfigurationStatus | undefined;
  readonly onStatusChange: (status: ConfigurationStatus) => void;
  readonly onReloadStatus: (options?: {
    readonly keepProfilesOpen?: boolean;
  }) => Promise<ConfigurationStatus>;
  readonly onClose: () => void;
  readonly onRestartRequired: () => void;
  readonly onOpenNapCat: () => void;
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
    if (bootstrapMode && openedProfileId === "default") {
      const profile = emptyBootstrapProfile();
      setLoadedProfile(profile);
      setEditorFields(profileToEditorFields(profile));
      setLoadingProfile(false);
      return;
    }
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
  }, [bootstrapMode, config, openedProfileId, token]);

  useEffect(() => {
    if (bootstrapMode || token.trim().length === 0) {
      return;
    }
    void refreshRegistry();
  }, [bootstrapMode, token]);

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
      if (bootstrapMode) {
        const saved = await completeInitialConfiguration(config, {
          profileName: editorFields.name,
          baseUrl: editorFields.baseUrl,
          apiKey: editorFields.apiKey,
          lightModel: editorFields.lightModel,
          heavyModel: editorFields.heavyModel,
        });
        onBootstrapCompleted(readGatewayToken());
        setNotice(saved.status === "configured" ? "配置已保存，请重启服务。" : undefined);
        return;
      }
      const result = await replaceProfile(config, loadedProfile.id, replacement);
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
        <img className="brand-mark" src="/kaguya-logo.png" alt="Kaguya" />
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
                  onClick={onOpenNapCat}
                >
                  <Settings2 size={16} />
                  <span>NapCat 配置</span>
                </button>
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

function NapCatManagementScreen({
  token,
  onBack,
  onOpenChat,
  onRestartRequired,
}: {
  readonly token: string;
  readonly onBack: () => void;
  readonly onOpenChat: () => void;
  readonly onRestartRequired: () => void;
}) {
  const config = useMemo(() => ({ token }), [token]);
  const [enabled, setEnabled] = useState(false);
  const [wsUrl, setWsUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [selfId, setSelfId] = useState("");
  const [reconnectMs, setReconnectMs] = useState("3000");
  const [hasAccessToken, setHasAccessToken] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void getNapCatStatus(config).then(
      (status) => {
        setEnabled(status.enabled);
        setWsUrl(status.wsUrl ?? "");
        setSelfId(status.selfId ?? "");
        setReconnectMs(String(status.reconnectMs));
        setHasAccessToken(status.hasAccessToken);
        setLoading(false);
      },
      (reason) => {
        setError(errorMessage(reason));
        setLoading(false);
      },
    );
  }, [config]);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const result = await saveNapCatSettings(config, {
        enabled,
        wsUrl,
        accessToken,
        selfId,
        reconnectMs: Number(reconnectMs),
      });
      setHasAccessToken(result.status.hasAccessToken);
      onRestartRequired();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setup-shell">
      <SetupHeader subtitle="NapCat 配置" />
      <main className="setup-main">
        <section className="setup-card" aria-labelledby="napcat-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">平台连接</p>
              <h2 id="napcat-title">配置 NapCat</h2>
            </div>
            <div className="editor-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onOpenChat}
              >
                <SendHorizontal size={16} />
                <span>对话</span>
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={onBack}
              >
                上一步
              </button>
            </div>
          </div>
          <p className="setup-intro">
            填写 NapCat OneBot 反向 WebSocket 参数。保存后需要重启
            Kaguya，重启时才会建立连接。
          </p>
          {error ? (
            <div className="error-banner" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
            </div>
          ) : null}
          {loading ? (
            <div className="profile-loading" role="status">
              <LoaderCircle className="spin" size={18} />
              <span>正在读取 NapCat 配置</span>
            </div>
          ) : null}
          {!loading ? (
            <form
              className="setup-form"
              onSubmit={(event) => void handleSave(event)}
            >
              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                <span>
                  启用 NapCat
                  <small>
                    勾选后，重启时才会连接 QQ 的 NapCat OneBot 服务；不接 QQ
                    可以直接跳过这一页。
                  </small>
                </span>
              </label>
              <label className="field">
                <span>反向 WebSocket 地址</span>
                <input
                  type="url"
                  value={wsUrl}
                  onChange={(event) => setWsUrl(event.target.value)}
                  placeholder="ws://127.0.0.1:3001"
                />
              </label>
              <label className="field">
                <span>
                  Access Token{" "}
                  {hasAccessToken ? "（已保存，留空则保留）" : "（可选）"}
                </span>
                <div className="password-field">
                  <input
                    type={showAccessToken ? "text" : "password"}
                    value={accessToken}
                    onChange={(event) => setAccessToken(event.target.value)}
                    autoComplete="new-password"
                    placeholder={
                      hasAccessToken
                        ? "留空以保留当前 token"
                        : "NapCat access token"
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setShowAccessToken((current) => !current)}
                    aria-label={
                      showAccessToken
                        ? "隐藏 Access Token"
                        : "显示 Access Token"
                    }
                  >
                    {showAccessToken ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>机器人 QQ 号（可选）</span>
                <input
                  value={selfId}
                  onChange={(event) => setSelfId(event.target.value)}
                  placeholder="例如 123456789"
                />
              </label>
              <label className="field">
                <span>断线重连间隔（毫秒）</span>
                <input
                  type="number"
                  min={100}
                  max={3600000}
                  step={100}
                  value={reconnectMs}
                  onChange={(event) => setReconnectMs(event.target.value)}
                />
              </label>
              <button className="setup-button" type="submit" disabled={saving}>
                {saving ? "保存中" : "保存并重启"}
              </button>
            </form>
          ) : null}
        </section>
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
      <SetupHeader subtitle="配置引导" />
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
      <SetupHeader subtitle="配置引导" />
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
      <SetupHeader subtitle="配置引导" />
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

function SetupHeader({ subtitle }: { readonly subtitle: string }) {
  return (
    <header className="topbar setup-topbar">
      <a className="setup-brand" href={`${DOCS_BASE_URL}/`}>
        <img src="/kaguya-logo.png" alt="Kaguya" />
        <span>Kaguya</span>
      </a>
      <span className="setup-subtitle">{subtitle}</span>
      <div className="setup-header-spacer" />
      <div className="setup-search" aria-label="搜索文档">
        <Search size={15} />
        <span>搜索</span>
        <kbd>⌘ K</kbd>
      </div>
      <nav className="setup-docs-nav" aria-label="文档导航">
        {DOCS_LINKS.map((link) => (
          <a key={link.path} href={`${DOCS_BASE_URL}${link.path}`}>
            {link.label}
          </a>
        ))}
      </nav>
      <button
        className="setup-theme-button"
        type="button"
        aria-label="切换主题"
      >
        <Sun size={16} />
      </button>
      <a
        className="setup-github-link"
        href="https://github.com/posanbu/Kaguya"
        aria-label="在 GitHub 查看 Kaguya"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 .7a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.3 1.8 1.3 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.3-3.2-.1-.3-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.3 11.3 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.3 2.9.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A12 12 0 0 0 12 .7Z" />
        </svg>
      </a>
    </header>
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

function emptyBootstrapProfile(): UserConfigProfile {
  return {
    version: 1,
    id: "default",
    name: "default",
    ai: { providers: [] },
    platforms: [],
    plugins: [],
  };
}

export function readBootstrapToken(hash = typeof location === "undefined" ? "" : location.hash): string {
  const match = /^#bootstrapToken=([^&]*)$/u.exec(hash);
  return match === null ? "" : decodeURIComponent(match[1] ?? "");
}

function readGatewayToken(): string {
  if (typeof localStorage === "undefined") {
    return "";
  }
  return localStorage.getItem("kaguya.gatewayToken") ?? "";
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
