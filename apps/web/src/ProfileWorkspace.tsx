/**
 * 状态未加载或读取失败时允许概览继续渲染，菜单只显示占位，不推断 selected Profile。
 * 编辑切换冻结守卫集合，异步保存期间重新注册的守卫只影响下一次切换。
 * 功能概述：认证工作台共享 Profile 编辑上下文和安全的配置应用状态，不读取配置正文。
 * 主要职责：ProfileWorkspace 保存编辑 ID、操作锁及应用快照；ProfileSwitcher 用 Radix
 * 菜单切换查看对象、用 Dialog 新建配置。profileLabels 独立描述 selected 与已生效 revision。
 * 代码库关系：App 在 AppShell 外挂载本 Provider；配置编辑器显式保存/选择/删除，
 * ConfigurationApplicationScreen 回传应用进度。顶栏只调用 create 和只读状态接口。
 * 输入输出与副作用：编辑切换可注册异步草稿守卫；应用期间禁止切换及新建；轮询只读
 * application 状态，失败保留最后快照并明确提示；秘密字段不会进入菜单或浏览器存储。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { checkNavigationGuards } from "./components/navigation-guards.js";
import { ChevronDown, Plus } from "lucide-react";
import { Button, Dialog, DropdownMenu, FieldMessage } from "./components/ui.js";
import {
  createProfile,
  getConfigurationApplication,
  type ConfigurationApplicationStatus,
  type ConfigurationStatus,
} from "./api.js";
import "./profile-workspace.css";

type Guard = () => boolean | Promise<boolean>;
interface Workspace {
  editingId: string | undefined;
  setEditingId: (id: string) => void;
  requestEdit: (id: string) => Promise<boolean>;
  registerEditGuard: (guard: Guard) => () => void;
  beforeEdit: () => Promise<boolean>;
  status: ConfigurationStatus | undefined;
  application: ConfigurationApplicationStatus | undefined;
  applicationError: string | undefined;
  statusError: string | undefined;
  applying: boolean;
  mutating: boolean;
  setMutating: (busy: boolean) => void;
  reportApplication: (
    snapshot: ConfigurationApplicationStatus | undefined,
    busy: boolean,
    error?: string,
  ) => void;
  refreshApplication: () => Promise<void>;
  token: string;
  reload: () => Promise<unknown>;
}
const Context = createContext<Workspace | null>(null);
export function useProfileWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("Profile 编辑需要工作台上下文");
  return value;
}
export function profileLabels(
  id: string,
  selectedId: string,
  application?: ConfigurationApplicationStatus,
  applying = false,
  failed = false,
): string[] {
  const labels: string[] = [];
  if (id === selectedId) labels.push("selected（当前选择）");
  if (id === application?.appliedProfileId) labels.push("已生效");
  if (id === application?.selectedProfileId) {
    if (applying || application.state === "applying") labels.push("应用中");
    else if (application.selectedRevision !== application.appliedRevision)
      labels.push("待应用");
    if (failed || application.state === "degraded") labels.push("应用失败");
  }
  return labels;
}
export function ProfileWorkspace({
  token,
  status,
  reload,
  children,
}: {
  token: string;
  status: ConfigurationStatus | undefined;
  reload: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [editingId, setEditingId] = useState<string | undefined>(
    status?.selectedProfileId,
  );
  useEffect(() => {
    if (status) setEditingId((current) => current ?? status.selectedProfileId);
  }, [status]);
  const [application, setApplication] =
    useState<ConfigurationApplicationStatus>();
  const [applicationError, setApplicationError] = useState<string>();
  const [statusError, setStatusError] = useState<string>();
  const [localApplying, setLocalApplying] = useState(false);
  const [mutating, setMutating] = useState(false);
  const guards = useRef(new Set<Guard>());
  const applicationSequence = useRef(0);
  const refreshApplication = useCallback(async () => {
    const sequence = ++applicationSequence.current;
    try {
      const snapshot = await getConfigurationApplication({ token });
      if (sequence === applicationSequence.current) {
        setApplication(snapshot);
        setStatusError(undefined);
      }
    } catch {
      if (sequence === applicationSequence.current)
        setStatusError("无法刷新应用状态，请重试。");
    }
  }, [token]);
  useEffect(() => {
    void refreshApplication();
    const timer = window.setInterval(() => void refreshApplication(), 5000);
    return () => {
      window.clearInterval(timer);
      applicationSequence.current += 1;
    };
  }, [refreshApplication, status]);
  const reportApplication = useCallback(
    (
      snapshot: ConfigurationApplicationStatus | undefined,
      busy: boolean,
      error?: string,
    ) => {
      applicationSequence.current += 1;
      if (snapshot) setApplication(snapshot);
      setLocalApplying(busy);
      setApplicationError(error);
    },
    [],
  );
  const registerEditGuard = useCallback((guard: Guard) => {
    guards.current.add(guard);
    return () => {
      guards.current.delete(guard);
    };
  }, []);
  const applying = localApplying || application?.state === "applying";
  const beforeEdit = async () => {
    if (applying || mutating) return false;
    return checkNavigationGuards(guards.current);
  };
  const requestEdit = async (id: string) => {
    if (id === editingId) return true;
    if (!(await beforeEdit())) return false;
    setEditingId(id);
    return true;
  };
  return (
    <Context.Provider
      value={{
        editingId,
        setEditingId,
        requestEdit,
        registerEditGuard,
        beforeEdit,
        status,
        application,
        applicationError,
        statusError,
        applying,
        mutating,
        setMutating,
        reportApplication,
        refreshApplication,
        token,
        reload,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function ProfileSwitcher() {
  const workspace = useProfileWorkspace();
  const {
    status,
    editingId,
    application,
    applying,
    mutating,
    applicationError,
  } = workspace;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  if (!status)
    return (
      <span role="status">Profile 状态尚未就绪，请等待加载或重试概览。</span>
    );
  const editing = status.profiles.find((profile) => profile.id === editingId);
  const labels = (id: string) =>
    profileLabels(
      id,
      status.selectedProfileId,
      application,
      applying,
      Boolean(applicationError),
    );
  const create = async () => {
    if (!name.trim()) {
      setError("请输入 Profile 名称。");
      return;
    }
    workspace.setMutating(true);
    setError(undefined);
    try {
      const result = await createProfile(
        { token: workspace.token },
        { name: name.trim() },
      );
      await workspace.reload();
      workspace.setEditingId(result.profile.id);
      setOpen(false);
      setName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败，请重试。");
    } finally {
      workspace.setMutating(false);
    }
  };
  return (
    <div className="profile-switcher">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            disabled={applying || mutating}
            aria-label={`编辑 Profile：${editing?.name ?? editingId}`}
          >
            <span>编辑：{editing?.name ?? editingId}</span>
            <ChevronDown size={16} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="wb-dropdown profile-menu"
            align="end"
            sideOffset={8}
          >
            <DropdownMenu.Label>
              切换查看与编辑（不会设为当前或应用）
            </DropdownMenu.Label>
            {status.profiles.map((profile) => (
              <DropdownMenu.Item
                key={profile.id}
                disabled={applying || mutating}
                onSelect={() => void workspace.requestEdit(profile.id)}
              >
                <strong>
                  {profile.name}
                  {profile.id === editingId ? " · 正在编辑" : ""}
                </strong>
                <small>{labels(profile.id).join(" · ") || "仅保存"}</small>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              disabled={applying || mutating}
              onSelect={() => {
                void workspace.beforeEdit().then((allowed) => {
                  if (allowed) {
                    setError(undefined);
                    setOpen(true);
                  }
                });
              }}
            >
              <Plus size={16} /> 新建 Profile
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span className="profile-status-line" role="status">
        {labels(editingId ?? "").join(" · ") || "仅编辑，未设为当前"}
      </span>
      <span className="profile-runtime-line">
        当前选择：
        {status.profiles.find((p) => p.id === status.selectedProfileId)?.name ??
          status.selectedProfileId}{" "}
        · 已生效：
        {status.profiles.find((p) => p.id === application?.appliedProfileId)
          ?.name ??
          application?.appliedProfileId ??
          "尚未确认"}
        {applying
          ? " · 应用中"
          : application?.state === "pending"
            ? " · 待应用"
            : application?.state === "degraded"
              ? " · 应用失败"
              : ""}
      </span>
      {applicationError && <span role="alert">{applicationError}</span>}
      {workspace.statusError && (
        <span role="alert">{workspace.statusError}</span>
      )}
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!mutating) setOpen(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="wb-overlay" />
          <Dialog.Content className="wb-dialog">
            <Dialog.Title>新建 Profile</Dialog.Title>
            <Dialog.Description>
              创建后切换编辑上下文；设为当前与应用仍需在配置页明确操作。
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label className="field">
                Profile 名称
                <input
                  value={name}
                  disabled={mutating}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {error && <FieldMessage tone="error">{error}</FieldMessage>}
              <div className="editor-actions">
                <Button type="submit" disabled={mutating || applying}>
                  {mutating ? "创建中…" : "创建"}
                </Button>
                <Dialog.Close asChild>
                  <Button disabled={mutating}>取消</Button>
                </Dialog.Close>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
