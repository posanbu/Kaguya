/**
 * 功能概述：以独立进程的真实 stdio/回环 HTTP 服务验证三个协议 profile 和 W3 适配边界。
 * fixture 在 setup 前登记清理；等待 journal 中的真实请求/副作用信号，失败时也释放 hold 并回收进程。
 * 控制通道以 held/released 与应用 ACK 同步；控制 ACK 失败也独立等待原工作收敛并汇总错误。
 * 首次close失败保存脱敏cause并保留fixture目录；真实进程barrier覆盖成员退出与signal ESRCH。
 * 覆盖分页（含空游标）、权限、凭据、单进程探测、取消晚到、断连与 schema 更换；严格断言没有隐式重发。
 * 认证回显覆盖Bearer裸令牌与JSON键；显式工具错误不套用成功结果schema。
 * 所有凭据与正文均为合成数据，不运行模型或生产服务；完整文件进入 critical 门禁。
 */
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { ActionExecution } from "@kaguya/sdk";
import { writeSensitiveJson } from "@kaguya/config";
import { McpHost, type McpPromptSelection } from "./host.js";
import {
  cleanupCause,
  mcpConfigurationSchema,
  loadMcpConfiguration,
  type McpConnectionConfig,
} from "./config.js";
import {
  signalOwnedGroup,
  verifyOwnedGroup,
  runTreeHelper,
} from "./process-tree.js";
import type { McpEnvelope } from "./connection.js";
import { SingleProcessStdio } from "./stdio.js";
import {
  applySyntheticControl,
  syntheticServerSource,
} from "./synthetic-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((clean) => clean()),
  );
  const rejected = results.filter((result) => result.status === "rejected");
  if (rejected.length) throw new AggregateError(rejected, "MCP cleanup failed");
}, 65000); // 控制发布/ACK7s、host26s、HTTP child8s、journal/worker13s、文件5s及余量6s。
const wait = { timeout: 8000, interval: 20 };
/** 独立限制fixture阶段；调用者仍须释放barrier并回收真实资源，超时不代表工作已取消。 */
async function bounded<T>(
  work: Promise<T>,
  ms: number,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`fixture ${stage} unconfirmed`)),
          Math.max(0, ms),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function cleanupSnapshot(error: unknown): unknown {
  const safe = cleanupCause(error);
  const project = (value: Error): unknown => ({
    code: "code" in value ? value.code : "mcp-cleanup-causes",
    ...("details" in value ? { details: value.details } : {}),
    ...(value instanceof AggregateError
      ? { errors: value.errors.map(project) }
      : {}),
    ...(value.cause instanceof Error ? { cause: project(value.cause) } : {}),
  });
  return project(safe);
}
/** 保守累加串行阶段；并行于 RPC 的观察也单列，不以某阶段未用完预算补给其他阶段。 */
function fixtureBudget({
  connections,
  calls = 0,
  polls = 0,
  controls = 0,
  closes = 0,
  timeoutMs = 16000,
}: {
  connections: number;
  calls?: number;
  polls?: number;
  controls?: number;
  closes?: number;
  timeoutMs?: number;
}) {
  // ready8s + 每次连接独立的握手/分页发现 + RPC + 每次观察8s + ACK2s + close5s + 文件I/O5s。
  return (
    8000 +
    connections * 2 * timeoutMs +
    calls * timeoutMs +
    polls * 8000 +
    controls * 2000 +
    closes * 5000 +
    5000
  );
}
async function fixture(
  mode: "stdio" | "http",
  protocol = "2025-11-25",
  flags: Record<string, unknown> = {},
  recorder?: (envelope: McpEnvelope, id: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-"));
  const script = join(root, "server.mjs"),
    statePath = join(root, "state.json"),
    journal = join(root, "journal.jsonl");
  let state = { protocol, ...flags };
  let child: ChildProcess | undefined;
  let host: McpHost | undefined;
  let confirmedUncertainClose = false;
  let firstCloseFailure = false;
  const lateResults: { envelope: McpEnvelope; id: string }[] = [];
  const update = async (
    next: Record<string, unknown>,
    options: { allowStopped?: boolean } = {},
  ) => {
    state = { ...state, ...next };
    await writeFile(statePath, JSON.stringify(state));
    return applySyntheticControl(journal, state, options);
  };
  cleanups.push(async () => {
    const failures: unknown[] = [];
    try {
      await bounded(
        update(
          { release: true, dropControlAck: false },
          { allowStopped: true },
        ),
        7000,
        "control publication and ACK",
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!confirmedUncertainClose)
        await bounded(Promise.resolve(host?.close()), 26000, "host cleanup");
    } catch (error) {
      failures.push(error);
    }
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await bounded(exited, 8000, "HTTP child exit");
      }
    } catch (error) {
      failures.push(error);
    }
    // 在任何测试断言前已登记：即使根进程先退出，也从本 fixture journal 回收已知 worker。
    try {
      const rows = (
        await bounded(readFile(journal, "utf8"), 5000, "cleanup journal")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const row of rows.filter((row) => row.kind === "worker")) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await expect
          .poll(() => {
            try {
              process.kill(row.pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                return true;
              throw error;
            }
          }, wait)
          .toBe(true);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!failures.length && !firstCloseFailure)
        await bounded(
          rm(root, { recursive: true, force: true }),
          5000,
          "fixture files",
        );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "synthetic fixture cleanup failed");
  });
  await writeFile(script, syntheticServerSource);
  await writeFile(journal, "");
  await writeFile(statePath, JSON.stringify(state));
  let url = "";
  if (mode === "http") {
    child = spawn(process.execPath, [script, mode, statePath, journal], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.resume();
    const lines = createInterface({ input: child.stdout! });
    const ready = Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(8000) }),
      once(child, "exit").then(() => {
        throw new Error("synthetic HTTP exited before readiness");
      }),
    ]);
    const [line] = await ready;
    url = `http://127.0.0.1:${JSON.parse(String(line)).port}/mcp`;
    lines.close();
  }
  const configuration = mcpConfigurationSchema.parse({
    version: 1,
    connections: [
      {
        id: "test",
        revision: "one",
        enabled: true,
        protocol,
        transport:
          mode === "stdio"
            ? {
                type: "stdio",
                command: process.execPath,
                args: [script, mode, statePath, journal],
                envRefs: { SYNTHETIC_SECRET: "SYNTHETIC_SECRET" },
              }
            : {
                type: "http",
                url,
                headerRefs: { Authorization: "SYNTHETIC_AUTH" },
              },
        scopes: ["scope"],
        tools: [{ name: "echo" }, { name: "increment" }],
        resourceUriPrefixes: ["fixture://allowed/"],
        prompts: ["summarize"],
        timeoutMs: 3000,
      },
    ],
  });
  const open = async (overrides: Partial<McpConnectionConfig> = {}) => {
    host = await McpHost.open(
      {
        ...configuration,
        connections: [{ ...configuration.connections[0]!, ...overrides }],
      },
      (reference) =>
        reference === "SYNTHETIC_AUTH"
          ? "Bearer synthetic-token"
          : "synthetic-secret",
      {
        ownershipDirectory: join(root, "owned"),
        recordLateResult: async (envelope, id) => {
          lateResults.push({ envelope, id });
          await recorder?.(envelope, id);
        },
      },
    );
    const close = host.close.bind(host);
    host.close = async () => {
      try {
        await close();
      } catch (error) {
        if (!firstCloseFailure) {
          firstCloseFailure = true;
          try {
            await bounded(
              writeFile(
                join(root, "first-cleanup-failure.json"),
                JSON.stringify(cleanupSnapshot(error), null, 2),
              ),
              5000,
              "first cleanup snapshot",
            );
          } catch (snapshotError) {
            throw new AggregateError(
              [error, snapshotError],
              "cleanup and snapshot failed",
            );
          }
        }
        throw error;
      }
    };
    return host;
  };
  const logs = async () => {
    const text = await readFile(journal, "utf8");
    return text.trim()
      ? text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  };
  return {
    open,
    logs,
    lateResults,
    update,
    root,
    configuration,
    acknowledgeUnconfirmedClose() {
      confirmedUncertainClose = true;
    },
    get host() {
      return host!;
    },
  };
}
function execution(host: McpHost, index = 0): ActionExecution {
  const tool = host.snapshot().nativeTools.registrations[index]!;
  return {
    intentId: "intent",
    attemptId: "attempt",
    operationId: "operation",
    digest: "digest",
    signal: new AbortController().signal,
    intent: {
      operationId: "operation",
      runInformationId: "run",
      decisionInformationId: "decision",
      scope: "scope",
      sceneId: "scene",
      authorizationId: "authorization",
      authorizationVersion: 1,
      domain: "tool",
      providerId: tool.providerId,
      providerVersion: tool.providerVersion,
      executor: tool.executor,
      toolName: tool.id,
      toolCallId: "model-original-call",
      target: {},
      arguments: { value: 1 },
      dependencies: {
        observationId: "observation",
        memoryRevisions: [],
        sourceInformationIds: [],
      },
      dependsOn: [],
      deadline: new Date(Date.now() + 30000).toISOString(),
    },
  } as ActionExecution;
}
async function invoke(host: McpHost, input = execution(host)) {
  const tool = host
    .snapshot()
    .nativeTools.registrations.find(
      (tool) => tool.id === input.intent.toolName,
    )!;
  input.intent.target = (
    await tool.bind({
      arguments: input.intent.arguments,
      runInformationId: "run",
      stepInformationId: "step",
      scope: input.intent.scope,
    })
  ).target;
  return host.snapshot().actionProviders[0]!.execute(input);
}
/** 断言、release 和原工作分别收敛；保留主错和控制/清理错误，避免前者跳过后者。 */
async function withSyntheticRelease(
  inspect: () => Promise<void>,
  release: () => Promise<unknown>,
  observed: Promise<PromiseSettledResult<unknown>[]>,
) {
  const failures: unknown[] = [];
  try {
    await inspect();
  } catch (error) {
    failures.push(error);
  }
  try {
    await release();
  } catch (error) {
    failures.push(error);
  }
  for (const result of await observed)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length)
    throw new AggregateError(failures, "held assertion or cleanup failed");
}
describe.each(["2025-06-18", "2025-11-25", "2026-07-28"])(
  "MCP %s",
  (protocol) => {
    it.each(["stdio", "http"] as const)(
      "executes actual %s tools/resources/prompts with one process and frozen policy",
      async (mode) => {
        const f = await fixture(mode, protocol);
        const host = await f.open();
        expect(host.snapshot().nativeTools.registrations).toHaveLength(2);
        expect(
          host
            .snapshot()
            .nativeTools.registrations.every(
              (tool) => !tool.readonly && !tool.independent,
            ),
        ).toBe(true);
        expect(
          (await f.logs()).filter((row) => row.kind === "start"),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter(
            (row) => row.kind === "request" && row.method === "tools/list",
          ),
        ).toHaveLength(2);
        expect(
          (await f.logs()).some(
            (row) =>
              row.method === "resources/list" ||
              row.method === "prompts/list" ||
              row.method === "subscriptions/listen",
          ),
        ).toBe(false);
        const result = await invoke(host);
        expect(result).toMatchObject({
          status: "succeeded",
          evidence: "returned",
          result: {
            source: { scope: "scope", protocol, trust: "untrusted-mcp-data" },
            requests: [
              {
                method: "tools/call",
                modelToolCallId: "model-original-call",
                operationId: "operation",
                attemptId: "attempt",
              },
            ],
          },
        });
        expect(await host.listResources("test", "scope")).toMatchObject({
          value: [{ uri: "fixture://allowed/item" }],
        });
        expect(await host.listResourceTemplates("test", "scope")).toMatchObject(
          { value: [{ uriTemplate: "fixture://allowed/{id}" }] },
        );
        expect(
          await host.readResource("test", "scope", "fixture://allowed/item"),
        ).toMatchObject({ value: { contents: [{ mimeType: "text/plain" }] } });
        await host.listPrompts("test", "scope");
        await expect(host.getPrompt({} as McpPromptSelection)).rejects.toThrow(
          "mcp-user-selection-required",
        );
        const selection = host.selectPrompt({
          connectionId: "test",
          scope: "scope",
          name: "summarize",
          arguments: { topic: "synthetic" },
        });
        expect(await host.getPrompt(selection)).toMatchObject({
          value: { prompt: { messages: [{ role: "user" }] } },
        });
        await expect(host.getPrompt(selection)).rejects.toThrow(
          "mcp-user-selection-required",
        );
        const pid = host.status()[0]!.pid;
        await host.close();
        if (pid) expect(() => process.kill(pid, 0)).toThrow();
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter(
            (row) => row.kind === "http" && row.method === "GET",
          ),
        ).toHaveLength(0);
      },
      fixtureBudget({ connections: 1, calls: 6, closes: 1, timeoutMs: 3000 }),
    );
  },
);
it.each(["stdio", "http"] as const)(
  "rejects version mismatch on %s without a second process or fallback",
  async (mode) => {
    const f = await fixture(mode, "2025-06-18");
    await expect(f.open({ protocol: "2026-07-28" })).rejects.toThrow();
    expect((await f.logs()).filter((row) => row.kind === "start")).toHaveLength(
      1,
    );
    expect((await f.logs()).some((row) => row.method === "initialize")).toBe(
      false,
    );
  },
  fixtureBudget({ connections: 1, closes: 1, timeoutMs: 3000 }),
);
it.each(["stdio", "http"] as const)(
  "passes an empty opaque pagination cursor to the next %s request",
  async (mode) => {
    const f = await fixture(mode, "2025-11-25", { emptyCursor: true });
    const host = await f.open();
    expect(host.snapshot().nativeTools.registrations).toHaveLength(2);
    const pages = (await f.logs()).filter(
      (row) => row.kind === "request" && row.method === "tools/list",
    );
    expect(pages).toHaveLength(2);
    expect(pages[0].params).not.toHaveProperty("cursor");
    expect(pages[1].params).toHaveProperty("cursor", "");
  },
  fixtureBudget({ connections: 1, closes: 1, timeoutMs: 3000 }),
);
it(
  "rejects endless pagination and atomically publishes no partial directory",
  async () => {
    const f = await fixture("http", "2026-07-28", { loopPages: true });
    await expect(f.open()).rejects.toThrow();
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(2);
  },
  fixtureBudget({ connections: 1, closes: 1, timeoutMs: 3000 }),
);
it.each([{ maxPages: 1 }, { maxItems: 1 }, { maxBytes: 256 }])(
  "enforces directory budget %j",
  async (limits) => {
    const f = await fixture("http");
    await expect(f.open(limits)).rejects.toThrow();
    expect((await f.logs()).some((row) => row.kind === "effect")).toBe(false);
  },
  fixtureBudget({ connections: 1, closes: 1, timeoutMs: 3000 }),
);
it(
  "rejects failed authentication without reauthorization",
  async () => {
    const f = await fixture("http", "2026-07-28", { auth: true });
    const config = f.configuration.connections[0]!;
    await expect(
      f.open({
        transport: {
          ...config.transport,
          type: "http",
          url: (config.transport as { url: string }).url,
          headerRefs: {},
        },
      }),
    ).rejects.toThrow();
    expect((await f.logs()).filter((row) => row.kind === "http")).toHaveLength(
      1,
    );
  },
  fixtureBudget({ connections: 1, closes: 1, timeoutMs: 3000 }),
);
it.each(["headerMismatch", "inputRequired", "drop"])(
  "does not repeat an effect after %s",
  async (flag) => {
    const f = await fixture("http", "2026-07-28", { [flag]: true });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({
      status: "unknown",
      evidence: "unconfirmed",
    });
    await host.reconnect("test");
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(4);
  },
  fixtureBudget({ connections: 2, calls: 1, timeoutMs: 3000 }),
);
it(
  "keeps an old definition frozen after reconnect publishes a changed schema",
  async () => {
    const f = await fixture("http");
    const host = await f.open();
    const frozen = host.snapshot();
    await f.update({ schemaType: "string" });
    await host.reconnect("test");
    expect(frozen.nativeTools.registrations[0]!.version).not.toBe(
      host.status()[0]!.tools[0]!.revision,
    );
    expect(await invoke(host)).toMatchObject({
      status: "rejected",
      evidence: "not-executed",
    });
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
  },
  fixtureBudget({ connections: 2, calls: 1, controls: 1, timeoutMs: 3000 }),
);
it.each(["stdio", "http"] as const)(
  "keeps cancellation and late %s results unconfirmed with exactly one effect",
  async (mode) => {
    const f = await fixture(mode, "2026-07-28", { hold: true });
    const host = await f.open({ timeoutMs: 16000 });
    const input = execution(host);
    const work = invoke(host, input);
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "effect").length,
        wait,
      )
      .toBe(1);
    await host.snapshot().actionProviders[0]!.cancel!(input);
    expect(await work).toMatchObject({ status: "unknown" });
    await f.update({ release: true });
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "returned").length,
        wait,
      )
      .toBe(1);
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/call",
      ),
    ).toHaveLength(1);
    if (mode === "stdio") {
      await expect.poll(() => f.lateResults.length, wait).toBe(1);
      expect(f.lateResults[0]!.envelope).toMatchObject({
        source: {
          scope: "scope",
          definitionRevision: input.intent.target.definitionRevision,
        },
        requests: [
          {
            intentId: "intent",
            attemptId: "attempt",
            operationId: "operation",
            modelToolCallId: "model-original-call",
          },
        ],
      });
      expect(JSON.stringify(f.lateResults)).not.toContain("synthetic-secret");
    }
    await host.reconnect("test");
    expect(f.lateResults).toHaveLength(mode === "stdio" ? 1 : 0);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({ connections: 2, calls: 1, polls: 3, controls: 1 }),
);
it(
  "does not restart an exited stdio process while reading its unconfirmed outcome",
  async () => {
    const f = await fixture("stdio", "2025-06-18", { exit: true });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({ status: "unknown" });
    expect((await f.logs()).filter((row) => row.kind === "start")).toHaveLength(
      1,
    );
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    if (process.platform === "win32") {
      await expect(host.close()).rejects.toThrow("mcp-cleanup-failed");
      f.acknowledgeUnconfirmedClose();
    }
  },
  fixtureBudget({ connections: 1, calls: 1, closes: 1, timeoutMs: 3000 }),
);
it(
  "redacts referenced credentials from content and denies other scopes/resources",
  async () => {
    const f = await fixture("stdio", "2025-11-25", { echoSecret: true });
    const host = await f.open();
    expect(JSON.stringify(await invoke(host))).not.toContain(
      "synthetic-secret",
    );
    await expect(
      host.readResource("test", "scope", "fixture://denied/item"),
    ).rejects.toThrow("mcp-resource-denied");
    await expect(host.listResources("test", "other")).rejects.toThrow(
      "mcp-scope-denied",
    );
    await f.update({ escapeResource: true });
    await expect(
      host.readResource("test", "scope", "fixture://allowed/item"),
    ).rejects.toThrow("mcp-resource-result-denied");
  },
  fixtureBudget({ connections: 1, calls: 2, controls: 1, timeoutMs: 3000 }),
);
it(
  "redacts the referenced HTTP bearer token in text and object keys",
  async () => {
    const f = await fixture("http", "2025-11-25", {
      auth: true,
      echoAuth: true,
    });
    const host = await f.open();
    const result = await invoke(host);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain("synthetic-token");
    expect(result.result).toMatchObject({
      value: {
        content: [{ type: "text", text: "[REDACTED]" }],
        structuredContent: { "[REDACTED]": "credential-key" },
      },
    });
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({ connections: 1, calls: 1, timeoutMs: 3000 }),
);
describe.each(["stdio", "http"] as const)(
  "%s success output schema",
  (mode) => {
    it.each([
      { flag: "validOutput", status: "succeeded" },
      { flag: "invalidOutput", status: "unknown" },
      { flag: "missingOutput", status: "unknown" },
    ])(
      "validates $flag without repeating an effect",
      async ({ flag, status }) => {
        const f = await fixture(mode, "2025-11-25", {
          outputSchema: true,
          [flag]: true,
        });
        const host = await f.open();
        expect(await invoke(host)).toMatchObject({
          status,
          evidence: status === "succeeded" ? "returned" : "unconfirmed",
        });
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
      },
      fixtureBudget({ connections: 1, calls: 1, timeoutMs: 3000 }),
    );
  },
);
it.each(["stdio", "http"] as const)(
  "retains explicit %s tool errors without applying the success output schema",
  async (mode) => {
    const f = await fixture(mode, "2025-11-25", {
      outputSchema: true,
      isError: true,
    });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({
      status: "partial",
      evidence: "returned",
      result: {
        value: {
          isError: true,
          structuredContent: { error: "synthetic failure" },
        },
      },
    });
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({ connections: 1, calls: 1, timeoutMs: 3000 }),
);
it(
  "reports capabilities explicitly and defaults missing config to disabled",
  async () => {
    const f = await fixture("http", "2026-07-28", { unsupported: true });
    expect(await loadMcpConfiguration(f.root)).toEqual({
      version: 1,
      connections: [],
    });
    const host = await f.open();
    expect(host.snapshot().nativeTools.registrations).toHaveLength(0);
    await expect(host.listPrompts("test", "scope")).rejects.toThrow(
      "mcp-capability-unsupported",
    );
  },
  fixtureBudget({ connections: 1, timeoutMs: 3000 }),
);

it(
  "invalidates an arrived stdio directory notification without refreshing or executing",
  async () => {
    const f = await fixture("stdio");
    const host = await f.open();
    const snapshot = host.snapshot();
    const input = execution(host);
    input.intent.target = (
      await snapshot.nativeTools.registrations[0]!.bind({
        arguments: input.intent.arguments,
        scope: "scope",
        runInformationId: "run",
        stepInformationId: "step",
      })
    ).target;
    await f.update({ notify: true });
    await expect.poll(() => host.status()[0]!.tools.length, wait).toBe(0);
    expect(
      await snapshot.nativeTools.registrations[0]!.authorize({
        intent: input.intent,
        mode: "execute",
      }),
    ).toBe(false);
    expect(await snapshot.actionProviders[0]!.execute(input)).toMatchObject({
      status: "rejected",
      evidence: "not-executed",
    });
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(2);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
  },
  fixtureBudget({ connections: 1, polls: 1, controls: 1, timeoutMs: 3000 }),
);
it(
  "does not admit an old provider during delayed reconnect discovery",
  async () => {
    const f = await fixture("http");
    const host = await f.open({ timeoutMs: 16000 });
    const snapshot = host.snapshot();
    const input = execution(host);
    input.intent.target = (
      await snapshot.nativeTools.registrations[0]!.bind({
        arguments: input.intent.arguments,
        scope: "scope",
        runInformationId: "run",
        stepInformationId: "step",
      })
    ).target;
    await f.update({ holdList: true });
    const reconnect = host.reconnect("test");
    const observed = Promise.allSettled([reconnect]);
    let held: { method: string; rpcId: string | number } | undefined;
    await withSyntheticRelease(
      async () => {
        await expect
          .poll(
            async () =>
              (await f.logs()).filter(
                (row) => row.kind === "held" && row.method === "tools/list",
              ).length,
            wait,
          )
          .toBe(1);
        held = (await f.logs()).find(
          (row) => row.kind === "held" && row.method === "tools/list",
        );
        expect(await snapshot.actionProviders[0]!.execute(input)).toMatchObject(
          {
            status: "rejected",
            evidence: "not-executed",
          },
        );
      },
      async () => {
        const ack = await f.update({ release: true });
        expect(ack.released).toContainEqual({
          method: held?.method,
          rpcId: held?.rpcId,
        });
      },
      observed,
    );
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "released" && row.method === "tools/list",
      ),
    ).toHaveLength(1);
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(4);
    expect(host.status()[0]!.tools).toHaveLength(2);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
  },
  fixtureBudget({ connections: 2, polls: 1, controls: 2 }),
);
it.each(["2025-11-25", "2026-07-28"])(
  "aborts actual hanging HTTP I/O at the %s operation deadline",
  async (protocol) => {
    const f = await fixture("http", protocol, { hold: true });
    const host = await f.open({ timeoutMs: 500 });
    const result = await invoke(host);
    expect(result).toMatchObject({ status: "unknown" });
    await expect
      .poll(
        async () =>
          (await f.logs()).filter(
            (row) =>
              row.kind === "network-close" && row.method === "tools/call",
          ).length,
        wait,
      )
      .toBe(1);
    await f.update({ release: true });
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "returned").length,
        wait,
      )
      .toBe(1);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({
    connections: 1,
    calls: 1,
    polls: 2,
    controls: 1,
    timeoutMs: 500,
  }),
);

it(
  "reaps the ordinary stdio descendant process group on unload",
  async () => {
    const f = await fixture("stdio", "2025-11-25", { worker: true });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({ status: "succeeded" });
    const worker = (await f.logs()).find((row) => row.kind === "worker").pid;
    await host.close();
    await expect
      .poll(() => {
        try {
          process.kill(worker, 0);
          return false;
        } catch {
          return true;
        }
      }, wait)
      .toBe(true);
    expect(await readdir(join(f.root, "owned"))).toHaveLength(0);
  },
  fixtureBudget({
    connections: 1,
    calls: 1,
    polls: 1,
    closes: 1,
    timeoutMs: 3000,
  }),
);
it.each(["2025-11-25", "2026-07-28"])(
  "accepts actual %s HTTP SSE responses without a listen stream",
  async (protocol) => {
    const f = await fixture("http", protocol, { sse: true });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({ status: "succeeded" });
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    expect(
      (await f.logs()).some(
        (row) => row.kind === "http" && row.method === "GET",
      ),
    ).toBe(false);
  },
  fixtureBudget({ connections: 1, calls: 1, timeoutMs: 3000 }),
);
it(
  "releases earlier connections when a later stdio server cannot start",
  async () => {
    const f = await fixture("stdio");
    const config = f.configuration.connections[0]!;
    await expect(
      McpHost.open(
        {
          version: 1,
          connections: [
            config,
            {
              ...config,
              id: "bad",
              transport: {
                type: "stdio",
                command: join(f.root, "missing"),
                args: [],
                envRefs: {},
              },
            },
          ],
        },
        () => "synthetic-secret",
        { ownershipDirectory: join(f.root, "owned") },
      ),
    ).rejects.toThrow();
    const pid = (await f.logs()).find((row) => row.kind === "start").pid;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(join(f.root, "owned"))).toHaveLength(0);
  },
  fixtureBudget({ connections: 2, closes: 2, timeoutMs: 3000 }),
);

it(
  "settles a close that arrives during stdio ownership setup before any spawn",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-start-race-"));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = new SingleProcessStdio({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      maxBytes: 1024,
      ownershipDirectory: root,
      beforeSpawn: async () => {
        entered();
        await gate;
      },
    });
    const opening = transport.start();
    const settled = Promise.allSettled([opening]);
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        started,
        opening.then(() => {
          throw new Error("stdio start missed its barrier");
        }),
        new Promise<never>((_resolve, reject) =>
          AbortSignal.timeout(8000).addEventListener(
            "abort",
            () => reject(new Error("stdio setup barrier timed out")),
            { once: true },
          ),
        ),
      ]);
      closing = transport.close();
      expect(transport.pid).toBeNull();
      release();
      await closing;
      expect((await settled)[0]).toMatchObject({ status: "rejected" });
      expect(transport.pid).toBeNull();
      expect(await readdir(root)).toHaveLength(0);
    } finally {
      release();
      await Promise.allSettled([opening, closing, transport.close()]);
      await rm(root, { recursive: true, force: true });
    }
  },
  8_000 + 5_000 + 5_000 + 5_000,
);
it(
  "locates and handles descendants after the stdio root exits",
  async () => {
    const f = await fixture("stdio", "2025-06-18", {
      worker: true,
      exit: true,
    });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({ status: "unknown" });
    const worker = (await f.logs()).find((row) => row.kind === "worker").pid;
    if (process.platform === "win32") {
      await expect(host.close()).rejects.toThrow("mcp-cleanup-failed");
      expect(await readdir(join(f.root, "owned"))).toHaveLength(1);
      f.acknowledgeUnconfirmedClose();
    } else {
      await host.close();
      expect(() => process.kill(worker, 0)).toThrow();
      expect(await readdir(join(f.root, "owned"))).toHaveLength(0);
    }
  },
  fixtureBudget({
    connections: 1,
    calls: 1,
    polls: 1,
    closes: 1,
    timeoutMs: 3000,
  }),
);

it(
  "refuses a wrong owner tag for an actual controlled process and preserves its record",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-identity-"));
    let allow = false;
    const transport = new SingleProcessStdio({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      maxBytes: 1024,
      ownershipDirectory: root,
      verifyGroup: (group, tag, deadline) =>
        verifyOwnedGroup(group, allow ? tag : "wrong-owner", deadline),
    });
    let controlledPid: number | null = null;
    let exited = false;
    transport.onclose = () => {
      exited = true;
    };
    try {
      await transport.start();
      controlledPid = transport.pid;
      const pid = transport.pid!;
      if (process.platform === "win32") {
        // Windows 的生产分支使用 taskkill；这里验证真实进程配合拒绝 guard 绝不发送 POSIX 信号。
        await expect(
          signalOwnedGroup(
            pid,
            "wrong-owner",
            "SIGTERM",
            Date.now() + 1000,
            async () => ({ state: "unconfirmed", reason: "tag-mismatch" }),
          ),
        ).rejects.toThrow("identity-unconfirmed");
      } else {
        await expect(transport.close()).rejects.toThrow("identity-unconfirmed");
      }
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await readdir(root)).toHaveLength(1);
      allow = true;
      await transport.close();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await readdir(root)).toHaveLength(0);
    } finally {
      allow = true;
      const failures: unknown[] = [];
      try {
        await transport.close();
      } catch (error) {
        failures.push(error);
      }
      // 独立兜底只针对本实例实际创建的根进程；不以再次调用被测 close 成功作为清理前提。
      const pid = controlledPid ?? transport.pid;
      try {
        if (pid && !exited) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        if (pid)
          await expect
            .poll(() => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH")
                  return true;
                throw error;
              }
            }, wait)
            .toBe(true);
      } catch (error) {
        failures.push(error);
      }
      try {
        if (!failures.length) await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `controlled stdio cleanup failed; diagnostics retained at ${root}`,
        );
    }
  },
  8_000 + 3 * 5_000 + 8_000 + 5_000,
);
it(
  "bounds and reaps a non-exiting Windows tree helper using a real child",
  async () => {
    let pid: number | undefined;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const work = runTreeHelper(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      Date.now() + 1000,
      (value) => {
        pid = value;
        entered();
      },
    );
    const settled = Promise.allSettled([work]);
    try {
      await Promise.race([ready, work]);
      await expect(work).rejects.toThrow("mcp-tree-helper-unconfirmed");
      expect(pid).toBeDefined();
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      await settled;
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
    }
  },
  8_000 + 1_000 + 5_000,
);

it(
  "keeps late RPC identities local to each connection generation and ignores unknown IDs",
  async () => {
    const f = await fixture("stdio", "2026-07-28", {
      hold: true,
      echoSecret: true,
    });
    const host = await f.open({ timeoutMs: 16000 });
    for (let index = 0; index < 2; index++) {
      const input = execution(host);
      input.attemptId = `attempt-${index}`;
      input.intentId = `intent-${index}`;
      input.operationId = input.intent.operationId = `operation-${index}`;
      const work = invoke(host, input);
      await expect
        .poll(
          async () =>
            (await f.logs()).filter((row) => row.kind === "effect").length,
          wait,
        )
        .toBe(index + 1);
      await host.snapshot().actionProviders[0]!.cancel!(input);
      expect(await work).toMatchObject({ status: "unknown" });
      await f.update({ release: true, unknownReply: true });
      await expect.poll(() => f.lateResults.length, wait).toBe(index + 1);
      expect(f.lateResults[index]!.envelope.requests[0]).toMatchObject({
        intentId: input.intentId,
        attemptId: input.attemptId,
        operationId: input.operationId,
      });
      expect(JSON.stringify(f.lateResults[index])).not.toContain(
        "synthetic-secret",
      );
      if (index === 0) {
        await f.update({ release: false, unknownReply: false });
        await host.reconnect("test");
      }
    }
    const [first, second] = f.lateResults.map((item) => item.envelope);
    expect(first!.requests[0]!.rpcId).toBe(second!.requests[0]!.rpcId);
    expect(first!.source.transportGeneration).not.toBe(
      second!.source.transportGeneration,
    );
    await host.close();
    expect(f.lateResults).toHaveLength(2);
  },
  fixtureBudget({ connections: 2, calls: 2, polls: 4, controls: 3, closes: 1 }),
);
it(
  "retains a failed late-result observation with the same ID until close can persist it",
  async () => {
    let failing = true;
    const attempts: string[] = [];
    const f = await fixture(
      "stdio",
      "2026-07-28",
      { hold: true },
      async (_envelope, id) => {
        attempts.push(id);
        if (failing) throw new Error("synthetic evidence persistence failure");
      },
    );
    const host = await f.open({ timeoutMs: 16000 });
    const input = execution(host),
      work = invoke(host, input);
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "effect").length,
        wait,
      )
      .toBe(1);
    await host.snapshot().actionProviders[0]!.cancel!(input);
    expect(await work).toMatchObject({ status: "unknown" });
    await f.update({ release: true });
    await expect.poll(() => attempts.length, wait).toBe(1);
    await expect(host.close()).rejects.toThrow("mcp-cleanup-failed");
    failing = false;
    await host.close();
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts).size).toBe(1);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({ connections: 1, calls: 1, polls: 2, controls: 1, closes: 2 }),
);

it.each(["stdio", "http"] as const)(
  "releases a held %s RPC by ACK even when the state file publication is incomplete and no watch event is used",
  async (mode) => {
    const f = await fixture(mode, "2026-07-28", { hold: true });
    const host = await f.open({ timeoutMs: 16000 });
    const work = invoke(host);
    const observed = Promise.allSettled([work]);
    await withSyntheticRelease(
      async () => {
        await expect
          .poll(
            async () =>
              (await f.logs()).filter(
                (row) => row.kind === "held" && row.method === "tools/call",
              ).length,
            wait,
          )
          .toBe(1);
        // 确定性复现旧控制回调遇到半份 JSON 的输入；IPC 应不再依赖该文件或文件系统通知。
        await writeFile(join(f.root, "state.json"), "{");
        const ack = await applySyntheticControl(join(f.root, "journal.jsonl"), {
          protocol: "2026-07-28",
          hold: true,
          release: true,
        });
        const held = (await f.logs()).find(
          (row) => row.kind === "held" && row.method === "tools/call",
        );
        expect(ack.released).toEqual([
          { method: "tools/call", rpcId: held.rpcId },
        ]);
        expect(await work).toMatchObject({ status: "succeeded" });
        expect(
          (await f.logs()).filter((row) => row.kind === "released"),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
      },
      () => f.update({ release: true }),
      observed,
    );
  },
  fixtureBudget({ connections: 1, calls: 1, polls: 1, controls: 2 }),
);
it(
  "settles actual held discovery and preserves both errors when an inspection fails and its applied release ACK is lost",
  async () => {
    const f = await fixture("http");
    const host = await f.open({ timeoutMs: 16000 });
    await f.update({ holdList: true });
    const reconnect = host.reconnect("test");
    const observed = Promise.allSettled([reconnect]);
    let error: AggregateError | undefined;
    try {
      await withSyntheticRelease(
        async () => {
          await expect
            .poll(
              async () =>
                (await f.logs()).filter(
                  (row) => row.kind === "held" && row.method === "tools/list",
                ).length,
              wait,
            )
            .toBe(1);
          throw new Error("synthetic inspection failure");
        },
        () => f.update({ release: true, dropControlAck: true }),
        observed,
      );
    } catch (caught) {
      error = caught as AggregateError;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect(error!.errors.map((item) => item.message)).toEqual([
      "synthetic inspection failure",
      "synthetic-control-closed-before-ack",
    ]);
    expect(await observed).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(host.status()[0]!.tools).toHaveLength(2);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
    await f.update({ release: true, dropControlAck: false });
  },
  fixtureBudget({ connections: 2, polls: 1, controls: 3 }),
);

/** 真实受控树：EOF只记录，私有回环ACK控制退出；SIGTERM写journal以核对实际信号。 */
async function controlledTree(
  worker: boolean,
  verify?: typeof verifyOwnedGroup,
  ignoreTerm = false,
) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-race-"));
  const journal = join(root, "events.jsonl");
  const token = `${process.pid}-${performance.now()}-${Math.random()}`;
  const common = `
    const fs=require('node:fs'),net=require('node:net');
    const journal=process.argv[1],token=process.argv[2];
    const log=event=>fs.appendFileSync(journal,JSON.stringify({pid:process.pid,...event})+'\\n');
    process.on('SIGTERM',()=>{log({kind:'signal',signal:'SIGTERM'});if(!${ignoreTerm})process.exit(0)});
    const control=net.createServer(socket=>{let text='';socket.on('error',()=>{});socket.on('data',chunk=>{
      text+=chunk;if(!text.includes('\\n'))return;
      const input=JSON.parse(text);if(input.token!==token){socket.destroy();return;}
      socket.end('ack\\n',()=>{log({kind:'controlled-exit'});process.exit(0)});
    })});
  `;
  const childSource =
    common +
    `control.listen(0,'127.0.0.1',()=>process.send({port:control.address().port,pid:process.pid}));`;
  const source =
    common +
    `
    process.stdin.resume();process.stdin.on('end',()=>log({kind:'eof'}));
    control.listen(0,'127.0.0.1',()=>{
      const ready=child=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/ready',params:{port:control.address().port,...child}})+'\\n');
      if(${worker}){
        const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)},journal,token],{stdio:['ignore','ignore','ignore','ipc']});
        child.once('message',info=>ready({workerPid:info.pid,workerPort:info.port}));
      }else ready({});
    });
  `;
  let recover = false;
  let owner = "";
  let firstFailure = false;
  let info:
    { port: number; workerPid?: number; workerPort?: number } | undefined;
  let ready!: (value: NonNullable<typeof info>) => void;
  let exited!: () => void;
  const readyWork = new Promise<NonNullable<typeof info>>((resolve) => {
    ready = resolve;
  });
  const exitWork = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const transport = new SingleProcessStdio({
    command: process.execPath,
    args: ["-e", source, journal, token],
    env: {},
    maxBytes: 4096,
    ownershipDirectory: join(root, "owned"),
    verifyGroup: (group, tag, deadline, options) => {
      owner = tag;
      return (recover ? verifyOwnedGroup : (verify ?? verifyOwnedGroup))(
        group,
        tag,
        deadline,
        options,
      );
    },
  });
  transport.onmessage = (message) => {
    if ("method" in message && message.method === "fixture/ready") {
      info = message.params as NonNullable<typeof info>;
      ready(info);
    }
  };
  transport.onclose = exited;
  const originalClose = transport.close.bind(transport);
  transport.close = async () => {
    try {
      await originalClose();
    } catch (error) {
      if (!firstFailure) {
        firstFailure = true;
        try {
          await bounded(
            writeFile(
              join(root, "first-cleanup-failure.json"),
              JSON.stringify(cleanupSnapshot(error)),
            ),
            5000,
            "controlled first error",
          );
        } catch (recordError) {
          throw new AggregateError(
            [error, recordError],
            "controlled close and snapshot failed",
          );
        }
      }
      throw error;
    }
  };
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  };
  const command = async (port: number, deadline: number) => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new Error("controlled command deadline");
    const socket = connect({ host: "127.0.0.1", port });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          let text = "";
          socket.once("connect", () =>
            socket.write(JSON.stringify({ token }) + "\n"),
          );
          socket.on("data", (chunk) => {
            text += chunk;
            if (text.includes("ack\n")) resolve();
          });
          socket.once("error", reject);
          socket.once("end", () => {
            if (!text.includes("ack\n"))
              reject(new Error("controlled ACK missing"));
          });
        }),
        budget,
        "controlled ACK",
      );
    } finally {
      socket.destroy();
      await bounded(closed, 1000, "control socket close");
    }
  };
  // setup前登记；失败时先用独立控制端点退出，再用本实例真实owner校验回收。
  cleanups.push(async () => {
    recover = true;
    const errors: unknown[] = [];
    const attempt = async (
      run: () => Promise<unknown>,
      ms: number,
      stage: string,
    ) => {
      try {
        await bounded(Promise.resolve().then(run), ms, stage);
      } catch (error) {
        errors.push(error);
      }
    };
    for (const endpoint of [
      { pid: transport.pid, port: info?.port },
      { pid: info?.workerPid, port: info?.workerPort },
    ]) {
      if (endpoint.pid && endpoint.port && !gone(endpoint.pid))
        await attempt(
          () => command(endpoint.port!, Date.now() + 2000),
          3000,
          "controlled exit",
        );
    }
    await attempt(() => transport.close(), 11000, "controlled transport close");
    if (transport.pid && owner)
      await attempt(
        () =>
          signalOwnedGroup(transport.pid!, owner, "SIGKILL", Date.now() + 5000),
        5000,
        "controlled owner fallback",
      );
    for (const pid of [transport.pid, info?.workerPid])
      if (pid)
        await attempt(
          () => expect.poll(() => gone(pid), wait).toBe(true),
          8500,
          "controlled reap",
        );
    if (!errors.length && !firstFailure)
      await attempt(
        () => rm(root, { recursive: true, force: true }),
        5000,
        "controlled files",
      );
    if (errors.length)
      throw new AggregateError(
        errors,
        `controlled tree cleanup failed: ${root}`,
      );
  });
  await writeFile(journal, "");
  await bounded(transport.start(), 8000, "controlled start");
  const readyInfo = await bounded(readyWork, 8000, "controlled ready");
  return {
    root,
    transport,
    info: readyInfo,
    command,
    gone,
    exitWork,
    events: async () =>
      (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

it.skipIf(process.platform === "win32")(
  "revalidates the current worker after the root exits between pgrep and ps",
  async () => {
    let first = true;
    let tree!: Awaited<ReturnType<typeof controlledTree>>;
    tree = await controlledTree(true, (group, tag, deadline, options) =>
      verifyOwnedGroup(group, tag, deadline, {
        ...options,
        afterSnapshot: async (pids) => {
          if (!first) return;
          first = false;
          expect(pids).toContain(tree.transport.pid);
          expect(pids).toContain(tree.info.workerPid);
          expect(tree.transport.cleanupDiagnostics().wait250Exited).toBe(false);
          await tree.command(tree.info.port, deadline);
          await bounded(
            tree.exitWork,
            deadline - Date.now(),
            "root exit barrier",
          );
          expect(tree.gone(tree.transport.pid!)).toBe(true);
          expect(tree.gone(tree.info.workerPid!)).toBe(false);
        },
      }),
    );
    await tree.transport.close();
    const diagnostics = tree.transport.cleanupDiagnostics();
    expect(diagnostics.observations).toContainEqual(
      expect.objectContaining({
        stage: "membership",
        reason: "changed",
        count: 2,
        nextCount: 1,
      }),
    );
    expect(diagnostics.observations).toContainEqual(
      expect.objectContaining({ stage: "identity", reason: "owned", count: 1 }),
    );
    expect(diagnostics.observations).toContainEqual(
      expect.objectContaining({ stage: "signal", reason: "SIGTERM" }),
    );
    expect(diagnostics.rootExitedAtMs).toBeGreaterThan(diagnostics.eofAtMs!);
    expect(tree.gone(tree.info.workerPid!)).toBe(true);
    expect(
      (await tree.events()).filter((row) => row.kind === "signal"),
    ).toEqual([
      { pid: tree.info.workerPid, kind: "signal", signal: "SIGTERM" },
    ]);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
  },
  45000,
);

it.skipIf(process.platform === "win32")(
  "confirms gone after ps fails because its last selected member exited",
  async () => {
    let tree!: Awaited<ReturnType<typeof controlledTree>>;
    tree = await controlledTree(false, (group, tag, deadline, options) =>
      verifyOwnedGroup(group, tag, deadline, {
        ...options,
        afterSnapshot: async () => {
          await tree.command(tree.info.port, deadline);
          await bounded(
            tree.exitWork,
            deadline - Date.now(),
            "last member exit barrier",
          );
        },
      }),
    );
    await tree.transport.close();
    const observations = tree.transport.cleanupDiagnostics().observations;
    expect(observations).toContainEqual(
      expect.objectContaining({ stage: "ps", reason: "exec-error" }),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({ stage: "pgrep-s2", reason: "empty" }),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({
        stage: "group-probe",
        reason: "gone",
        errno: "ESRCH",
      }),
    );
    expect(
      observations.filter((event) => event.stage === "signal"),
    ).toHaveLength(0);
    expect(tree.gone(tree.transport.pid!)).toBe(true);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
  },
  45000,
);

it.skipIf(process.platform === "win32")(
  "confirms gone and reaps the root when the verified last member exits before signal",
  async () => {
    let tree!: Awaited<ReturnType<typeof controlledTree>>;
    tree = await controlledTree(
      false,
      async (group, tag, deadline, options) => {
        const result = await verifyOwnedGroup(group, tag, deadline, options);
        expect(result.state).toBe("owned");
        await tree.command(tree.info.port, deadline);
        await bounded(
          tree.exitWork,
          deadline - Date.now(),
          "verified member exit barrier",
        );
        return result;
      },
    );
    await tree.transport.close();
    const diagnostics = tree.transport.cleanupDiagnostics();
    expect(diagnostics.observations).toContainEqual(
      expect.objectContaining({
        stage: "signal",
        reason: "SIGTERM",
        errno: "ESRCH",
      }),
    );
    expect(diagnostics.observations).toContainEqual(
      expect.objectContaining({ stage: "group-probe", reason: "gone" }),
    );
    expect(diagnostics.rootExitedAtMs).not.toBeNull();
    expect(tree.gone(tree.transport.pid!)).toBe(true);
    expect(
      (await tree.events()).filter((row) => row.kind === "signal"),
    ).toHaveLength(0);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
  },
  45000,
);

it.skipIf(process.platform === "win32").each(["tag", "ps-error"] as const)(
  "retains a stable live group and its first diagnostic for %s rejection",
  async (mode) => {
    let reject = true;
    let tree!: Awaited<ReturnType<typeof controlledTree>>;
    tree = await controlledTree(false, (group, tag, deadline, options) => {
      if (!reject) return verifyOwnedGroup(group, tag, deadline, options);
      if (mode === "tag")
        return verifyOwnedGroup(group, "wrong-owner", deadline, options);
      return verifyOwnedGroup(group, tag, deadline, {
        ...options,
        query: async (kind, ids, until) => {
          if (kind === "ps")
            return {
              ok: false,
              stdout: "private command/secret must not escape",
              errno: "EPERM",
            };
          const { execFile } = await import("node:child_process");
          return await new Promise((resolve, rejectQuery) =>
            execFile(
              "/usr/bin/pgrep",
              ["-g", String(ids[0])],
              { timeout: Math.max(1, until - Date.now()) },
              (error, stdout) =>
                error ? rejectQuery(error) : resolve({ ok: true, stdout }),
            ),
          );
        },
      });
    });
    await expect(tree.transport.close()).rejects.toThrow(
      "identity-unconfirmed",
    );
    expect(tree.gone(tree.transport.pid!)).toBe(false);
    expect(
      (await tree.events()).filter((row) => row.kind === "signal"),
    ).toHaveLength(0);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(1);
    const path = join(tree.root, "first-cleanup-failure.json"),
      first = await readFile(path, "utf8");
    expect(first).toContain(
      mode === "tag" ? "tag-mismatch" : "identity-read-failed",
    );
    expect(first).toContain('"recordRetained":true');
    expect(first).not.toContain("private command/secret");
    reject = false;
    await tree.transport.close();
    expect(tree.gone(tree.transport.pid!)).toBe(true);
    expect(
      (await tree.events()).filter((row) => row.kind === "signal"),
    ).toEqual([{ pid: tree.transport.pid, kind: "signal", signal: "SIGTERM" }]);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
    expect(await readFile(path, "utf8")).toBe(first);
  },
  45000,
);

it("does not query or signal an owned process after the original cleanup deadline", async () => {
  let queried = false;
  const verify: typeof verifyOwnedGroup = async () => {
    queried = true;
    return { state: "owned" };
  };
  await expect(
    signalOwnedGroup(process.pid, "unused", "SIGTERM", Date.now() - 1, verify),
  ).rejects.toThrow("identity-unconfirmed");
  expect(queried).toBe(false);
  expect(
    await verifyOwnedGroup(process.pid, "unused", Date.now() - 1, {
      query: async () => {
        queried = true;
        return { ok: true, stdout: "" };
      },
    }),
  ).toMatchObject({ state: "unconfirmed", reason: "deadline" });
  expect(queried).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "revalidates ownership before escalating an actual TERM-resistant tree to KILL",
  async () => {
    const tree = await controlledTree(true, undefined, true);
    await tree.transport.close();
    const diagnostics = tree.transport.cleanupDiagnostics();
    const events = diagnostics.observations;
    expect(
      events
        .filter((event) => event.stage === "signal")
        .map((event) => event.reason),
    ).toEqual(["SIGTERM", "SIGKILL"]);
    const term = events.findIndex(
      (event) => event.stage === "signal" && event.reason === "SIGTERM",
    );
    const kill = events.findIndex(
      (event) => event.stage === "signal" && event.reason === "SIGKILL",
    );
    expect(
      events
        .slice(0, term)
        .some(
          (event) => event.stage === "identity" && event.reason === "owned",
        ),
    ).toBe(true);
    expect(
      events
        .slice(term + 1, kill)
        .some(
          (event) => event.stage === "identity" && event.reason === "owned",
        ),
    ).toBe(true);
    expect(diagnostics.rootExitSignal).toBe("SIGKILL");
    expect(tree.gone(tree.transport.pid!)).toBe(true);
    expect(tree.gone(tree.info.workerPid!)).toBe(true);
    expect(
      (await tree.events()).filter((row) => row.kind === "signal"),
    ).toHaveLength(2);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
  },
  45000,
);

it.skipIf(process.platform === "win32")(
  "rejects signal EPERM for a verified live tree and retains a redacted first cause",
  async () => {
    const tree = await controlledTree(false);
    const kill = process.kill.bind(process);
    const mock = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -tree.transport.pid! && signal === "SIGTERM")
        throw Object.assign(new Error("private command/secret"), {
          code: "EPERM",
        });
      return kill(pid, signal);
    });
    try {
      await expect(tree.transport.close()).rejects.toThrow(
        "mcp-stdio-signal-unconfirmed",
      );
      expect(tree.gone(tree.transport.pid!)).toBe(false);
      expect(
        (await tree.events()).filter((row) => row.kind === "signal"),
      ).toHaveLength(0);
      expect(await readdir(join(tree.root, "owned"))).toHaveLength(1);
      const first = await readFile(
        join(tree.root, "first-cleanup-failure.json"),
        "utf8",
      );
      expect(first).toContain("EPERM");
      expect(first).not.toContain("private command/secret");
    } finally {
      mock.mockRestore();
    }
    await tree.transport.close();
    expect(tree.gone(tree.transport.pid!)).toBe(true);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
  },
  45000,
);

it
  .skipIf(process.platform === "win32")
  .each(["before-ps", "before-signal"] as const)(
  "does not continue a real owned tree cleanup after budget expires %s",
  async (stage) => {
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const tree = await controlledTree(
      false,
      async (group, tag, deadline, options) => {
        const identity = await verifyOwnedGroup(group, tag, deadline, {
          ...options,
          ...(stage === "before-ps"
            ? {
                afterSnapshot: async () => {
                  clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
                },
              }
            : {}),
        });
        if (stage === "before-signal")
          clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
        return identity;
      },
    );
    try {
      await expect(tree.transport.close()).rejects.toThrow(
        "identity-unconfirmed",
      );
    } finally {
      clock?.mockRestore();
    }
    const diagnostics = tree.transport.cleanupDiagnostics();
    expect(
      diagnostics.observations.filter((event) => event.stage === "signal"),
    ).toHaveLength(0);
    if (stage === "before-ps")
      expect(
        diagnostics.observations.filter((event) => event.stage === "ps"),
      ).toHaveLength(0);
    expect(tree.gone(tree.transport.pid!)).toBe(false);
    expect(
      (await tree.events()).filter((row) => row.kind === "signal"),
    ).toHaveLength(0);
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(1);
    expect(
      await readFile(join(tree.root, "first-cleanup-failure.json"), "utf8"),
    ).toContain("deadline");
  },
  45000,
);

it("bounds close while a real ownership setup barrier is held and prevents a later spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-start-deadline-"));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = new SingleProcessStdio({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    env: {},
    maxBytes: 1024,
    ownershipDirectory: root,
    beforeSpawn: async () => {
      enter();
      await gate;
    },
  });
  const opening = transport.start(),
    observed = Promise.allSettled([opening]);
  const errors: unknown[] = [];
  try {
    await bounded(entered, 8000, "ownership barrier entered");
    await expect(transport.close()).rejects.toThrow(
      "mcp-stdio-start-settlement-unconfirmed",
    );
    expect(transport.pid).toBeNull();
    release();
    expect(
      (await bounded(observed, 5000, "released ownership setup"))[0],
    ).toMatchObject({ status: "rejected" });
    await transport.close();
    expect(transport.pid).toBeNull();
    expect(await readdir(root)).toHaveLength(0);
  } catch (error) {
    errors.push(error);
  } finally {
    release();
    for (const [stage, run] of [
      ["ownership setup settlement", () => observed],
      ["ownership transport close", () => transport.close()],
    ] as const) {
      try {
        await bounded(
          Promise.resolve().then(async () => {
            await run();
          }),
          5000,
          stage,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (!errors.length) {
      try {
        await bounded(
          rm(root, { recursive: true, force: true }),
          5000,
          "ownership files",
        );
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `ownership deadline fixture failed: ${root}`,
    );
}, 38000);

it("reaps an already spawned child while its real ownership publication remains blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-publish-deadline-"));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let published = false;
  let ownerTag = "";
  let childClosed = false;
  const transport = new SingleProcessStdio({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    env: {},
    maxBytes: 1024,
    ownershipDirectory: root,
    writeOwnership: async (path, value) => {
      ownerTag = (value as { ownerTag: string }).ownerTag;
      enter();
      await gate;
      await writeSensitiveJson(path, value);
      published = true;
    },
  });
  transport.onclose = () => {
    childClosed = true;
  };
  const opening = transport.start(),
    observed = Promise.allSettled([opening]);
  const errors: unknown[] = [];
  let first = "";
  try {
    await bounded(entered, 8000, "spawned ownership publication entered");
    const pid = transport.pid!;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await expect(transport.close()).rejects.toThrow(
      "mcp-stdio-start-settlement-unconfirmed",
    );
    expect(published).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(transport.cleanupDiagnostics()).toMatchObject({
      treeReaped: true,
      startupPending: true,
      recordRetained: false,
    });
    expect(transport.cleanupDiagnostics().rootExitedAtMs).not.toBeNull();
    first = JSON.stringify(transport.cleanupDiagnostics());
    release();
    expect(
      (await bounded(observed, 5000, "ownership publication released"))[0],
    ).toMatchObject({ status: "rejected" });
    expect(published).toBe(true);
    expect(await readdir(root)).toHaveLength(1);
    await transport.close();
    expect(
      transport
        .cleanupDiagnostics()
        .observations.filter((event) => event.stage === "signal"),
    ).toHaveLength(0);
    expect(await readdir(root)).toHaveLength(0);
    expect(first).toContain('"treeReaped":true');
  } catch (error) {
    errors.push(error);
  } finally {
    release();
    for (const [stage, run] of [
      [
        "publication settlement",
        async () => {
          await observed;
        },
      ],
      [
        "publication transport close",
        async () => {
          await transport.close();
        },
      ],
    ] as const) {
      try {
        await bounded(Promise.resolve().then(run), 5000, stage);
      } catch (error) {
        errors.push(error);
      }
    }
    // 与被测close独立：仅回收当前实例真实创建的根；POSIX每次仍核验当前owner。
    const pid = transport.pid;
    if (pid && !childClosed) {
      try {
        if (process.platform === "win32") process.kill(pid, "SIGKILL");
        else
          await signalOwnedGroup(pid, ownerTag, "SIGKILL", Date.now() + 5000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          errors.push(error);
      }
    }
    if (pid) {
      try {
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                return true;
              throw error;
            }
          }, wait)
          .toBe(true);
      } catch (error) {
        errors.push(error);
      }
    }
    if (!errors.length) {
      try {
        await bounded(
          rm(root, { recursive: true, force: true }),
          5000,
          "publication files",
        );
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      `ownership publication fixture failed: ${root}`,
    );
}, 60000);

it
  .skipIf(process.platform === "win32")
  .each(["transient", "persistent"] as const)(
  "requires explicit ESRCH after %s EPERM during post-signal drain",
  async (mode) => {
    const tree = await controlledTree(false);
    const kill = process.kill.bind(process);
    let signalled = false,
      denied = 0;
    const mock = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (
        pid === -tree.transport.pid! &&
        signal === 0 &&
        signalled &&
        (mode === "persistent" || denied === 0)
      ) {
        denied++;
        throw Object.assign(new Error("synthetic drain denial"), {
          code: "EPERM",
        });
      }
      const result = kill(pid, signal);
      if (pid === -tree.transport.pid! && signal === "SIGTERM")
        signalled = true;
      return result;
    });
    try {
      if (mode === "transient") await tree.transport.close();
      else
        await expect(tree.transport.close()).rejects.toThrow(
          "identity-unconfirmed",
        );
      const events = tree.transport.cleanupDiagnostics().observations;
      expect(events).toContainEqual(
        expect.objectContaining({
          stage: "drain-probe",
          reason: "probe-error",
          errno: "EPERM",
        }),
      );
      expect(
        events
          .filter((event) => event.stage === "signal")
          .map((event) => event.reason),
      ).toEqual(["SIGTERM"]);
      expect(tree.gone(tree.transport.pid!)).toBe(true);
      expect(
        (await tree.events()).filter((row) => row.kind === "signal"),
      ).toEqual([
        { pid: tree.transport.pid, kind: "signal", signal: "SIGTERM" },
      ]);
      if (mode === "transient") {
        expect(events).toContainEqual(
          expect.objectContaining({
            stage: "drain-probe",
            reason: "gone",
            errno: "ESRCH",
          }),
        );
        expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
      } else {
        expect(
          events.filter(
            (event) => event.stage === "drain-probe" && event.reason === "gone",
          ),
        ).toHaveLength(0);
        expect(await readdir(join(tree.root, "owned"))).toHaveLength(1);
        expect(
          await readFile(join(tree.root, "first-cleanup-failure.json"), "utf8"),
        ).toContain("EPERM");
      }
    } finally {
      mock.mockRestore();
    }
    await tree.transport.close();
    expect(await readdir(join(tree.root, "owned"))).toHaveLength(0);
  },
  45000,
);
