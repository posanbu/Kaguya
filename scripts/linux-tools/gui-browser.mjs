/**
 * 功能概述：应用 UID 桌面菜单的固定 Chromium 启动器，使用持久应用 HOME 保存 profile。
 * 主要职责：从固定安装解析 Chromium 路径，以默认 sandbox 启动空白页；不接受 argv/URL/CDP 参数。
 * 代码库关系：gui-menu-production.xml 调用；GUI 交互继续经过 GuiComponent/Cua，launcher 无控制权限。
 * 输入输出与副作用：仅 UID1001；浏览器退出后返回状态，SIGTERM 回收直接子进程。
 */
import { spawn } from "node:child_process";
import { chromium } from "/opt/kaguya-browser/node_modules/playwright/index.mjs";
if (process.getuid() !== 1001) throw new Error("gui-app-uid-required");
const browser = spawn(
  chromium.executablePath(),
  [
    "--user-data-dir=/private/app/chromium-profile",
    "--force-renderer-accessibility",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--password-store=basic",
    "about:blank",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, HOME: "/private/app", DISPLAY: ":99" },
  },
);
browser.once("error", () => {
  process.exitCode = 1;
});
browser.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
process.once("SIGTERM", () => {
  browser.kill("SIGTERM");
});
