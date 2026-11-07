/**
 * 功能概述：可信 Chromium owner 的私有 pipe CDP 连接；不开放 TCP/Unix 调试端点。
 * 主要职责：按 connection/session/id 保留请求到真实浏览器回执；断连或错误保持 unknown，
 * drain 不能用 detach、超时或客户端 promise 取消冒充。所有调用方输入只在受信边界发送。
 * 代码库关系：browser component 固定选择 CDP 方法；Playwright 包仅定位固定 Chromium。
 * 输入输出与副作用：启动隔离浏览器子进程，profile 留在 /private；只有整个服务关闭才终止 owner。
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export class ChromiumConnection extends EventEmitter {
  constructor(executable, profile, { spawnBrowser = spawn } = {}) {
    super();
    this.id = randomUUID();
    this.nextId = 0;
    this.pending = new Map();
    this.uncertain = new Set();
    this.lost = false;
    this.diagnostics = "";
    this.buffer = Buffer.alloc(0);
    this.process = spawnBrowser(
      executable,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--user-data-dir=" + profile,
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
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        env: {
          HOME: process.env.HOME,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
      },
    );
    this.process.stderr.on("data", (chunk) => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-262144);
    });
    this.process.once("error", () => {
      this.spawnFailed = true;
      this.disconnected();
    });
    this.process.once("exit", () => this.disconnected());
    this.process.stdio[3].on("error", () => this.disconnected());
    this.process.stdio[4].on("error", () => this.disconnected());
    this.process.stdio[4].on("end", () => this.disconnected());
    this.process.stdio[4].on("data", (chunk) => this.receive(chunk));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 24 * 1024 * 1024) return this.disconnected();
    let end;
    while ((end = this.buffer.indexOf(0)) !== -1) {
      const raw = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.disconnected();
        return;
      }
      if (message.id !== undefined) {
        const key = `${message.sessionId ?? ""}:${message.id}`;
        const request = this.pending.get(key);
        if (!request) {
          this.disconnected();
          return;
        }
        if (message.error) {
          this.uncertain.add(key);
          request.reject(
            new Error("chromium-protocol-unconfirmed:" + message.error.code),
          );
        } else {
          this.pending.delete(key);
          request.resolve(message.result ?? {});
        }
      } else {
        this.emit("event", message);
      }
    }
  }

  send(method, params = {}, { sessionId, permit } = {}) {
    if (this.lost || this.uncertain.size)
      throw new Error("chromium-connection-unconfirmed");
    const id = ++this.nextId;
    const key = `${sessionId ?? ""}:${id}`;
    let resolve, reject;
    const response = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // 独立记录真实响应；调用方提前停止等待不会删除这条归属。
    void response.catch(() => {});
    const payload = Buffer.from(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }) + "\0",
    );
    if (payload.length > 4 * 1024 * 1024)
      throw new Error("chromium-request-too-large");
    permit?.check();
    this.pending.set(key, { resolve, reject, response, method, sessionId });
    try {
      // 最后检查后无 await。只有这个入口可以向浏览器 pipe 写入命令。
      this.process.stdio[3].write(payload, (error) => {
        if (error) this.disconnected();
      });
    } catch {
      this.disconnected();
    }
    return response;
  }

  disconnected() {
    if (this.lost) return;
    this.lost = true;
    for (const [key, entry] of this.pending) {
      this.uncertain.add(key);
      entry.reject(new Error("chromium-connection-lost:" + this.diagnostics));
    }
    this.emit("disconnected");
  }

  async drain() {
    const pending = [...this.pending.values()];
    await Promise.allSettled(pending.map((entry) => entry.response));
    if (this.lost || this.uncertain.size || this.pending.size)
      throw new Error("chromium-drain-unconfirmed");
    return true;
  }

  async close() {
    if (
      this.spawnFailed ||
      !this.process.pid ||
      this.process.exitCode !== null ||
      this.process.signalCode !== null
    )
      return;
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
