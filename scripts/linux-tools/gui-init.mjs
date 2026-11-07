/**
 * 功能概述：隔离 GUI 的可信启动入口，仅以 UID1000 启动固定 Xvfb。
 * 主要职责：固定 1280×800 显示与本容器 Unix socket；宿主随后以 UID1001 启动 app-session。
 * 代码库关系：Dockerfile.gui 安装此文件，ToolService 注册 GuiComponent；不启动应用、session bus 或任意 argv。
 * 输入输出与副作用：显示服务退出即结束入口；SIGTERM 关闭显示，正常 handoff 不调用此关闭路径。
 */
import { spawn } from "node:child_process";
import { startService } from "./service.mjs";
import { GuiComponent } from "./gui.mjs";
if (process.getuid() !== 1000) throw new Error("gui-control-uid-required");
const display = spawn(
  "/usr/bin/Xvfb",
  [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac", "-noreset"],
  { stdio: "inherit" },
);
display.once("error", () => process.exit(1));
display.once("exit", (code) => process.exit(code || 1));
const control = await startService({ components: [new GuiComponent()] });
process.once("SIGTERM", () => {
  void control.close().finally(() => display.kill("SIGTERM"));
});
