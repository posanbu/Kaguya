/**
 * 功能概述：用一个受宿主管理的子进程实现公开 MCP Transport，协议探测始终复用本进程。
 * SingleProcessStdio.start 以 shell=false 和明确环境启动；send 写入有界 JSON-RPC 行；
 * close在原5秒deadline内核验当前进程组并回收；记录EOF、wait250结果、根exit及脱敏核验阶段。
 * 已spawn进程先独立回收再等待ownership写入；未spawn的closeRequested阻止晚启动。
 * cleanupDiagnostics供宿主测试保留首错；错误cause不包含命令、环境输出或owner标记。
 * MCP Client 使用公开 Transport/parseJSONRPCMessage，不访问 SDK 私有字段，也不创建探测兄弟进程。
 * stdout 只作协议；stderr 被持续排空但不进入日志，失败只报告固定错误码。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { writeSensitiveJson } from "@kaguya/config";
import { McpError, cleanupCause } from "./config.js";
import {
  verifyOwnedGroup,
  runTreeHelper,
  signalOwnedGroup,
  type GroupObservation,
} from "./process-tree.js";

export class SingleProcessStdio implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing: Promise<void> | undefined;
  private buffer = Buffer.alloc(0);
  private exited: Promise<void> = Promise.resolve();
  private ownershipFile: string | undefined;
  private ownershipRecorded = false;
  private treeReaped = false;
  private ownershipRoot: string | undefined;
  private ownRoot = false;
  private groupId: number | undefined;
  private starting: Promise<void> | undefined;
  private closeRequested = false;
  private readonly ownerTag = randomUUID();
  private rootExitedAtMs: number | null = null;
  private rootExitSignal: NodeJS.Signals | null = null;
  private cleanupState = {
    startedAtMs: 0,
    eofAtMs: null as number | null,
    wait250Exited: null as boolean | null,
    recordRetained: false,
  };
  private cleanupEvents: GroupObservation[] = [];
  cleanupDiagnostics() {
    return {
      ...this.cleanupState,
      recordRetained: this.ownershipRecorded,
      startupPending: Boolean(this.starting),
      treeReaped: this.treeReaped,
      rootExitedAtMs: this.rootExitedAtMs,
      rootExitSignal: this.rootExitSignal,
      observations: this.cleanupEvents.map((event) => ({ ...event })),
    };
  }
  constructor(
    private readonly config: {
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      maxBytes: number;
      ownershipDirectory?: string;
      /** 宿主资源准备 barrier；不属于可由 MCP/模型提交的配置。 */
      beforeSpawn?: () => Promise<void>;
      /** 内部持久化依赖，仅用于精确控制已spawn的写入阶段；不进入MCP配置。 */
      writeOwnership?: typeof writeSensitiveJson;
      verifyGroup?: typeof verifyOwnedGroup;
    },
  ) {}
  get pid() {
    return this.child?.pid ?? null;
  }
  // SDK 以公开的 stdio 特征选择原连接探测；此 transport 不暴露可克隆的启动私有字段。
  get stderr() {
    return this.child?.stderr ?? null;
  }
  start(): Promise<void> {
    if (this.child || this.closing || this.closeRequested || this.starting)
      throw new McpError("mcp-stdio-already-started");
    return (this.starting = this.startOwned().finally(() => {
      this.starting = undefined;
    }));
  }
  private async startOwned() {
    this.ownershipRoot =
      this.config.ownershipDirectory ??
      (await mkdtemp(join(tmpdir(), "kaguya-mcp-owned-")));
    this.ownRoot = this.config.ownershipDirectory === undefined;
    await mkdir(this.ownershipRoot, { recursive: true, mode: 0o700 });
    this.ownershipFile = join(this.ownershipRoot, `${randomUUID()}.json`);
    await this.config.beforeSpawn?.();
    if (this.closeRequested) throw new McpError("mcp-stdio-start-interrupted");
    const child = spawn(this.config.command, this.config.args, {
      env: { ...this.config.env, KAGUYA_MCP_OWNER: this.ownerTag },
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.groupId = child.pid;
    this.exited = new Promise((resolve) =>
      child.once("exit", (_code, signal) => {
        this.rootExitedAtMs = performance.now();
        this.rootExitSignal = signal;
        resolve();
      }),
    );
    child.once("close", () => this.onclose?.());
    child.on("error", () => this.onerror?.(new McpError("mcp-stdio-failed")));
    child.stdin.on("error", () =>
      this.onerror?.(new McpError("mcp-stdio-write-failed")),
    );
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let boundary: number;
      while ((boundary = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, boundary);
        this.buffer = this.buffer.subarray(boundary + 1);
        if (line.byteLength > this.config.maxBytes) {
          this.fail();
          return;
        }
        try {
          this.onmessage?.(
            parseJSONRPCMessage(JSON.parse(line.toString("utf8"))),
          );
        } catch {
          this.fail();
          return;
        }
      }
      if (this.buffer.byteLength > this.config.maxBytes) this.fail();
    });
    try {
      await once(child, "spawn");
      await (this.config.writeOwnership ?? writeSensitiveJson)(
        this.ownershipFile,
        {
          ownerPid: process.pid,
          pid: child.pid,
          processGroup: process.platform === "win32" ? null : child.pid,
          platform: process.platform,
          startedAt: new Date().toISOString(),
          state: "owned",
          ownerTag: this.ownerTag,
        },
      );
      this.ownershipRecorded = true;
      if (this.closeRequested)
        throw new McpError("mcp-stdio-start-interrupted");
    } catch {
      throw new McpError("mcp-stdio-start-failed");
    }
  }
  private fail() {
    this.onerror?.(new McpError("mcp-stdio-invalid-frame"));
    void this.close().catch(() => undefined);
  }
  async send(message: JSONRPCMessage) {
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > this.config.maxBytes)
      throw new McpError("mcp-request-budget");
    const child = this.child;
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.stdin.destroyed
    )
      throw new McpError("mcp-stdio-unavailable");
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(line, (error) =>
        error ? reject(new McpError("mcp-stdio-write-failed")) : resolve(),
      ),
    );
  }
  close() {
    this.closeRequested = true;
    return (this.closing ??= (async () => {
      const deadline = Date.now() + 5000;
      this.cleanupState = {
        startedAtMs: performance.now(),
        eofAtMs: null,
        wait250Exited: null,
        recordRetained: this.ownershipRecorded,
      };
      this.cleanupEvents = [];
      const observe = (event: GroupObservation) => {
        if (this.cleanupEvents.length === 64) this.cleanupEvents.shift();
        this.cleanupEvents.push(event);
      };
      const starting = this.starting;
      const settleStarting = async () => {
        if (!starting) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            starting.catch(() => undefined),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new McpError("mcp-stdio-start-settlement-unconfirmed", {
                      details: {
                        ...this.cleanupState,
                        recordRetained: this.ownershipRecorded,
                        startupPending: Boolean(this.starting),
                        treeReaped: this.treeReaped,
                        rootExitedAtMs: this.rootExitedAtMs,
                        stage: "start-settlement",
                        reason: "deadline",
                      },
                    }),
                  ),
                Math.max(0, deadline - Date.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      // 已spawn时先回收真实child，不让持久化阻挡；未spawn时closeRequested阻止晚启动。
      if (!this.child) await settleStarting();
      const child = this.child;
      if (!child) {
        if (this.ownRoot && this.ownershipRoot)
          await rm(this.ownershipRoot, { recursive: true, force: true });
        return;
      }
      const wait = async (milliseconds: number) => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        const budget = Math.min(milliseconds, deadline - Date.now());
        if (budget <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.exited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), budget);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        if (!this.treeReaped) {
          if (process.platform === "win32") {
            // Windows 没有 POSIX 进程组；仅在根进程尚在时用系统 taskkill 回收正常派生树。
            if (
              child.pid &&
              child.exitCode === null &&
              child.signalCode === null
            ) {
              await runTreeHelper(
                join(
                  process.env.SystemRoot ??
                    process.env.SYSTEMROOT ??
                    "C:\\Windows",
                  "System32",
                  "taskkill.exe",
                ),
                ["/PID", String(child.pid), "/T", "/F"],
                deadline,
              );
              if (!(await wait(Math.max(1, deadline - Date.now()))))
                throw new McpError("mcp-stdio-reap-failed");
            } else if (child.pid)
              throw new McpError("mcp-stdio-tree-unconfirmed");
          } else {
            this.cleanupState.eofAtMs = performance.now();
            child.stdin.end();
            this.cleanupState.wait250Exited = await wait(250);
            const alive = () => {
              if (deadline - Date.now() <= 0)
                throw new McpError("mcp-stdio-group-identity-unconfirmed", {
                  details: { stage: "drain", reason: "deadline" },
                });
              if (!this.groupId) return false;
              try {
                process.kill(-this.groupId, 0);
                return true;
              } catch (error) {
                if (
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "ESRCH"
                ) {
                  observe({
                    stage: "drain-probe",
                    reason: "gone",
                    errno: "ESRCH",
                    atMs: performance.now(),
                  });
                  return false;
                }
                observe({
                  stage: "drain-probe",
                  reason: "probe-error",
                  errno:
                    (error as NodeJS.ErrnoException).code === "EPERM"
                      ? "EPERM"
                      : "OTHER",
                  atMs: performance.now(),
                });
                throw error;
              }
            };
            const signal = (value: NodeJS.Signals) =>
              signalOwnedGroup(
                this.groupId!,
                this.ownerTag,
                value,
                deadline,
                this.config.verifyGroup ?? verifyOwnedGroup,
                { observe },
              );
            const drain = async (milliseconds: number) => {
              const until = Math.min(deadline, Date.now() + milliseconds);
              // 先消费直接子进程的exit事件，再查询剩余组；占用同一drain阶段预算。
              // EPERM仍原样拒绝，不把尚未reap时的查询失败解释为gone。
              const rootReaped = await wait(Math.max(0, until - Date.now()));
              observe({
                stage: "root-reap",
                reason: rootReaped ? "exited" : "pending",
                atMs: performance.now(),
              });
              let probeFailure: unknown;
              while (Date.now() < until) {
                try {
                  if (!alive()) return true;
                  probeFailure = undefined;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "EPERM")
                    throw error;
                  // 只读等待后续明确退出，不以EPERM授权任何信号或删除记录。
                  probeFailure = error;
                }
                await new Promise((resolve) =>
                  setTimeout(
                    resolve,
                    Math.min(20, Math.max(0, until - Date.now())),
                  ),
                );
              }
              if (probeFailure)
                throw new McpError("mcp-stdio-group-identity-unconfirmed", {
                  cause: cleanupCause(probeFailure),
                  details: { stage: "drain-probe", reason: "probe-error" },
                });
              return false;
            };
            await signal("SIGTERM");
            if (!(await drain(1000))) {
              await signal("SIGKILL");
              if (!(await drain(2000)))
                throw new McpError("mcp-stdio-tree-unconfirmed");
            }
            if (
              child.pid &&
              child.exitCode === null &&
              child.signalCode === null &&
              !(await wait(2000))
            )
              throw new McpError("mcp-stdio-reap-failed");
          }
          this.treeReaped = true;
        }
        // 即使写入永远未结算，走到这里时真实进程树已经独立回收；保留未知记录供后续关闭。
        await settleStarting();
        if (this.ownershipFile) await rm(this.ownershipFile, { force: true });
        this.ownershipRecorded = false;
        this.cleanupState.recordRetained = false;
        if (this.ownRoot && this.ownershipRoot)
          await rm(this.ownershipRoot, { recursive: true, force: true });
      } catch (error) {
        const { observations, ...details } = this.cleanupDiagnostics();
        throw new McpError(
          error instanceof McpError
            ? error.code
            : "mcp-stdio-cleanup-unconfirmed",
          {
            details,
            cause: new AggregateError(
              [
                cleanupCause(error),
                ...observations.map(
                  (event) =>
                    new McpError("mcp-stdio-cleanup-observation", {
                      details: Object.fromEntries(
                        Object.entries(event).filter(
                          (entry): entry is [string, string | number] =>
                            entry[1] !== undefined,
                        ),
                      ),
                    }),
                ),
              ],
              "mcp-stdio-cleanup-causes",
            ),
          },
        );
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        this.buffer = Buffer.alloc(0);
      }
    })().catch((error) => {
      this.closing = undefined;
      throw error;
    }));
  }
}
