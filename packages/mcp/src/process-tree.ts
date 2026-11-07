/**
 * 功能概述：回收受管stdio组前重新核对当前成员身份，区分gone、owned和unconfirmed。
 * verifyOwnedGroup在同一deadline内执行S1→ps→S2；成员变化时丢弃旧身份结果并重新全验。
 * signalOwnedGroup每次发信号前核验；ESRCH仅在整组确认消失后作为正常退出。
 * stdio.ts消费脱敏观察；原始环境、命令输出和owner标记只用于内存判断，不进入错误。
 * 查询快照与信号不是原子操作；稳定错误身份/权限失败继续拒绝，历史记录不授权信号。
 * runTreeHelper限制Windows辅助进程的等待；本轮保留其既有行为。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { McpError, cleanupCause } from "./config.js";
const exec = promisify(execFile);
export type GroupIdentity =
  | { state: "gone" | "owned" }
  | { state: "unconfirmed"; reason: string; cause?: Error };
export type GroupObservation = {
  stage: string;
  reason?: string | undefined;
  count?: number | undefined;
  nextCount?: number | undefined;
  exitCode?: number | undefined;
  errno?: string | undefined;
  atMs: number;
};
type QueryResult = {
  ok: boolean;
  stdout: string;
  exitCode?: number | undefined;
  errno?: string | undefined;
};
export type GroupInspection = {
  observe?: (event: GroupObservation) => void;
  /** 内部测试barrier；生产调用不提供，不能从MCP配置传入。 */
  afterSnapshot?: (pids: readonly number[], deadline: number) => Promise<void>;
  query?: typeof queryGroup;
};
function observeGroup(
  options: GroupInspection,
  event: Omit<GroupObservation, "atMs">,
) {
  options.observe?.({ ...event, atMs: performance.now() });
}
function unknown(reason: string, cause?: Error): GroupIdentity {
  return { state: "unconfirmed", reason, ...(cause ? { cause } : {}) };
}
function remaining(deadline: number) {
  return deadline - Date.now();
}
/** 仅ESRCH确认整组消失；EPERM等错误不等同于退出。 */
function presence(
  groupId: number,
  deadline: number,
  options: GroupInspection,
): GroupIdentity {
  if (remaining(deadline) <= 0) return unknown("deadline");
  try {
    process.kill(-groupId, 0);
    return { state: "owned" };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    observeGroup(options, {
      stage: "group-probe",
      reason: errno === "ESRCH" ? "gone" : "probe-error",
      errno: errno === "ESRCH" || errno === "EPERM" ? errno : "OTHER",
    });
    return errno === "ESRCH"
      ? { state: "gone" }
      : unknown("probe-error", cleanupCause(error));
  }
}
/** 查询输出不外传到错误；每次exec都重新计算剩余时间。 */
async function queryGroup(
  kind: "pgrep" | "ps",
  ids: readonly number[],
  deadline: number,
): Promise<QueryResult> {
  const budget = remaining(deadline);
  if (budget <= 0) return { ok: false, stdout: "", errno: "DEADLINE" };
  try {
    const result = await exec(
      kind === "pgrep" ? "/usr/bin/pgrep" : "/bin/ps",
      kind === "pgrep"
        ? ["-g", String(ids[0])]
        : ["eww", "-p", ids.join(","), "-o", "pid=,pgid=,command="],
      { timeout: Math.min(1000, budget), maxBuffer: 1048576 },
    );
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    const failure = error as {
      stdout?: unknown;
      code?: unknown;
      killed?: boolean;
    };
    return {
      ok: false,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      ...(typeof failure.code === "number" ? { exitCode: failure.code } : {}),
      errno: failure.killed
        ? "TIMEOUT"
        : ["EPERM", "EACCES", "ENOENT", "ENOBUFS"].includes(
              String(failure.code),
            )
          ? String(failure.code)
          : "EXEC_ERROR",
    };
  }
}
function members(result: QueryResult): number[] | undefined {
  if (!result.ok)
    return result.exitCode === 1 && !result.stdout.trim() ? [] : undefined;
  const values = result.stdout.trim().split(/\s+/);
  if (!values.length || values.some((value) => !/^\d+$/.test(value)))
    return undefined;
  const pids = values.map(Number).sort((a, b) => a - b);
  return pids.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
    new Set(pids).size === pids.length
    ? pids
    : undefined;
}
function same(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((pid, index) => pid === b[index]);
}
export async function verifyOwnedGroup(
  groupId: number,
  ownerTag: string,
  deadline: number,
  options: GroupInspection = {},
): Promise<GroupIdentity> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0)
    return unknown("invalid-group");
  const query = options.query ?? queryGroup;
  while (remaining(deadline) > 0) {
    const s1Result = await query("pgrep", [groupId], deadline);
    const s1 = members(s1Result);
    observeGroup(options, {
      stage: "pgrep-s1",
      reason:
        s1 === undefined ? "exec-error" : !s1.length ? "empty" : "members",
      count: s1?.length,
      exitCode: s1Result.exitCode,
      errno: s1Result.errno,
    });
    const initialPresence = presence(groupId, deadline, options);
    if (initialPresence.state !== "owned") return initialPresence;
    if (s1 === undefined || !s1.length)
      return unknown(
        s1 === undefined ? "pgrep-exec-error" : "pgrep-empty-live",
      );
    await options.afterSnapshot?.(s1, deadline);
    if (remaining(deadline) <= 0) return unknown("deadline");
    const detail = await query("ps", s1, deadline);
    observeGroup(options, {
      stage: "ps",
      reason: detail.ok ? "read" : "exec-error",
      exitCode: detail.exitCode,
      errno: detail.errno,
    });
    // ps失败也必须看S2：退出成员可能使ps非0，不能直接误判稳定身份失败。
    if (remaining(deadline) <= 0) return unknown("deadline");
    const s2Result = await query("pgrep", [groupId], deadline);
    const s2 = members(s2Result);
    observeGroup(options, {
      stage: "pgrep-s2",
      reason:
        s2 === undefined ? "exec-error" : !s2.length ? "empty" : "members",
      count: s2?.length,
      exitCode: s2Result.exitCode,
      errno: s2Result.errno,
    });
    const currentPresence = presence(groupId, deadline, options);
    if (currentPresence.state !== "owned") return currentPresence;
    if (s2 === undefined) return unknown("pgrep-exec-error");
    if (!same(s1, s2)) {
      observeGroup(options, {
        stage: "membership",
        reason: "changed",
        count: s1.length,
        nextCount: s2.length,
      });
      continue;
    }
    if (!detail.ok) return unknown("identity-read-failed");
    const rows = detail.stdout
      .trim()
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line));
    if (
      rows.some((row) => !row) ||
      !same(
        s2,
        rows.map((row) => Number(row![1])).sort((a, b) => a - b),
      )
    )
      return unknown("identity-rows-unconfirmed");
    if (rows.some((row) => Number(row![2]) !== groupId))
      return unknown("group-mismatch");
    if (
      rows.some(
        (row) =>
          !row![3]!.split(/\s+/).includes(`KAGUYA_MCP_OWNER=${ownerTag}`),
      )
    ) {
      observeGroup(options, { stage: "identity", reason: "tag-mismatch" });
      return unknown("tag-mismatch");
    }
    observeGroup(options, {
      stage: "identity",
      reason: "owned",
      count: s2.length,
    });
    return { state: "owned" };
  }
  return unknown("deadline");
}
export async function signalOwnedGroup(
  groupId: number,
  ownerTag: string,
  signal: NodeJS.Signals,
  deadline: number,
  verify: typeof verifyOwnedGroup = verifyOwnedGroup,
  options: GroupInspection = {},
): Promise<"gone" | "signalled"> {
  if (remaining(deadline) <= 0)
    throw new McpError("mcp-stdio-group-identity-unconfirmed", {
      details: { stage: "before-verify", reason: "deadline" },
    });
  const identity = await verify(groupId, ownerTag, deadline, options);
  if (identity.state === "gone") return "gone";
  if (identity.state === "unconfirmed")
    throw new McpError("mcp-stdio-group-identity-unconfirmed", {
      cause: identity.cause,
      details: { stage: "verify", reason: identity.reason },
    });
  if (remaining(deadline) <= 0)
    throw new McpError("mcp-stdio-group-identity-unconfirmed", {
      details: { stage: "before-signal", reason: "deadline" },
    });
  try {
    process.kill(-groupId, signal);
    observeGroup(options, { stage: "signal", reason: signal });
    return "signalled";
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    observeGroup(options, {
      stage: "signal",
      reason: signal,
      errno: errno === "ESRCH" || errno === "EPERM" ? errno : "OTHER",
    });
    if (
      errno === "ESRCH" &&
      presence(groupId, deadline, options).state === "gone"
    )
      return "gone";
    throw new McpError("mcp-stdio-signal-unconfirmed", {
      cause: cleanupCause(error),
      details: { stage: "signal", signal },
    });
  }
}
export async function runTreeHelper(
  command: string,
  args: string[],
  deadline: number,
  onStarted?: (pid: number) => void,
): Promise<void> {
  if (deadline - Date.now() <= 0)
    throw new McpError("mcp-tree-helper-unconfirmed");
  const child = spawn(command, args, {
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        if (child.pid) onStarted?.(child.pid);
      });
      child.once("error", () => reject(new McpError("mcp-tree-helper-failed")));
      child.once("exit", (code) =>
        timedOut || code !== 0
          ? reject(new McpError("mcp-tree-helper-unconfirmed"))
          : resolve(),
      );
      timer = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
          reapTimer = setTimeout(
            () => reject(new McpError("mcp-tree-helper-unconfirmed")),
            200,
          );
        },
        Math.max(1, deadline - Date.now() - 250),
      );
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(reapTimer);
    if (child.pid && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
