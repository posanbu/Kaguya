/**
 * 功能概述：冻结一次导航的离开守卫集合，避免 React 重渲染期间注册变化影响待决导航。
 * 主要职责：checkNavigationGuards 先复制 Iterable，再依次等待守卫；拒绝或异常均阻止导航。
 * 代码库关系：AppShell 页面/历史导航与 ProfileWorkspace 编辑切换共享此异步边界。
 * 输入输出与副作用：只调用开始时的守卫；等待期间增删的注册留给下一次导航，不重复保存确认。
 */
export type NavigationGuard = () => boolean | Promise<boolean>;
export async function checkNavigationGuards(
  guards: Iterable<NavigationGuard>,
): Promise<boolean> {
  const snapshot = [...guards];
  try {
    for (const guard of snapshot) if (!(await guard())) return false;
    return true;
  } catch {
    return false;
  }
}
