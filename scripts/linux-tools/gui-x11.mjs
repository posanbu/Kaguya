/**
 * 功能概述：可信 X11 状态 helper 的有界调用入口，统一 GUI component 与真实中断验收。
 * 主要职责：x11State 只启动固定 Python/脚本，限制输入输出；超时先杀 helper 并等 close，再报告未确认。
 * 代码库关系：gui-x11.py 校验 UID 和固定 display；调用者保存 baseline 并在 Driver 退出后请求 reset。
 * 输入输出与副作用：不接受 argv/path/display；不会把进程超时当输入排空成功，不自动重试。
 */
import { spawn } from "node:child_process";
export function x11State(request) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 262144) throw new Error("x11-request-limit");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["/opt/kaguya-tools/gui-x11.py"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      size = 0,
      failure;
    const fail = (reason) => {
      failure ??= new Error(reason);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail("x11-state-timeout"), 5000);
    child.stdout.on("data", (data) => {
      size += data.length;
      if (size > 262144) fail("x11-response-limit");
      else stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-8192);
    });
    child.on("error", () => fail("x11-state-unavailable"));
    child.stdin.on("error", () => fail("x11-state-write-failed"));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(
          failure ??
            new Error("x11-state-unconfirmed", {
              cause: { code, signal, stderr },
            }),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("x11-state-invalid"));
      }
    });
    child.stdin.end(input);
  });
}
