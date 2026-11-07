/**
 * 功能概述：固定 Cua 0.38 的私有 stdio 通道，只开放观察与基础输入，不转发任意 MCP。
 * 主要职责：CuaStdio.start 验证协议/发现；call 在最后 stdin.write 前执行宿主 gate；stop 杀并排空专属进程组。
 * 构造器只向可信调用方提供 spawn 依赖注入，供 CI 的 X11 代理路由；默认命令、环境和工具边界保持固定。
 * 代码库关系：GUI component 与真实 Linux probe 共用；应用 UID 无法取得此进程的 stdin 或环境。
 * 输入输出与副作用：有界 JSON 行、请求 deadline、真实响应 ID 配对；超时/断连拒绝未完成调用，不自动重发。
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const READ = new Set([
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_desktop_state",
]);
const INPUT = new Set([
  "click",
  "type_text",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
]);
export class CuaStdio {
  #spawn;
  // 可信代码依赖注入：Linux drain fixture 仅改子进程 DISPLAY；生产调用仍使用固定 spawn/env。
  constructor(spawnDriver = spawn) {
    this.#spawn = spawnDriver;
  }
  #child;
  #pending = new Map();
  #id = 0;
  #closed = false;
  #stop;
  diagnostics = "";
  async start() {
    if (this.#child || this.#closed) throw new Error("cua-already-started");
    const child = (this.#child = this.#spawn(
      "/opt/cua/cua-driver",
      ["mcp", "--direct"],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          // 固定源码 type_text 的 Tk fallback 会 Command::new("wish")；绝不让其以控制 UID 启动。
          PATH: "/opt/cua/helpers",
          HOME: "/home/tool",
          DISPLAY: ":99",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/kaguya-app/session/bus",
          XDG_RUNTIME_DIR: "/home/tool/runtime",
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
          DO_NOT_TRACK: "1",
          CUA_TELEMETRY: "0",
          DISABLE_AUTOUPDATER: "1",
          CUA_DRIVER_PERMISSION_MODE: "unrestricted",
          CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
        },
      },
    ));
    let buffer = Buffer.alloc(0);
    child.stderr.on("data", (data) => {
      this.diagnostics = (this.diagnostics + data.toString()).slice(-65536);
    });
    child.stdout.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 24 * 1024 ** 2) {
        this.#fail("cua-response-limit");
        return;
      }
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.jsonrpc !== "2.0") throw new Error("protocol");
          const waiting = this.#pending.get(message.id);
          if (waiting) {
            this.#pending.delete(message.id);
            clearTimeout(waiting.timer);
            if (message.error) waiting.reject(new Error("cua-rpc-error"));
            else waiting.resolve(message.result);
          }
        } catch {
          this.#fail("cua-invalid-response");
        }
      }
    });
    child.on("error", () => this.#fail("cua-spawn-failed"));
    child.stdin.on("error", () => this.#fail("cua-input-closed"));
    child.on("exit", () => this.#fail("cua-exited"));
    const initialized = await this.#rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kaguya-gui", version: "1" },
    });
    if (
      initialized.protocolVersion !== "2025-06-18" ||
      initialized.serverInfo?.version !== "0.38.0"
    )
      throw new Error("cua-version-mismatch");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const discovered = await this.#rpc("tools/list", {});
    for (const name of [...READ, ...INPUT]) {
      if (
        !discovered.tools?.some(
          (tool) => tool.name === name && tool.inputSchema,
        )
      )
        throw new Error("cua-discovery-mismatch");
    }
    return { initialized, discovered };
  }
  identity() {
    return {
      pid: this.#child?.pid,
      transport: "private-stdio",
      version: "0.38.0",
    };
  }
  call(name, args, gate) {
    if (!READ.has(name) && !INPUT.has(name)) throw new Error("cua-tool-denied");
    if (INPUT.has(name) && typeof gate !== "function")
      throw new Error("cua-input-gate-required");
    // 收尾只证明 core buttons 1–5；水平滚动会使用 6/7，尚未接入全 XI2 状态验证。
    if (name === "scroll" && !["up", "down"].includes(args.direction))
      throw new Error("cua-horizontal-scroll-denied");
    return this.#rpc("tools/call", { name, arguments: args }, gate);
  }
  #rpc(method, params, gate) {
    if (this.#closed || !this.#child) throw new Error("cua-closed");
    const id = ++this.#id;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (Buffer.byteLength(body) > 131072) throw new Error("cua-request-limit");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail("cua-request-unconfirmed"),
        30000,
      );
      this.#pending.set(id, { resolve, reject, timer });
      try {
        // gate 和 write 间没有 await：控制切换不能在最终检查后插入新的发送。
        gate?.();
        if (this.#closed) throw new Error("cua-closed");
        this.#child.stdin.write(body);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  #fail(reason) {
    this.#closed = true;
    for (const waiting of this.#pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    this.#pending.clear();
    // 断连或超时立即封闭派发；确认进程组清空由 stop 的调用者等待。
    if (this.#child?.pid) {
      try {
        process.kill(-this.#child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") this.diagnostics += "\ngroup-kill-failed";
      }
    }
  }
  stop() {
    return (this.#stop ??= (async () => {
      this.#fail("cua-stopped");
      const pid = this.#child?.pid;
      if (!pid) return;
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") return;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error("cua-drain-unconfirmed");
        await delay(10);
      }
    })());
  }
}
