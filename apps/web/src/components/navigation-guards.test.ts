/**
 * 功能概述：复现保存期间 React effect 注销再注册守卫时的活 Set 迭代回归。
 * 主要职责：等待首个守卫时将它重新添加并改变返回值，验证当前导航只调用一次；
 * 下一次导航使用最新集合，异常仍失败关闭。
 * 代码库关系：测试页面导航和 Profile 切换共享的 navigation-guards，不依赖 DOM 或真实保存。
 * 输入输出与副作用：只在内存中模拟异步保存、注册变动和拒绝，不修改配置。
 */
import { expect, it, vi } from "vitest";
import {
  checkNavigationGuards,
  type NavigationGuard,
} from "./navigation-guards.js";
it("保存等待中注销再注册同一守卫，不重复检查 busy/dirty 而阻断已完成的导航", async () => {
  let resolve!: (allowed: boolean) => void;
  const save = new Promise<boolean>((done) => {
    resolve = done;
  });
  const guard = vi
    .fn<NavigationGuard>()
    .mockReturnValueOnce(save)
    .mockReturnValue(false);
  const guards = new Set<NavigationGuard>([guard]);
  const transition = checkNavigationGuards(guards);
  guards.delete(guard);
  guards.add(guard);
  resolve(true);
  await expect(transition).resolves.toBe(true);
  expect(guard).toHaveBeenCalledTimes(1);
  await expect(checkNavigationGuards(guards)).resolves.toBe(false);
});
it("新增守卫仅影响下一次导航，异常和拒绝不会放行", async () => {
  const added = vi.fn(() => false);
  const guards = new Set<NavigationGuard>([
    () => {
      guards.add(added);
      return true;
    },
  ]);
  await expect(checkNavigationGuards(guards)).resolves.toBe(true);
  expect(added).not.toHaveBeenCalled();
  await expect(checkNavigationGuards(guards)).resolves.toBe(false);
  await expect(
    checkNavigationGuards([
      () => {
        throw new Error("fixture");
      },
    ]),
  ).resolves.toBe(false);
});
