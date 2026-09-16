/**
 * ProfileFeedback 将所属配置问题映射到字段/区块，useProfileDraft 统一保存、放弃、取消保护。
 * ProfileWorkspace 提供全局编辑 ID 与操作锁，配置页保持单栏，保存/选择/应用独立。
 * 根路径挂载只读 Overview，配置读取失败由概览独立反馈；401 仍通过全局锁屏处理。
 * Profile 表单用两个独立文本框编辑入站与出站规则，保存后仍须显式应用。
 * 功能概述：本文件承载 WebUI 的顶层状态机，在访问链接认证、Profile 管理、
 * 配置生效管理与消息聊天之间做显式切换，落实“全局 selected Profile 唯一生效、
 * 配置修改需要手动应用”的产品契约。保存与选择只落盘，用户在生效管理页主动提交 revision，
 * 保存成功刷新待应用状态，失败保留设置页；进程级变更进入应用管理页展示重启说明。模型编辑区区分硬超时与推荐时间，
 * 重启页给出开发/生产命令和新 Gateway Token 链接指引；空 allowlist 显示 QQ 排查提示。
 * 推荐时间使用整数毫秒步长，避免 min=1/step=100 导致默认 2000/5000 无法提交。
 * 主要职责：`App` 负责从当前 URL fragment 获取网关 token，再读取 `/api/v1/profiles`，
 * 根据 selected Profile 的 readiness 决定当前视图，并在 ready 状态下
 * 提供聊天入口与 Settings
 * 按钮；`ProfileManagementScreen` 负责展示 Profile 元数据列表、按 ID 加载完整
 * Profile、独立执行 create/replace/select/delete 动作，并在切换 Profile 或离开
 * 管理页时清空包含 secret 的已加载正文与编辑字段；其余小组件负责应用状态、
 * readiness 呈现与消息投递反馈。
 * 代码库关系：本文件消费 `api.ts` 的受保护状态、消息接口与 Profile Registry 管理
 * API，以及 `profile-editor.ts` 的纯函数合并逻辑；样式由同目录 `styles.css`
 * 提供，服务端实现位于 `apps/server/src/app.ts` 与 `configuration-management.ts`。
 * 输入输出与副作用：gateway token 仅从 fragment 读取并保留在页面内存中；所有
 * Profile 修改都通过 HTTP 请求落到服务端，不在浏览器端
 * 推断默认 Profile；当 selected
 * Profile 已 ready 且本次 replace/select 改变运行配置时，进入生效管理页等待手动应用；
 * 仅进程级字段变更需要重启。Profile 管理子组件会记忆同一
 * token 对应的网关配置对象，避免读取 Profile 的副作用 effect 因对象引用变化
 * 而重复请求并触发服务端限流。开发者入口使用 history 路径，复用内存 Token；
 * 工作台由 AppShell 统一承载，useWorkbenchRouter 保护 history 导航；根路径预留概览，
 * /messages、/profiles、/configuration/application、/adapters 分别提供任务入口。
 * 人工跨会话管理界面已移除；所有状态仅驻留当前页面。
 * DeveloperConsole 接收完整 pathname 以恢复模块详情，负责只读查询与取消，401 继续由本文件统一锁屏。
 * 消息与接入页面复用 PageHeader/Button/FieldMessage，DeliveryStatus 以 StatusBadge 展示投递状态。
 */
import { AppShell, useWorkbenchRouter } from "./components/AppShell.js";
import {
  ProfileWorkspace,
  ProfileSwitcher,
  useProfileWorkspace,
} from "./ProfileWorkspace.js";
import { Overview } from "./Overview.js";
import {
  Button,
  FieldMessage,
  PageHeader,
  StatusBadge,
} from "./components/ui.js";
import { useProfileDraft } from "./use-profile-draft.js";
import {
  ProfileFeedback,
  ProfileField,
  ProfileProblemSummary,
  ProfileSectionIssues,
  validateProfileFields,
  mapProfileProblem,
  type ProfileProblem,
  type Field,
} from "./profile-feedback.js";

import { DeveloperConsole, developerPage } from "./DeveloperConsole.js";

import { AdapterStatusPanel } from "./AdapterStatusPanel.js";

import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Moon,
  RefreshCw,
  Save,
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

import { ConfigurationApplicationScreen } from "./ConfigurationApplicationScreen.js";
import {
  checkGatewayHealth,
  deleteProfile,
  discoverModels,
  GatewayConfig,
  GatewayRequestError,
  GATEWAY_UNAUTHORIZED_EVENT,
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
  type ProfileReadiness,
  type UserConfigProfile,
} from "./api.js";
import {
  mergeProfileEditorFields,
  profileToEditorFields,
  type ProfileEditorFields,
} from "./profile-editor.js";

type DeliveryState = "sending" | "accepted" | "failed";
type HealthState = "idle" | "checking" | "online" | "offline";
type ConfigurationView =
  "locked" | "checking" | "profiles" | "napcat" | "restart" | "chat" | "error";

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
  const [token] = useState(() => readGatewayToken());
  const { path, navigate, register } = useWorkbenchRouter();
  const [configurationView, setConfigurationView] = useState<ConfigurationView>(
    () => (token === "" ? "locked" : "checking"),
  );
  const [invalidAccessLink, setInvalidAccessLink] = useState(false);
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
    const status = await listProfiles({ token });
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
    if (token === "") {
      return;
    }
    let active = true;
    void listProfiles({ token }).then(
      (status) => {
        if (!active) {
          return;
        }
        setConfigurationStatus(status);
        setConfigurationView(
          deriveConfigurationView(status, "checking", false),
        );
      },
      (error) => {
        if (!active) {
          return;
        }
        if (isUnauthorized(error)) {
          setInvalidAccessLink(true);
          setConfigurationView("locked");
        } else {
          setConfigurationError(errorMessage(error));
          setConfigurationView("error");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    const lock = () => {
      setInvalidAccessLink(true);
      setConfigurationView("locked");
    };
    window.addEventListener(GATEWAY_UNAUTHORIZED_EVENT, lock);
    return () => window.removeEventListener(GATEWAY_UNAUTHORIZED_EVENT, lock);
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

  if (configurationView === "locked") {
    return <AccessLinkRequired invalid={invalidAccessLink} />;
  }

  const isOverview = path === "/" || path === "/overview";
  if (!isOverview && configurationView === "checking")
    return <ConfigurationLoading />;
  if (path === "/messages" && configurationView === "error")
    return <ConfigurationStatusError message={configurationError} />;

  const renderPage = () => {
    if (path === "/" || path === "/overview")
      return <Overview token={token} navigate={navigate} />;
    const inspectionPage = developerPage(path);
    if (inspectionPage !== undefined)
      return (
        <DeveloperConsole
          token={token}
          page={inspectionPage}
          path={path}
          navigate={(next) => {
            void navigate(next);
          }}
        />
      );
    if (path === "/profiles") {
      return (
        <ProfileManagementScreen
          token={token}
          initialStatus={configurationStatus}
          onStatusChange={(status) => {
            setConfigurationStatus(status);
          }}
          onReloadStatus={(options) => loadConfigurationStatus(options)}
          onClose={() => {
            void navigate("/messages");
          }}
          onRestartRequired={() => {
            void navigate("/configuration/application");
          }}
          onOpenNapCat={() => void navigate("/adapters")}
        />
      );
    }

    if (path === "/adapters") {
      return (
        <NapCatManagementScreen
          token={token}
          onRestartRequired={() => void navigate("/configuration/application")}
        />
      );
    }

    if (path === "/configuration/application") {
      return (
        <ConfigurationApplicationScreen
          token={token}
          onApplied={() => loadConfigurationStatus()}
          onEdit={() => void navigate("/profiles")}
        />
      );
    }

    return (
      <div className="app-shell">
        <PageHeader
          title="消息"
          description="向当前 Web 会话提交消息并查看接收状态。"
        />
        <main className="workspace wb-message-workspace">
          <aside
            className="connection-panel"
            aria-labelledby="connection-title"
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">连接配置</p>
                <h2 id="connection-title">Kaguya 服务</h2>
              </div>
              <Button
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
              </Button>
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
                <h2 id="chat-title">发送消息</h2>
              </div>
              <Button
                type="button"
                className="secondary-button"
                onClick={() => void navigate("/profiles")}
              >
                <Settings2 size={16} />
                <span>配置</span>
              </Button>
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
                <FieldMessage tone="error">{formError}</FieldMessage>
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
                    draftLength > MAX_MESSAGE_LENGTH
                      ? "limit exceeded"
                      : "limit"
                  }
                >
                  {draftLength.toLocaleString()} /{" "}
                  {MAX_MESSAGE_LENGTH.toLocaleString()}
                </span>
                <Button
                  className="send-button"
                  type="submit"
                  disabled={!canSend}
                >
                  {isSending ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <SendHorizontal size={18} />
                  )}
                  <span>{isSending ? "发送中" : "发送"}</span>
                </Button>
              </div>
            </form>
          </section>
        </main>
      </div>
    );
  };
  return (
    <ProfileWorkspace
      token={token}
      status={configurationStatus!}
      reload={() => loadConfigurationStatus({ keepProfilesOpen: true })}
    >
      <AppShell
        currentPath={path}
        onNavigate={navigate}
        registerNavigationGuard={register}
        profileSlot={<ProfileSwitcher />}
        actions={<ThemeToggle />}
      >
        {renderPage()}
      </AppShell>
    </ProfileWorkspace>
  );
}

function ProfileManagementScreen({
  token,
  initialStatus,
  onStatusChange,
  onReloadStatus,
  onClose,
  onRestartRequired,
  onOpenNapCat,
}: {
  readonly token: string;
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
  const workspace = useProfileWorkspace();
  const {
    editingId: openedProfileId,
    setEditingId: setOpenedProfileId,
    mutating,
    setMutating,
  } = workspace;
  const [loadedProfile, setLoadedProfile] = useState<UserConfigProfile>();
  const [editorFields, setEditorFields] = useState<ProfileEditorFields>();
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [panelError, setPanelError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [readiness, setReadiness] = useState<ProfileReadiness>();
  const [serverIssues, setServerIssues] = useState<ProfileProblem[]>([]);
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const savedFields = loadedProfile
    ? profileToEditorFields(loadedProfile)
    : undefined;
  const dirty =
    editorFields !== undefined &&
    savedFields !== undefined &&
    JSON.stringify(editorFields) !== JSON.stringify(savedFields);
  const localIssues = editorFields ? validateProfileFields(editorFields) : [];
  const savedIssues = loadedProfile
    ? [
        ...(readiness?.issues ?? []).map((issue) =>
          mapProfileProblem(issue, loadedProfile),
        ),
        ...(readiness?.warnings ?? []).map((issue) =>
          mapProfileProblem(issue, loadedProfile, true),
        ),
      ].filter(
        (issue) =>
          !issue.field ||
          savedFields?.[issue.field] === editorFields?.[issue.field],
      )
    : [];
  const issues = [
    ...localIssues.filter(
      (issue) => submitted || (issue.field && touched.has(issue.field)),
    ),
    ...savedIssues,
    ...serverIssues,
  ];
  const draftProtection = useProfileDraft({
    dirty,
    busy: mutating || workspace.applying,
    save: handleSaveProfile,
    register: workspace.registerEditGuard,
  });
  const requestSequence = useRef(0);
  const modelDiscoverySequence = useRef(0);
  const [discoveredModels, setDiscoveredModels] = useState<readonly string[]>(
    [],
  );
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [modelDiscoveryStatus, setModelDiscoveryStatus] = useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  }>();

  const config: GatewayConfig = useMemo(() => ({ token }), [token]);

  useEffect(() => {
    const nextRegistry = readRegistryMetadata(initialStatus);
    setRegistry(nextRegistry);
  }, [initialStatus]);

  useEffect(() => {
    clearLoadedProfileState();
  }, [token]);

  useEffect(() => {
    if (!openedProfileId || token.trim().length === 0) {
      return;
    }
    clearLoadedProfileState();
    const currentSequence = requestSequence.current + 1;
    requestSequence.current = currentSequence;
    setLoadingProfile(true);
    setPanelError(undefined);
    setNotice(undefined);
    void getProfile(config, openedProfileId).then(
      ({ profile, readiness }) => {
        if (requestSequence.current !== currentSequence) {
          return;
        }
        setLoadedProfile(profile);
        setReadiness(readiness);
        setServerIssues([]);
        setTouched(new Set());
        setSubmitted(false);
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

  const selectedProfileId = registry.selectedProfileId;
  const deleteDisabled =
    openedProfileId === undefined ||
    openedProfileId === "default" ||
    openedProfileId === selectedProfileId;
  const saveDisabled =
    mutating ||
    workspace.applying ||
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
    clearModelDiscoveryState();
  }

  function clearModelDiscoveryState() {
    modelDiscoverySequence.current += 1;
    setDiscoveredModels([]);
    setDiscoveringModels(false);
    setModelDiscoveryStatus(undefined);
  }

  async function refreshRegistry() {
    const nextRegistry = await listProfiles(config);
    setRegistry(nextRegistry);
    return nextRegistry;
  }

  async function refreshStatusAfterMutation() {
    const status = await onReloadStatus({ keepProfilesOpen: true });
    onStatusChange(status);
    return status;
  }

  async function handleSaveProfile(): Promise<boolean> {
    if (
      loadedProfile === undefined ||
      editorFields === undefined ||
      mutating ||
      workspace.applying
    )
      return false;
    setSubmitted(true);
    if (validateProfileFields(editorFields).some((issue) => !issue.warning))
      return false;
    setServerIssues([]);
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
      setReadiness(undefined);
      try {
        await refreshRegistry();
        await refreshStatusAfterMutation();
        const refreshed = await getProfile(config, result.profile.id);
        setReadiness(refreshed.readiness);
      } catch {
        setPanelError("配置已保存，但检查状态刷新失败，请重新进入配置页读取。");
      }
      setSubmitted(false);
      setTouched(new Set());
      setNotice(
        result.restartRequired
          ? "配置已保存，点击“应用当前配置”后生效。"
          : "Profile 已保存，选为当前配置并手动应用后生效。",
      );
      return true;
    } catch (error) {
      const fields =
        error instanceof GatewayRequestError ? error.fieldErrors : [];
      setServerIssues(
        error instanceof GatewayRequestError &&
          error.code === "profile_name_conflict"
          ? [
              {
                field: "name",
                section: "profile",
                message: "Profile 名称已存在，请换一个名称。",
              },
            ]
          : fields.map((issue) => mapProfileProblem(issue, loadedProfile)),
      );
      setPanelError(
        "保存失败，草稿已保留。" +
          (fields.length ? "请检查标记字段。" : errorMessage(error)),
      );
      return false;
    } finally {
      setMutating(false);
    }
  }

  const handleSelectProfile = async () => {
    if (openedProfileId === undefined || !(await draftProtection.request()))
      return;
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
      setNotice(
        status.status === "ready"
          ? "当前选择已保存。"
          : "当前选择已保存，请检查配置后手动应用。",
      );
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (
      openedProfileId === undefined ||
      deleteDisabled ||
      !(await draftProtection.request())
    )
      return;
    setMutating(true);
    setPanelError(undefined);
    setNotice(undefined);
    try {
      await deleteProfile(config, openedProfileId);
      clearLoadedProfileState();
      const nextRegistry = await refreshRegistry();
      const status = await refreshStatusAfterMutation();
      setRegistry(nextRegistry);
      setOpenedProfileId(nextRegistry.selectedProfileId);
      setNotice("Profile deleted.");
    } catch (error) {
      setPanelError(errorMessage(error));
    } finally {
      setMutating(false);
    }
  };

  const handleDiscoverModels = async () => {
    if (editorFields === undefined) return;
    if (
      editorFields.baseUrl.trim().length === 0 ||
      editorFields.apiKey.trim().length === 0
    ) {
      setModelDiscoveryStatus({
        kind: "error",
        message: "请先填写模型服务地址和 API Key。",
      });
      return;
    }
    const sequence = modelDiscoverySequence.current + 1;
    modelDiscoverySequence.current = sequence;
    setDiscoveringModels(true);
    setModelDiscoveryStatus(undefined);
    try {
      const models = await discoverModels(config, {
        baseUrl: editorFields.baseUrl,
        apiKey: editorFields.apiKey,
      });
      if (modelDiscoverySequence.current !== sequence) return;
      setDiscoveredModels(models);
      setModelDiscoveryStatus({
        kind: "success",
        message:
          models.length === 0
            ? "Provider 返回了空模型列表，仍可手动填写模型 ID。"
            : `已获取 ${models.length} 个模型，可搜索选择或继续手动填写。`,
      });
    } catch (error) {
      if (modelDiscoverySequence.current !== sequence) return;
      setDiscoveredModels([]);
      setModelDiscoveryStatus({ kind: "error", message: errorMessage(error) });
    } finally {
      if (modelDiscoverySequence.current === sequence) {
        setDiscoveringModels(false);
      }
    }
  };

  return (
    <ProfileFeedback
      value={{
        issues,
        touch: (field) => setTouched((current) => new Set([...current, field])),
      }}
    >
      {draftProtection.dialog}
      <div className="setup-shell">
        <PageHeader
          title="配置"
          description="在全局顶栏选择编辑对象；保存、设为当前与应用分别操作。"
          actions={
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              返回消息
            </button>
          }
        />
        <main className="setup-main profile-main">
          <div className="profile-workspace profile-single-column">
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
                    <span>Gateway / Adapter</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      openedProfileId === undefined ||
                      mutating ||
                      workspace.applying
                    }
                    onClick={() => void handleSelectProfile()}
                  >
                    选为当前配置
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={mutating}
                    onClick={onRestartRequired}
                  >
                    配置生效管理
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={deleteDisabled || mutating || workspace.applying}
                    onClick={() => void handleDeleteProfile()}
                  >
                    <Trash2 size={16} />
                    <span>删除</span>
                  </button>
                </div>
              </div>

              <p className="setup-intro profile-intro">
                保存仅写入配置；请进入“配置生效管理”手动应用。 其他 Profile
                仅保存，选为当前配置时再应用。
              </p>

              <ProfileProblemSummary
                name={loadedProfile?.name ?? openedProfileId ?? "Profile"}
              />
              <ProfileSectionIssues section="profile" />
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
                  noValidate
                  onChange={() => setServerIssues([])}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSaveProfile();
                  }}
                >
                  <fieldset
                    className="profile-form-lock"
                    disabled={mutating || workspace.applying}
                  >
                    <label className="field">
                      <span>Profile 名称</span>
                      <ProfileField name="name">
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
                      </ProfileField>
                    </label>
                    <fieldset className="identity-fields">
                      <legend>Agent 身份</legend>
                      <ProfileSectionIssues section="identity" />
                      <p className="field-help">
                        名字、别名和人设会用于回复
                        Prompt；保存后手动应用才生效。
                      </p>
                      <label className="field">
                        <span>Agent 名字</span>
                        <ProfileField name="agentName">
                          <input
                            value={editorFields.agentName}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      agentName: event.target.value,
                                    },
                              )
                            }
                            autoComplete="off"
                            placeholder="Kaguya"
                            required
                          />
                        </ProfileField>
                      </label>
                      <label className="field">
                        <span>Agent 别名</span>
                        <ProfileField name="agentAliasesText">
                          <textarea
                            value={editorFields.agentAliasesText}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      agentAliasesText: event.target.value,
                                    },
                              )
                            }
                            rows={3}
                            spellCheck={false}
                            aria-describedby="agent-aliases-help"
                            placeholder="辉夜"
                            required
                          />
                        </ProfileField>
                        <span id="agent-aliases-help" className="field-help">
                          每行一个别名；保存时会去除首尾空白并去重。
                        </span>
                      </label>
                      <label className="field">
                        <span>Agent 人设</span>
                        <ProfileField name="agentPersona">
                          <textarea
                            className="persona-editor"
                            value={editorFields.agentPersona}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      agentPersona: event.target.value,
                                    },
                              )
                            }
                            rows={6}
                            placeholder="描述 Agent 的身份、语气和回复边界"
                            required
                          />
                        </ProfileField>
                      </label>
                      <label className="field">
                        <span>Agent 开机人设</span>
                        <ProfileField name="agentStartupPersona">
                          <textarea
                            className="persona-editor"
                            value={editorFields.agentStartupPersona}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      agentStartupPersona: event.target.value,
                                    },
                              )
                            }
                            rows={4}
                            placeholder="留空则冷启动时沿用上方人设"
                          />
                        </ProfileField>
                        <span className="field-help">
                          尚无对话历史与记忆时替代上方人设；留空则沿用上方人设。
                        </span>
                      </label>
                      <label className="field">
                        <span>Agent 时区</span>
                        <ProfileField name="agentTimeZone">
                          <input
                            value={editorFields.agentTimeZone}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      agentTimeZone: event.target.value,
                                    },
                              )
                            }
                            autoComplete="off"
                            placeholder="Asia/Shanghai"
                            required
                          />
                        </ProfileField>
                        <span className="field-help">
                          用于理解当前时间、早晚和跨天语义。
                        </span>
                      </label>
                    </fieldset>
                    <fieldset className="identity-fields">
                      <legend>模型服务</legend>
                      <ProfileSectionIssues section="models" />
                      <label className="field">
                        <span>模型服务地址</span>
                        <ProfileField name="baseUrl">
                          <input
                            type="url"
                            value={editorFields.baseUrl}
                            onChange={(event) => {
                              clearModelDiscoveryState();
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : { ...current, baseUrl: event.target.value },
                              );
                            }}
                            autoComplete="url"
                            placeholder="https://api.openai.com/v1"
                          />
                        </ProfileField>
                      </label>
                      <label className="field">
                        <span>模型服务 API Key</span>
                        <div className="password-field">
                          <ProfileField name="apiKey">
                            <input
                              type={showApiKey ? "text" : "password"}
                              value={editorFields.apiKey}
                              onChange={(event) => {
                                clearModelDiscoveryState();
                                setEditorFields((current) =>
                                  current === undefined
                                    ? current
                                    : {
                                        ...current,
                                        apiKey: event.target.value,
                                      },
                                );
                              }}
                              autoComplete="new-password"
                              placeholder="Enter provider API key"
                            />
                          </ProfileField>
                          <button
                            type="button"
                            className="icon-button"
                            onClick={() => setShowApiKey((current) => !current)}
                            aria-label={
                              showApiKey ? "Hide API key" : "Show API key"
                            }
                            title={showApiKey ? "Hide API key" : "Show API key"}
                          >
                            {showApiKey ? (
                              <EyeOff size={18} />
                            ) : (
                              <Eye size={18} />
                            )}
                          </button>
                        </div>
                      </label>
                      <div className="model-discovery-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={discoveringModels}
                          onClick={() => void handleDiscoverModels()}
                        >
                          <RefreshCw
                            className={discoveringModels ? "spin" : undefined}
                            size={16}
                          />
                          <span>
                            {discoveringModels ? "正在获取" : "获取模型列表"}
                          </span>
                        </button>
                        {modelDiscoveryStatus ? (
                          <span
                            className={`model-discovery-status ${modelDiscoveryStatus.kind}`}
                            role={
                              modelDiscoveryStatus.kind === "error"
                                ? "alert"
                                : "status"
                            }
                            aria-live="polite"
                          >
                            {modelDiscoveryStatus.message}
                          </span>
                        ) : null}
                      </div>
                      {discoveredModels.length > 0 ? (
                        <datalist id="discovered-models">
                          {discoveredModels.map((modelId) => (
                            <option key={modelId} value={modelId} />
                          ))}
                        </datalist>
                      ) : null}
                      <div className="setup-model-grid">
                        <ModelTierEditor
                          tier="light"
                          fields={editorFields}
                          modelListId={
                            discoveredModels.length > 0
                              ? "discovered-models"
                              : undefined
                          }
                          onChange={(patch) =>
                            setEditorFields((current) =>
                              current === undefined
                                ? current
                                : { ...current, ...patch },
                            )
                          }
                        />
                        <ModelTierEditor
                          tier="heavy"
                          fields={editorFields}
                          modelListId={
                            discoveredModels.length > 0
                              ? "discovered-models"
                              : undefined
                          }
                          onChange={(patch) =>
                            setEditorFields((current) =>
                              current === undefined
                                ? current
                                : { ...current, ...patch },
                            )
                          }
                        />
                      </div>
                    </fieldset>
                    <fieldset className="identity-fields">
                      <legend>消息白名单</legend>
                      <ProfileSectionIssues section="allowlist" />
                      <label className="field">
                        <span>入站白名单</span>
                        <ProfileField name="inboundAllowlistText">
                          <textarea
                            className="rule-editor"
                            value={editorFields.inboundAllowlistText}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      inboundAllowlistText: event.target.value,
                                    },
                              )
                            }
                            rows={5}
                            spellCheck={false}
                            autoComplete="off"
                            aria-describedby="inbound-allowlist-help"
                            placeholder={
                              "qq:group:REPLACE_GROUP_ID\nqq:private:REPLACE_USER_ID"
                            }
                          />
                        </ProfileField>
                        <span
                          id="inbound-allowlist-help"
                          className="field-help"
                        >
                          决定哪些平台消息可以进入 Runtime；被拒绝的消息不会创建
                          turn。 每行一条 platform:group|private:ID，platform 和
                          ID 支持 *。 空列表拒绝所有非 Web
                          平台入站消息；无效行会保存但不生效。 Web
                          保持原有认证边界。保存后需点击“应用当前配置”。
                        </span>
                      </label>
                      <label className="field">
                        <span>出站白名单</span>
                        <ProfileField name="outboundAllowlistText">
                          <textarea
                            className="rule-editor"
                            value={editorFields.outboundAllowlistText}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      outboundAllowlistText: event.target.value,
                                    },
                              )
                            }
                            rows={5}
                            spellCheck={false}
                            autoComplete="off"
                            aria-describedby="outbound-allowlist-help"
                            placeholder={
                              "qq:group:REPLACE_GROUP_ID\nqq:private:REPLACE_USER_ID"
                            }
                          />
                        </ProfileField>
                        <span
                          id="outbound-allowlist-help"
                          className="field-help"
                        >
                          决定机器人可以向哪些群或用户投递；被拒绝时不会调用平台发送接口。跨会话发送仍需管理端确认。
                          每行一条 platform:group|private:ID，platform 和 ID
                          支持 *。 空列表拒绝所有非 Web
                          平台出站消息；无效行会保存但不生效。 Web
                          保持原有认证边界。保存后需点击“应用当前配置”。
                        </span>
                      </label>
                    </fieldset>
                    <fieldset className="identity-fields">
                      <legend>Memory</legend>
                      <ProfileSectionIssues section="memory" />
                      <label className="setup-check">
                        <ProfileField name="memoryEnabled">
                          <input
                            type="checkbox"
                            checked={editorFields.memoryEnabled}
                            onChange={(event) =>
                              setEditorFields((current) =>
                                current === undefined
                                  ? current
                                  : {
                                      ...current,
                                      memoryEnabled: event.target.checked,
                                    },
                              )
                            }
                          />
                        </ProfileField>
                        <span>
                          启用 Memory
                          <br />
                          关闭时仅保留联想与 Prompt
                          协议形状，不读取、写入或召回实际信息。
                        </span>
                      </label>
                    </fieldset>
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
                      <span>{mutating ? "正在保存" : "保存配置"}</span>
                    </button>
                  </fieldset>
                </form>
              ) : null}
            </section>
          </div>
        </main>
      </div>
    </ProfileFeedback>
  );
}

function ModelTierEditor({
  tier,
  fields,
  modelListId,
  onChange,
}: {
  readonly tier: "light" | "heavy";
  readonly fields: ProfileEditorFields;
  readonly modelListId?: string | undefined;
  readonly onChange: (patch: Partial<ProfileEditorFields>) => void;
}) {
  const light = tier === "light";
  const label = light ? "轻量模型" : "重量模型";
  const model = light ? fields.lightModel : fields.heavyModel;
  const thinkingEnabled = light
    ? fields.lightThinkingEnabled
    : fields.heavyThinkingEnabled;
  const reasoningEffort = light
    ? fields.lightReasoningEffort
    : fields.heavyReasoningEffort;
  const recommendedDurationMs = light
    ? fields.lightRecommendedDurationMs
    : fields.heavyRecommendedDurationMs;
  return (
    <fieldset className="identity-fields model-tier-fields">
      <legend>{label}</legend>
      <label className="field">
        <span>模型 ID</span>
        <ProfileField name={`${tier}Model`}>
          <input
            value={model}
            list={modelListId}
            onChange={(event) =>
              onChange(
                light
                  ? { lightModel: event.target.value }
                  : { heavyModel: event.target.value },
              )
            }
            autoComplete="off"
            placeholder={light ? "gpt-4o-mini" : "gpt-4o"}
          />
        </ProfileField>
      </label>
      <label className="setup-check thinking-toggle">
        <ProfileField name={`${tier}ThinkingEnabled`}>
          <input
            type="checkbox"
            checked={thinkingEnabled}
            onChange={(event) =>
              onChange(
                light
                  ? { lightThinkingEnabled: event.target.checked }
                  : { heavyThinkingEnabled: event.target.checked },
              )
            }
          />
        </ProfileField>
        <span>
          启用思考模式
          <br />
          关闭时向 AI SDK 传递 reasoning: none。
        </span>
      </label>
      <label className="field">
        <span>Reasoning effort</span>
        <ProfileField name={`${tier}ReasoningEffort`}>
          <select
            value={reasoningEffort}
            disabled={!thinkingEnabled}
            onChange={(event) =>
              onChange(
                light
                  ? { lightReasoningEffort: event.target.value }
                  : { heavyReasoningEffort: event.target.value },
              )
            }
          >
            <option value="provider-default">Provider 默认</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">XHigh</option>
          </select>
        </ProfileField>
      </label>
      <label className="field">
        <span>模型调用超时（秒）</span>
        <ProfileField name={`${tier}TimeoutSeconds`}>
          <input
            type="number"
            min="0.001"
            max="300"
            step="0.001"
            value={
              light ? fields.lightTimeoutSeconds : fields.heavyTimeoutSeconds
            }
            onChange={(event) =>
              onChange(
                light
                  ? { lightTimeoutSeconds: event.target.value }
                  : { heavyTimeoutSeconds: event.target.value },
              )
            }
            placeholder="300"
          />
        </ProfileField>
        <span className="field-help">
          超过该时间会终止模型调用；留空使用 300 秒。
        </span>
      </label>
      <label className="field">
        <span>推荐响应时间（毫秒）</span>
        <ProfileField name={`${tier}RecommendedDurationMs`}>
          <input
            type="number"
            min="1"
            max="300000"
            step="1"
            value={recommendedDurationMs}
            onChange={(event) =>
              onChange(
                light
                  ? { lightRecommendedDurationMs: event.target.value }
                  : { heavyRecommendedDurationMs: event.target.value },
              )
            }
          />
        </ProfileField>
        <span className="field-help">
          软预算：仅供调度与观测参考，不会中断较慢但有效的调用。
        </span>
      </label>
    </fieldset>
  );
}

function NapCatManagementScreen({
  token,
  onRestartRequired,
}: {
  readonly token: string;
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
      <PageHeader
        title="接入"
        description="查看 Gateway / Adapter 状态并管理平台连接。"
      />
      <main className="setup-main wb-adapter-main">
        <AdapterStatusPanel token={token} />
        <section className="setup-card" aria-labelledby="napcat-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">平台连接</p>
              <h2 id="napcat-title">配置 NapCat</h2>
            </div>
          </div>
          <p className="setup-intro">
            填写 NapCat OneBot 正向 WebSocket（服务器）参数。保存后手动应用，
            适配器会用新配置重新连接，无需重启 Kaguya。
          </p>
          {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
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
                <span>启用 NapCat</span>
              </label>
              <label className="field">
                <span>正向 WebSocket 服务器地址</span>
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
                  <Button
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
                  </Button>
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
              <Button className="setup-button" type="submit" disabled={saving}>
                {saving ? "正在保存" : "保存配置"}
              </Button>
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

function AccessLinkRequired({ invalid }: { readonly invalid: boolean }) {
  return (
    <div className="setup-shell">
      <SetupHeader subtitle="访问受限" />
      <section className="setup-card setup-status-card" role="alert">
        <LockKeyhole size={22} />
        <h1>{invalid ? "访问链接已失效" : "需要启动访问链接"}</h1>
        <p>
          {invalid
            ? "Server 每次重启都会生成新链接。请回到当前 Kaguya Server 的终端，重新打开完整链接。"
            : "请回到 Kaguya Server 的终端，打开其中显示的完整 Kaguya access URL。"}
        </p>
        <code className="access-link-example">
          Kaguya access URL: …/#gatewayToken=…
        </code>
      </section>
    </div>
  );
}

function SetupHeader({ subtitle }: { readonly subtitle: string }) {
  return (
    <header className="topbar">
      <BrandIdentity subtitle={subtitle} />
      <div className="topbar-spacer" />
      <ThemeToggle />
    </header>
  );
}

function BrandIdentity({ subtitle }: { readonly subtitle: string }) {
  return (
    <div className="brand-identity">
      <img className="brand-logo" src="/kaguya-logo.png" alt="" />
      <div>
        <h1>Kaguya</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

type Theme = "light" | "dark";

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const nextTheme = theme === "light" ? "dark" : "light";
  const nextThemeLabel = nextTheme === "dark" ? "深色" : "浅色";

  const toggleTheme = () => {
    document.documentElement.dataset.theme = nextTheme;
    try {
      localStorage.setItem("kaguya.theme", nextTheme);
    } catch {
      // The selected theme still applies for this page when storage is unavailable.
    }
    setTheme(nextTheme);
  };

  return (
    <button
      className="theme-button"
      type="button"
      onClick={toggleTheme}
      aria-label={`切换至${nextThemeLabel}主题`}
      title={`切换至${nextThemeLabel}主题`}
    >
      {nextTheme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      <span>{nextThemeLabel}</span>
    </button>
  );
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function DeliveryStatus({ message }: { readonly message: ChatMessage }) {
  if (message.state === "sending") {
    return (
      <p className="delivery-status sending">
        <StatusBadge>
          <LoaderCircle className="spin" size={15} />
          正在提交
        </StatusBadge>
      </p>
    );
  }
  if (message.state === "accepted") {
    return (
      <p className="delivery-status accepted" title={message.requestId}>
        <StatusBadge tone="success">
          <CheckCircle2 size={15} />
          服务已接收
          <code>{shortRequestId(message.requestId)}</code>
        </StatusBadge>
      </p>
    );
  }
  return (
    <p className="delivery-status failed">
      <StatusBadge tone="error">
        <AlertCircle size={15} />
        {message.error ?? "提交失败"}
      </StatusBadge>
    </p>
  );
}

export function readGatewayToken(
  hash = typeof location === "undefined" ? "" : location.hash,
): string {
  const match = /^#gatewayToken=([^&]*)$/u.exec(hash);
  if (match === null) {
    return "";
  }
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return "";
  }
}

export function deriveConfigurationView(
  status: ConfigurationStatus,
  current: ConfigurationView,
  keepProfilesOpen: boolean,
): ConfigurationView {
  if (status.status === "invalid" || status.status === "review_required") {
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof GatewayRequestError && error.status === 401;
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
