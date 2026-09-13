/**
 * 功能概述：所有认证后页面共享的工作台、五域侧栏和移动导航抽屉。
 * 主要职责：AppShell 提供顶栏 profileSlot/actions 插槽；SideNav 通过 currentPath
 * 标识任务域。useNavigationGuard 注册离开保护，useWorkbenchNavigate 复用受保护导航。
 * 代码库关系：App.tsx 管理认证及 history，页面作为 children 注入；复杂交互采用
 * ui.tsx 导出的 Radix Dialog/DropdownMenu，视觉沿用 workbench.css 和品牌素材。
 * 输入输出与副作用：导航守卫返回 false 时保留当前页和抽屉；成功导航关闭抽屉。
 * 抽屉由 Radix 管理焦点圈定、Escape 和触发器焦点恢复；不读取或持久化 Token。
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
import {
  House,
  Menu,
  MessagesSquare,
  Plug,
  ScanSearch,
  Settings2,
  X,
} from "lucide-react";
import { Button, Dialog } from "./ui.js";
import "./workbench.css";
export const workbenchRoutes = [
  { path: "/", label: "概览", icon: House },
  { path: "/messages", label: "消息", icon: MessagesSquare },
  { path: "/profiles", label: "配置", icon: Settings2 },
  { path: "/adapters", label: "接入", icon: Plug },
  { path: "/developer/modules", label: "检查", icon: ScanSearch },
] as const;
export function navigationDomain(path: string): string {
  if (path.startsWith("/developer")) return "/developer/modules";
  if (path.startsWith("/profiles") || path.startsWith("/configuration"))
    return "/profiles";
  if (path.startsWith("/adapters")) return "/adapters";
  return path === "/messages" ? "/messages" : "/";
}
type Guard = () => boolean | Promise<boolean>;
const NavigationContext = createContext<{
  navigate: (path: string) => void;
  register: (guard: Guard) => () => void;
} | null>(null);
/** App 使用的路由控制器：守卫通过后才变更 URL，popstate 被拒绝时恢复当前 URL。 */
export function useWorkbenchRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  const guards = useRef(new Set<Guard>());
  const current = useRef(path);
  const sequence = useRef(0);
  const register = useCallback((guard: Guard) => {
    guards.current.add(guard);
    return () => {
      guards.current.delete(guard);
    };
  }, []);
  const transition = useCallback(async (next: string, pop: boolean) => {
    const request = ++sequence.current;
    if (next !== current.current)
      for (const guard of guards.current) {
        if (!(await guard())) {
          if (pop && request === sequence.current)
            window.history.pushState(
              null,
              "",
              `${current.current}${window.location.hash}`,
            );
          return false;
        }
      }
    if (request !== sequence.current) return false;
    if (!pop && next !== current.current)
      window.history.pushState(null, "", `${next}${window.location.hash}`);
    current.current = next;
    setPath(next);
    return true;
  }, []);
  const navigate = useCallback(
    (next: string) => transition(next, false),
    [transition],
  );
  useEffect(() => {
    const pop = () => {
      void transition(window.location.pathname, true);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [transition]);
  return { path, navigate, register };
}
export function useNavigationGuard(guard: Guard) {
  const context = useContext(NavigationContext);
  useEffect(() => context?.register(guard), [context, guard]);
}
export function useWorkbenchNavigate() {
  const context = useContext(NavigationContext);
  if (!context) throw new Error("工作台导航需要 AppShell");
  return context.navigate;
}
export function SideNav({
  currentPath,
  onNavigate,
}: {
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <nav className="wb-nav" aria-label="工作台导航">
      {workbenchRoutes.map(({ path, label, icon: Icon }) => (
        <a
          key={path}
          href={path}
          aria-current={
            navigationDomain(currentPath) === path ? "page" : undefined
          }
          onClick={(event) => {
            event.preventDefault();
            onNavigate(path);
          }}
        >
          <Icon size={19} aria-hidden="true" />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}
export function AppShell({
  children,
  currentPath,
  onNavigate,
  profileSlot,
  actions,
  registerNavigationGuard,
}: {
  children: ReactNode;
  currentPath: string;
  onNavigate: (path: string) => Promise<boolean>;
  registerNavigationGuard: (guard: Guard) => () => void;
  profileSlot?: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useCallback(
    (path: string) => {
      void onNavigate(path).then((allowed) => {
        if (allowed) setOpen(false);
      });
    },
    [onNavigate],
  );
  return (
    <NavigationContext.Provider
      value={{ navigate, register: registerNavigationGuard }}
    >
      <div className="wb-shell">
        <a className="wb-skip" href="#workbench-content">
          跳转到页面内容
        </a>
        <aside className="wb-sidebar">
          <div className="wb-brand">
            <img src="/kaguya-logo.png" alt="" />
            <strong>Kaguya</strong>
          </div>
          <SideNav currentPath={currentPath} onNavigate={navigate} />
        </aside>
        <div className="wb-body">
          <header className="wb-topbar">
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Trigger asChild>
                <Button className="wb-menu" aria-label="打开导航">
                  <Menu size={20} />
                </Button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="wb-overlay" />
                <Dialog.Content className="wb-drawer">
                  <Dialog.Title>工作台导航</Dialog.Title>
                  <Dialog.Description className="wb-sr-only">
                    选择要进入的任务域
                  </Dialog.Description>
                  <Dialog.Close asChild>
                    <Button aria-label="关闭导航">
                      <X size={18} />
                    </Button>
                  </Dialog.Close>
                  <SideNav currentPath={currentPath} onNavigate={navigate} />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <span className="wb-topbar-label">Kaguya 工作台</span>
            <div className="wb-profile-slot">{profileSlot}</div>
            {actions}
          </header>
          <div id="workbench-content" tabIndex={-1} className="wb-content">
            {children}
          </div>
        </div>
      </div>
    </NavigationContext.Provider>
  );
}
