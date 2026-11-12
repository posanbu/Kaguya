/**
 * 功能概述：以真实临时文件和虚构 OneBot frame 验证群聊采集的持久化、覆盖与导出边界。
 * 主要职责：fixture 注入可控业务时钟并等待 start/settle/stop；测试自身消息、撤回、CQ/媒体、
 * 过滤和身份、重连/重启/心跳/异常 gap、队列背压、磁盘部分写入、独占锁及一致性伪名导出。
 * 代码库关系：直接驱动 NapCatCapture/CaptureJournal 和 freezeCapture；Python 子进程验收导出协议。
 * 输入输出与副作用：只在随机临时目录读写；写入竞态通过 Promise barrier 控制，无固定 sleep。
 * 所有 fixture 在失败路径释放 barrier 并逐项有界清理；stop/子进程close未确认时保留目录。
 * 导出验收保留三个 Python 阶段各15秒上限，外层另计采集/导出与文件核对预算，失败报告当前阶段。
 */
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rm,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, onTestFailed, vi } from "vitest";
import {
  CaptureJournal,
  NapCatCapture,
  writeCaptureBytes,
  type CaptureRecord,
} from "./napcat-capture.js";
import { freezeCapture } from "./napcat-capture-export.js";

const epoch = Date.parse("2026-01-01T00:00:00Z");
type CaptureOwner = {
  root: string;
  retained: boolean;
  captures: Set<NapCatCapture>;
};
type Cleanup = {
  phase: string;
  budgetMs: number;
  owner?: CaptureOwner;
  run: () => Promise<unknown>;
};
type PythonChild = {
  child: ChildProcess;
  closed: Promise<void>;
  didClose: boolean;
  owner: CaptureOwner;
};
const cleanup: Cleanup[] = [];
const pythonChildren = new Set<PythonChild>();
const pythonStageTimeout = 15_000;
const childCloseTimeout = 5_000;
const captureStopTimeout = 8_000;
const filesCleanupTimeout = 5_000;
// 三个 Python 阶段各15秒执行+5秒close，采集/导出和文件核对各15秒。
const exportTestTimeout =
  2 * 15_000 + 3 * (pythonStageTimeout + childCloseTimeout);
// 至多一个Python、两个同目录capture、两次barrier释放和文件删除，另留2秒hook调度余量。
const cleanupHookTimeout =
  childCloseTimeout +
  2 * captureStopTimeout +
  filesCleanupTimeout +
  2 * 1_000 +
  2_000;
async function bounded<T>(
  phase: string,
  budgetMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${phase} unconfirmed after ${budgetMs}ms`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function ownDirectory(root: string): CaptureOwner {
  const owner: CaptureOwner = { root, retained: false, captures: new Set() };
  cleanup.push({
    phase: "capture directory removal",
    budgetMs: filesCleanupTimeout,
    owner,
    run: async () => {
      if (owner.retained || owner.captures.size) {
        console.error(
          `Capture fixture retained at ${root}; cleanup unconfirmed or test interrupted`,
        );
        return;
      }
      await rm(root, { recursive: true, force: true });
    },
  });
  return owner;
}
function ownCapture(owner: CaptureOwner, capture: NapCatCapture) {
  owner.captures.add(capture);
  cleanup.push({
    phase: "capture stop",
    budgetMs: captureStopTimeout,
    owner,
    run: async () => {
      await capture.stop();
      owner.captures.delete(capture);
    },
  });
}
afterEach(async () => {
  const errors: unknown[] = [];
  // AbortError/callback不是close。先要求实际close；未确认时保留该child的所有输入输出。
  for (const record of [...pythonChildren]) {
    try {
      if (!record.didClose) record.child.kill("SIGKILL");
      await bounded(
        "Python child close",
        childCloseTimeout,
        () => record.closed,
      );
      pythonChildren.delete(record);
    } catch (error) {
      record.owner.retained = true;
      errors.push(error);
    }
  }
  for (const task of cleanup.splice(0).reverse()) {
    try {
      await bounded(task.phase, task.budgetMs, task.run);
    } catch (error) {
      if (task.owner) task.owner.retained = true;
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Capture fixture cleanup failed");
}, cleanupHookTimeout);

async function fixture(
  extra: Partial<ConstructorParameters<typeof NapCatCapture>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-capture-"));
  let seconds = 0;
  const errors = vi.fn();
  const options = {
    captureEnabled: true,
    captureGroups: ["200"],
    directory: join(root, "journal"),
    adapterId: "qq",
    selfId: "100",
    now: () => new Date(epoch + seconds * 1000),
    onError: errors,
    ...extra,
  };
  const capture = new NapCatCapture(options);
  const owner = ownDirectory(root);
  ownCapture(owner, capture);
  await capture.start();
  expect(capture.status().state).toBe("waiting_for_identity");
  capture.connected("g1");
  return {
    root,
    owner,
    own: (other: NapCatCapture) => ownCapture(owner, other),
    capture,
    options,
    errors,
    at: (value: number) => {
      seconds = value;
    },
    records: async () =>
      (await readFile(join(options.directory, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CaptureRecord),
  };
}
function message(
  messageId = 1,
  userId = 300,
  extra: Record<string, unknown> = {},
) {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 100,
    group_id: 200,
    message_id: messageId,
    user_id: userId,
    time: epoch / 1000,
    sender: { nickname: "fictional member" },
    message: "fictional body",
    ...extra,
  };
}
function heartbeat() {
  return {
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    self_id: 100,
    status: { good: true, online: true },
  };
}

it("treats unhealthy heartbeats and lifecycle disable as gaps instead of proof of coverage", async () => {
  const f = await fixture();
  f.capture.receive(message(), "g1");
  f.at(1);
  f.capture.receive(
    { ...heartbeat(), status: { online: false, good: false } },
    "g1",
  );
  expect(f.capture.status().state).toBe("waiting_for_identity");
  f.at(2);
  f.capture.receive(heartbeat(), "g1");
  f.at(3);
  f.capture.receive(
    {
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: "disable",
      self_id: 100,
    },
    "g1",
  );
  f.at(4);
  f.capture.checkpoint();
  await f.capture.settle();
  expect(
    (await f.records()).filter((r) => r.status === "gap").length,
  ).toBeGreaterThanOrEqual(2);
});

it("marks a clock rollback as a gap and keeps receipt watermarks monotonic", async () => {
  const f = await fixture();
  f.at(20);
  f.capture.receive(heartbeat(), "g1");
  f.at(10);
  f.capture.receive(message(), "g1");
  await f.capture.settle();
  const records = await f.records();
  expect(f.capture.status().counters.clockRollback).toBeGreaterThan(0);
  expect(
    records.some((r) => r.status === "gap" && r.reason === "clock_rollback"),
  ).toBe(true);
  expect(
    records.every(
      (r, i) =>
        i === 0 ||
        Date.parse(r.receivedAt) >= Date.parse(records[i - 1]!.receivedAt),
    ),
  ).toBe(true);
});

it("refuses a modified committed prefix instead of silently rebuilding a valid history", async () => {
  const f = await fixture();
  f.capture.receive(message(), "g1");
  await f.capture.stop();
  const path = join(f.options.directory, "events.jsonl");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace("fictional body", "tampered body"),
  );
  await f.capture.start();
  expect(f.capture.status().state).toBe("failed");
  expect(f.errors).toHaveBeenCalledOnce();
});

it("captures self/sent events, recalls, addressing and media without raw frames or credentials", async () => {
  const f = await fixture();
  f.capture.receive(
    message(1, 100, {
      post_type: "message_sent",
      message: [
        { type: "text", data: { text: "hello " } },
        { type: "at", data: { qq: "300" } },
        { type: "reply", data: { id: "99" } },
        { type: "image", data: { url: "PRIVATE_MEDIA_URL" } },
      ],
      access_token: "PRIVATE_TOKEN",
    }),
    "g1",
  );
  f.at(1);
  f.capture.receive(
    {
      self_id: 100,
      group_id: 200,
      post_type: "notice",
      notice_type: "group_recall",
      message_id: 1,
    },
    "g1",
  );
  f.at(2);
  f.capture.receive(
    message(2, 300, {
      message: "hi[CQ:record,file=SECRET_AUDIO_FILE][CQ:at,qq=100]",
    }),
    "g1",
  );
  f.at(3);
  f.capture.checkpoint();
  await f.capture.settle();
  const records = await f.records();
  expect(records.filter((r) => r.eventType === "message")).toHaveLength(2);
  expect(records[0]).toMatchObject({
    senderId: "100",
    mentions: ["300"],
    mediaTypes: ["image"],
    replyTo: {
      platformMessageId: "99",
      scope: { accountId: "100", groupId: "200" },
    },
  });
  expect(records[1]).toMatchObject({
    eventType: "recall",
    platformMessageId: "1",
  });
  expect(records[2]).toMatchObject({
    mediaTypes: ["record"],
    mentions: ["100"],
  });
  expect(JSON.stringify(records)).not.toMatch(
    /PRIVATE_|SECRET_AUDIO_FILE|access_token/,
  );
  expect(records.at(-1)).toMatchObject({
    eventType: "coverage",
    status: "complete",
  });
  if (process.platform !== "win32")
    expect(
      (await stat(join(f.options.directory, "events.jsonl"))).mode & 0o777,
    ).toBe(0o600);
});

it("rejects other groups, private messages, wrong accounts and action replies before capture", async () => {
  const f = await fixture();
  f.capture.receive(message(1, 300, { group_id: 999 }), "g1");
  f.capture.receive(message(2, 300, { message_type: "private" }), "g1");
  f.capture.receive({ echo: "action", access_token: "SECRET" }, "g1");
  f.capture.receive(message(3, 300, { self_id: 999 }), "g1");
  f.capture.receive(message(4), "stale");
  f.capture.receive(message(5), "g1");
  await f.capture.settle();
  expect((await f.records()).map((r) => r.platformMessageId)).toEqual(["5"]);
  expect(f.capture.status().counters.identityMismatch).toBe(1);
});

it("does not create a journal when capture is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-capture-disabled-"));
  const owner = ownDirectory(root);
  const capture = new NapCatCapture({
    directory: join(root, "absent"),
    captureEnabled: false,
    selfId: "100",
    adapterId: "qq",
  });
  ownCapture(owner, capture);
  await capture.start();
  capture.connected("g");
  capture.receive(message(), "g");
  await capture.stop();
  expect(capture.status().state).toBe("disabled");
  await expect(stat(join(root, "absent"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("records reconnect/unknown/liveness gaps and rejects late frames from retired sockets", async () => {
  const f = await fixture();
  f.capture.receive(message(), "g1");
  await f.capture.settle();
  f.at(10);
  f.capture.disconnected("g1");
  await f.capture.settle();
  f.at(20);
  f.capture.connected("g2");
  f.capture.receive(heartbeat(), "g2");
  await f.capture.settle();
  f.capture.receive(message(99), "g1");
  f.at(21);
  f.capture.malformed("g2");
  f.at(22);
  f.capture.receive(message(2), "g2");
  await f.capture.settle();
  f.at(90);
  f.capture.checkpoint();
  await f.capture.settle();
  const records = await f.records();
  expect(records.some((r) => r.platformMessageId === "99")).toBe(false);
  expect(
    records.filter((r) => r.status === "gap").map((r) => r.reason),
  ).toEqual(
    expect.arrayContaining([
      "disconnect",
      "malformed_frame",
      "heartbeat_timeout",
    ]),
  );
  expect(
    records.every(
      (r, i) => i === 0 || r.captureSeq > records[i - 1]!.captureSeq,
    ),
  ).toBe(true);
});

it("recovers sequence/dedup state and truncates only an incomplete crash tail", async () => {
  const f = await fixture();
  f.capture.receive(message(), "g1");
  f.at(5);
  f.capture.checkpoint();
  await f.capture.stop();
  const original = await f.records();
  await appendFile(join(f.options.directory, "events.jsonl"), '{"incomplete":');
  f.at(10);
  await f.capture.start();
  expect(f.capture.status().state).toBe("waiting_for_identity");
  f.capture.connected("g2");
  f.capture.receive(message(), "g2"); // 跨进程重复不能成为新发言。
  f.capture.receive(message(2), "g2");
  await f.capture.settle();
  const records = await f.records();
  expect(records.filter((r) => r.eventType === "message")).toHaveLength(2);
  expect(
    records.some((r) => r.status === "gap" && r.reason === "process_restart"),
  ).toBe(true);
  expect(records.at(-1)!.captureSeq).toBeGreaterThan(
    original.at(-1)!.captureSeq,
  );
  expect(f.capture.status().counters.duplicates).toBe(1);
});

it("uses a write barrier to prove queue overflow creates a gap and the missed message is absent", async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  cleanup.push({
    phase: "capture write barrier release",
    budgetMs: 1_000,
    run: async () => release(),
  });
  let first = true;
  const f = await fixture({
    captureQueueLimit: 1,
    journalFactory: (directory, onError) =>
      new CaptureJournal(directory, onError, async (file, data, position) => {
        if (first) {
          first = false;
          entered();
          await blocked;
        }
        await writeCaptureBytes(file, data, position);
      }),
  });
  // 先释放 barrier 再清理 fixture，即使测试断言失败也不会卡在 stop。
  cleanup.push({
    phase: "capture write barrier release",
    budgetMs: 1_000,
    run: async () => release(),
  });
  f.capture.receive(message(), "g1");
  await bounded(
    "capture write barrier entered",
    captureStopTimeout,
    () => started,
  );
  f.at(1);
  f.capture.receive(message(2), "g1");
  expect(f.capture.status().counters.queueOverflow).toBe(1);
  release();
  await f.capture.settle();
  f.at(2);
  f.capture.receive(message(3), "g1");
  await f.capture.settle();
  const records = await f.records();
  expect(
    records
      .filter((r) => r.eventType === "message")
      .map((r) => r.platformMessageId),
  ).toEqual(["1", "3"]);
  expect(
    records.some((r) => r.status === "gap" && r.reason === "queue_overflow"),
  ).toBe(true);
});

it("stops claiming coverage on disk failure and can recover the partial final write", async () => {
  let fail = true;
  const f = await fixture({
    journalFactory: (directory, onError) =>
      new CaptureJournal(directory, onError, async (file, data, position) => {
        if (fail) {
          fail = false;
          await writeCaptureBytes(file, data.subarray(0, 20), position);
          throw new Error("PRIVATE_IO_PATH");
        }
        await writeCaptureBytes(file, data, position);
      }),
  });
  f.capture.receive(message(), "g1");
  await f.capture.settle();
  expect(f.capture.status().state).toBe("failed");
  expect(f.errors).toHaveBeenCalledOnce();
  f.at(5);
  f.capture.receive(message(2), "g1");
  f.capture.checkpoint();
  await f.capture.stop();
  expect(
    await readFile(join(f.options.directory, "events.jsonl"), "utf8"),
  ).not.toContain("platformMessageId");
  f.at(10);
  await f.capture.start();
  expect(f.capture.status().state).toBe("waiting_for_identity");
  f.capture.connected("g2");
  f.capture.receive(message(3), "g2");
  await f.capture.settle();
  expect(
    (await f.records()).filter((r) => r.eventType === "message"),
  ).toHaveLength(1);
  expect(f.capture.status().state).toBe("capturing");
});

it("refuses a concurrent writer without interrupting the first writer", async () => {
  const f = await fixture();
  const errors = vi.fn();
  const other = new NapCatCapture({ ...f.options, onError: errors });
  f.own(other);
  await other.start();
  expect(other.status().state).toBe("failed");
  await other.stop();
  f.capture.receive(message(), "g1");
  await f.capture.settle();
  expect(
    (await f.records()).filter((r) => r.eventType === "message"),
  ).toHaveLength(1);
});

it(
  "exports only committed bytes with stable pseudonyms, independent mappings and no overwrite",
  async (context) => {
    const phases: { name: string; durationMs: number; outcome: string }[] = [];
    let current: { name: string; started: number } | null = null;
    let frozenDiagnostic: unknown;
    let owner: CaptureOwner | undefined;
    const freezeDiagnostic = () => {
      frozenDiagnostic ??= structuredClone({
        phases,
        current: current
          ? {
              name: current.name,
              elapsedMs: performance.now() - current.started,
            }
          : null,
        pythonChildren: [...pythonChildren].map((r) => ({
          pid: r.child.pid ?? null,
          closeConfirmed: r.didClose,
        })),
        pythonStageTimeout,
        childCloseTimeout,
        exportTestTimeout,
      });
    };
    const abort = () => {
      if (owner) owner.retained = true;
      for (const task of cleanup) if (task.owner) task.owner.retained = true;
      freezeDiagnostic();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    context.onTestFinished(() =>
      context.signal.removeEventListener("abort", abort),
    );
    const stage = async <T>(
      name: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      context.signal.throwIfAborted();
      const active = { name, started: performance.now() };
      current = active;
      let outcome = "passed";
      try {
        const result = await run();
        context.signal.throwIfAborted();
        return result;
      } catch (error) {
        outcome = "failed";
        freezeDiagnostic();
        if (owner) owner.retained = true;
        throw error;
      } finally {
        phases.push({
          name,
          durationMs: performance.now() - active.started,
          outcome,
        });
        if (current === active) current = null;
      }
    };
    onTestFailed(() => {
      freezeDiagnostic();
      console.error("Capture export stages", JSON.stringify(frozenDiagnostic));
    });
    const f = await stage("capture startup", () => fixture());
    owner = f.owner;
    const pythonCommand = async (args: string[]) => {
      const output = Promise.withResolvers<{
        stdout: string;
        stderr: string;
      }>();
      const child = execFile(
        process.platform === "win32" ? "python" : "python3",
        args,
        {
          timeout: pythonStageTimeout,
          killSignal: "SIGKILL",
          signal: context.signal,
          env: { ...process.env, PYTHONUTF8: "1" },
        },
        (error, stdout, stderr) =>
          error ? output.reject(error) : output.resolve({ stdout, stderr }),
      );
      const closed = Promise.withResolvers<void>();
      const record: PythonChild = {
        child,
        closed: closed.promise,
        didClose: false,
        owner: f.owner,
      };
      child.once("close", () => {
        record.didClose = true;
        closed.resolve();
      });
      pythonChildren.add(record);
      let result: { stdout: string; stderr: string } | undefined;
      const errors: unknown[] = [];
      try {
        result = await output.promise;
      } catch (error) {
        errors.push(error);
      }
      try {
        await bounded(
          "Python callback followed by close",
          childCloseTimeout,
          () => record.closed,
        );
        pythonChildren.delete(record);
      } catch (error) {
        f.owner.retained = true;
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Python output and close failed");
      return result!;
    };
    f.capture.receive(
      message(1, 300, { message: "[CQ:at,qq=100][CQ:reply,id=7]hello" }),
      "g1",
    );
    f.at(1800);
    f.capture.receive(heartbeat(), "g1");
    f.capture.checkpoint();
    await stage("capture settle", () => f.capture.settle());
    const keyPath = join(f.root, "key");
    await stage("export key write", () => writeFile(keyPath, "k".repeat(32)));
    const one = join(f.root, "one"),
      two = join(f.root, "two");
    const args = {
      journalDirectory: f.options.directory,
      identityKeyFile: keyPath,
      output: one,
    };
    const first = await stage("first committed export", () =>
      freezeCapture(args),
    );
    await stage("uncommitted tail append", () =>
      appendFile(
        join(f.options.directory, "events.jsonl"),
        "UNCOMMITTED_CRASH_TAIL",
      ),
    );
    const second = await stage("second committed export", () =>
      freezeCapture({ ...args, output: two }),
    );
    const mapped = await stage(
      "export bytes pseudonyms and no-overwrite verification",
      async () => {
        expect(first).toEqual(second);
        const source = await readFile(join(one, "events.jsonl"), "utf8");
        expect(source).toBe(await readFile(join(two, "events.jsonl"), "utf8"));
        expect(source).not.toMatch(
          /fictional member|@100|\[reply:7\]|"accountId":"100"|UNCOMMITTED/,
        );
        const records = source
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as CaptureRecord);
        const mapped = records.find((r) => r.eventType === "message")!;
        expect(mapped.text).toContain(`@${mapped.scope.accountId}`);
        expect(mapped.senderName).toBe(null);
        const mapping = await readFile(
          join(one, "identity-map.private.json"),
          "utf8",
        );
        expect(mapping).toContain('"original": "100"');
        await expect(freezeCapture(args)).rejects.toMatchObject({
          code: "EEXIST",
        });
        return mapped;
      },
    );
    const configPath = join(f.root, "config.json");
    await stage("Python configuration write", () =>
      writeFile(
        configPath,
        JSON.stringify({
          schemaVersion: 1,
          dataKind: "private",
          targets: [{ scope: mapped.scope, userId: mapped.senderId }],
          blocks: ["history", "dev", "test"].map((split, i) => ({
            id: `block-${i}`,
            split,
            start: new Date(epoch + i * 600000).toISOString(),
            end: new Date(epoch + (i + 1) * 600000).toISOString(),
          })),
        }),
      ),
    );
    await stage("Python prepare and sample verification", async () => {
      const result = await pythonCommand([
        resolve("benchmarks/participation/bench.py"),
        "prepare",
        "--source",
        join(one, "events.jsonl"),
        "--config",
        configPath,
        "--output",
        join(f.root, "dataset"),
      ]);
      expect(JSON.parse(result.stdout).counts.samples).toBeGreaterThan(0);
    });
    for (const command of ["preview", "evaluate"])
      await stage(`Python ${command} and offline verification`, async () => {
        const result = await pythonCommand([
          resolve("benchmarks/participation/bench.py"),
          command,
          "--dataset",
          join(f.root, "dataset"),
          "--output",
          join(f.root, command),
        ]);
        expect(JSON.parse(result.stdout).network_requests).toBe(0);
      });
    await stage("preview output verification", async () => {
      expect(
        await readFile(join(f.root, "preview/requests.jsonl"), "utf8"),
      ).not.toContain("identity-map");
    });
  },
  exportTestTimeout,
);
