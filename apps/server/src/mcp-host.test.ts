/**
 * 功能概述：验证真实 Server 装配、Web→Heavy→W3→MCP→后继模型回复及管理端显式资源/prompt。
 * 只替换模型 HTTP 和数据库连接工厂；MCP 为真实独立 stdio/回环 HTTP 合成服务。
 * 使用临时配置、真实 PGlite 或显式 PostgreSQL schema；等待持久回执及队列收敛，精确核对副作用。
 * causalTurn/observedTurn/scheduledHeavy 按原输入串联 Identity、context、Situation、Attention、Light 与 Heavy intent。
 * 每段沿用8秒条件等待；fixture预算计入setup、MCP请求、控制和close，诊断记录backend、阶段与关联ID。
 * Light gate 只阻塞合成模型响应，回归确认观察完成不等于模型完成；release与observer settle独立清理。
 * 管理 GUI 测试仅替换 broker RPC，保留真实 Host/W3/SDK 原图链路；不产生外部模型请求。
 * 迟到响应经真实JSONB读取再由Inspection核验摘要与intent/attempt；人工核对入口拒绝未认证与跨scope读取。
 * 正式链路按 MCP 回执、匹配 run 的模型/assistant 持久化、Web 交付与队列收敛分阶段等待。
 * fixture 在 setup 失败和 shutdown 异常时也尝试释放所有资源；记录子进程 PID，验证关闭后不残留。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import {
  KaguyaRuntime,
  LinuxToolsHost,
  LinuxEnvironmentClient,
  nativeToolWireName,
} from "@kaguya/runtime";
import { KaguyaDatabase } from "@kaguya/database";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import {
  FileUserConfigManager,
  loadModuleInstanceConfigs,
  writeSensitiveJson,
} from "@kaguya/config";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import {
  applySyntheticControl,
  syntheticServerSource,
} from "@kaguya/mcp/testing";
import type { ActionExecution } from "@kaguya/sdk";
import { createMcpLateResultRecorder } from "./mcp-host.js";
import { McpHost, mcpLateResultInformationKind } from "@kaguya/mcp";
import { startKaguyaServer, type StartedKaguyaServer } from "./server.js";
import {
  createPersistenceWait,
  expectPersistenceSettled,
  withModelGateCleanup,
  persistenceWait,
} from "./test-support/persistence.js";

const models = vi.hoisted(() => ({
  heavy: 0,
  gui: 0,
  light: 0,
  requests: [] as any[],
  lightGate: undefined as ((body: any) => Promise<void>) | undefined,
}));
vi.mock("@ai-sdk/openai-compatible", async (original) => {
  const actual = await original<typeof import("@ai-sdk/openai-compatible")>();
  return {
    ...actual,
    createOpenAICompatible: (options: any) =>
      actual.createOpenAICompatible({
        ...options,
        fetch: async (_url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          models.requests.push(body);
          if (body.model === "light") {
            models.light++;
            await models.lightGate?.(body);
          }
          const heavy = body.model === "heavy";
          if (heavy) models.heavy++;
          const gui = body.model === "vision";
          if (gui) models.gui++;
          const tools =
            ((heavy && models.heavy === 1) || (gui && models.gui === 1)) &&
            body.tools?.length;
          const message = tools
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: gui ? "gui-model-original" : "mcp-model-original",
                    type: "function",
                    function: {
                      name: gui
                        ? nativeToolWireName("gui.observe", "1")
                        : body.tools[0].function.name,
                      arguments: gui
                        ? '{"target":{"kind":"desktop"}}'
                        : '{"value":7}',
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: JSON.stringify(
                  heavy
                    ? { action: "message", text: "MCP completed" }
                    : { action: "message", reason: "respond" },
                ),
              };
          return new Response(
            JSON.stringify({
              id: "synthetic-model",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: tools ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
  };
});
const cleanupLimits = {
  observer: 16000,
  server: 20000,
  database: 10000,
  child: 8000,
  files: 5000,
  auxiliary: 5000,
  owner: 8000,
  ownerTotal: 16000,
  runtime: 20000,
  settlement: 16000,
  fixture: 100000,
  hook: 130000,
} as const;
type CleanupOwner = { root: string; failed: boolean };
type FixtureCleanup = {
  owner: CleanupOwner;
  phase: string;
  budgetMs: number;
  run: () => Promise<unknown>;
};
const cleanups: FixtureCleanup[] = [];
/** 清理阶段有独立上限；失败仍继续其他资源，未确认释放时由fixture保留诊断目录。 */
async function cleanupAttempt<T>(
  phase: string,
  budgetMs: number,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(run);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`cleanup ${phase} unconfirmed after ${budgetMs}ms`),
            ),
          budgetMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const closeOwnedMcp = McpHost.prototype.close;
const closeOwnedRuntime = KaguyaRuntime.prototype.close;
async function drainFixtureCleanups(owner?: CleanupOwner) {
  const tasks = owner
    ? cleanups.filter((task) => task.owner === owner)
    : [...cleanups];
  for (const task of tasks) cleanups.splice(cleanups.indexOf(task), 1);
  const errors: unknown[] = [];
  for (const task of tasks.reverse()) {
    try {
      await cleanupAttempt(task.phase, task.budgetMs, task.run);
    } catch (error) {
      task.owner.failed = true;
      errors.push(
        new Error(
          `${task.phase} cleanup failed; diagnostics retained at ${task.owner.root}`,
          { cause: error },
        ),
      );
    }
  }
  return errors;
}
afterEach(async () => {
  const errors = await drainFixtureCleanups();
  vi.restoreAllMocks();
  models.heavy = 0;
  models.light = 0;
  models.lightGate = undefined;
  models.gui = 0;
  models.requests = [];
  if (errors.length)
    throw new AggregateError(errors, "Server MCP cleanup failed");
}, cleanupLimits.hook); // gate16s + fixture100s + Linux辅助5s + 调度余量9s。
// 仅测试配置；MCP专用deadline测试在packages/mcp保持原值，生产配置/全局wait不变。
const fixtureLimits = {
  httpReady: 8000,
  filesAndDatabase: 15000,
  mcpRequest: 30000, // 与本fixture原有MCP默认值相同，仅为串行预算显式记录。
  runtimeBootstrap: 15000,
  close: cleanupLimits.server,
  control: 2000,
  localIo: 5000,
} as const;
function serverFixtureBudget({
  stages = 0,
  setups = 1,
  closes = 1,
  reads = 0,
  controls = 0,
  drains = 0,
}: {
  stages?: number;
  setups?: number;
  closes?: number;
  reads?: number;
  controls?: number;
  drains?: number;
} = {}) {
  const setup =
    fixtureLimits.httpReady +
    fixtureLimits.filesAndDatabase +
    2 * fixtureLimits.mcpRequest +
    fixtureLimits.runtimeBootstrap;
  return (
    setups * setup +
    stages * persistenceWait.timeout +
    closes * fixtureLimits.close +
    reads * fixtureLimits.mcpRequest +
    controls * fixtureLimits.control +
    drains * cleanupLimits.hook +
    fixtureLimits.localIo
  );
}
type FixtureAtom = {
  informationId: string;
  kind: string;
  payload: any;
  references: readonly { relation: string; informationId: string }[];
};
type CausalTurn = {
  inbound: FixtureAtom;
  identity: FixtureAtom;
  turn: FixtureAtom;
};
async function fixture(
  mode: "stdio" | "http",
  flags: Record<string, unknown> = {},
  cleanupOptions: { serverCloseMs?: number } = {},
) {
  const createdAt = performance.now();
  const spans: {
    phase: string;
    elapsedMs: number;
    outcome: string;
    allowanceMs: number;
  }[] = [];
  const ids: Record<string, string> = {};
  let nextSpan = 0;
  const activePhases = new Map<
    number,
    { name: string; since: number; allowanceMs: number }
  >();
  async function record<T>(
    phase: string,
    allowanceMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    const spanId = ++nextSpan;
    activePhases.set(spanId, { name: phase, since: started, allowanceMs });
    let outcome = "passed";
    try {
      return await run();
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      spans.push({
        phase,
        elapsedMs: Math.round(performance.now() - started),
        outcome,
        allowanceMs,
      });
      activePhases.delete(spanId);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "kaguya-server-mcp-"));
  let server: StartedKaguyaServer | undefined;
  let db: KaguyaDatabase | undefined;
  let child: ChildProcess | undefined;
  let databaseClosed = false;
  const cleanupOwner: CleanupOwner = { root, failed: false };
  const ownedMcp = new Set<McpHost>();
  let runtimeOwner: KaguyaRuntime | undefined;
  const openMcp = McpHost.open;
  vi.spyOn(McpHost, "open").mockImplementation(
    async (...args: Parameters<typeof McpHost.open>) => {
      const host = await openMcp.apply(McpHost, args);
      if (args[2]?.ownershipDirectory === join(root, "mcp-processes"))
        ownedMcp.add(host);
      return host;
    },
  );
  const registerCleanup = (
    phase: string,
    budgetMs: number,
    run: () => Promise<unknown>,
  ) => {
    cleanups.push({ owner: cleanupOwner, phase, budgetMs, run });
  };
  registerCleanup("Server fixture", cleanupLimits.fixture, async () => {
    const errors: unknown[] = [];
    const attempt = async (
      phase: string,
      budgetMs: number,
      run: () => Promise<unknown>,
    ) => {
      try {
        await cleanupAttempt(phase, budgetMs, run);
        return true;
      } catch (error) {
        cleanupOwner.failed = true;
        errors.push(error);
        return false;
      }
    };
    const closeWork = Promise.resolve().then(() => server?.close());
    // 尽早挂接拒绝处理；timeout只表示未确认，不代表原Server.close已经结束。
    const closeObserved = Promise.allSettled([closeWork]);
    const confirmed = await attempt(
      "Server.close",
      cleanupOptions.serverCloseMs ?? cleanupLimits.server,
      () => closeWork,
    );
    await attempt("actual MCP owners", cleanupLimits.ownerTotal, async () => {
      const ownerErrors: unknown[] = [];
      for (const owner of ownedMcp) {
        try {
          await cleanupAttempt(
            "MCP owner close and reap",
            cleanupLimits.owner,
            async () => {
              const pids = owner
                .status()
                .flatMap((status) => (status.pid === null ? [] : [status.pid]));
              await closeOwnedMcp.call(owner);
              for (const pid of pids) {
                try {
                  process.kill(pid, 0);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ESRCH")
                    continue;
                  throw error;
                }
                throw new Error("actual MCP owner process exit unconfirmed");
              }
            },
          );
        } catch (error) {
          ownerErrors.push(error);
        }
      }
      if (ownerErrors.length)
        throw new AggregateError(ownerErrors, "MCP owner cleanup unconfirmed");
    });
    if (!confirmed) {
      await attempt("actual Runtime owner", cleanupLimits.runtime, async () => {
        if (runtimeOwner) await closeOwnedRuntime.call(runtimeOwner);
      });
      await attempt(
        "original Server.close settlement",
        cleanupLimits.settlement,
        async () => {
          const [result] = await closeObserved;
          if (result!.status === "rejected") throw result!.reason;
        },
      );
    }
    await attempt("database.close", cleanupLimits.database, async () => {
      if (!databaseClosed) await db?.close();
    });
    await attempt("HTTP child exit", cleanupLimits.child, async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", {
          signal: AbortSignal.timeout(cleanupLimits.child),
        });
        child.kill("SIGKILL");
        await exited;
      }
    });
    if (!cleanupOwner.failed && !errors.length)
      await attempt("fixture files", cleanupLimits.files, () =>
        rm(root, { recursive: true, force: true }),
      );
    if (errors.length)
      throw new AggregateError(
        errors,
        `Server fixture cleanup unconfirmed; diagnostics retained at ${root}`,
      );
  });
  const script = join(root, "synthetic.mjs"),
    state = join(root, "state.json"),
    journal = join(root, "journal.jsonl");
  await writeFile(script, syntheticServerSource);
  await writeFile(state, JSON.stringify({ protocol: "2025-11-25", ...flags }));
  await writeFile(journal, "");
  let url = "";
  if (mode === "http") {
    child = spawn(process.execPath, [script, mode, state, journal], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.resume();
    const lines = createInterface({ input: child.stdout! });
    const [line] = await once(lines, "line", {
      signal: AbortSignal.timeout(8000),
    });
    lines.close();
    url = `http://127.0.0.1:${JSON.parse(String(line)).port}/mcp`;
  }
  const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
  await loadModuleInstanceConfigs({
    rootDir: root,
    defaults: createFirstPartyModuleConfigDefaults(),
  });
  await manager.replaceProfile(manager.getSelectedProfileId(), {
    name: "default",
    acknowledgedWarnings: [],
    identity: { timeZone: "Asia/Shanghai" },
    runtime: {
      host: "127.0.0.1",
      port: 3000,
      databaseMode: "external",
      databaseUrl: "postgresql://synthetic@127.0.0.1/synthetic",
      webDistPath: join(root, "web"),
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 10000,
      rateLimitWindowMs: 60000,
      logLevel: "silent",
      logFormat: "json",
      inboundAllowlist: [],
      outboundAllowlist: [],
    },
    ai: {
      defaultProviderId: "synthetic",
      modelTiers: {
        light: { providerId: "synthetic", modelId: "light" },
        heavy: { providerId: "synthetic", modelId: "heavy" },
      },
      providers: [
        {
          id: "synthetic",
          type: "openai-compatible",
          enabled: true,
          baseUrl: "https://synthetic.invalid/v1",
          apiKey: "synthetic",
          models: ["light", "heavy", "vision"],
          settings: {},
        },
      ],
    },
  });
  await manager.acknowledgeConfigurationWarnings(
    manager.getSelectedProfileId(),
    [],
  );
  const scope = JSON.stringify([
    "web",
    "web.ui.main",
    "web",
    "47d34f33-c005-45e1-bae4-06df09bd9dc1",
  ]);
  await writeSensitiveJson(join(root, "mcp.json"), {
    version: 1,
    connections: [
      {
        id: "synthetic",
        revision: "one",
        enabled: true,
        protocol: "2025-11-25",
        timeoutMs: fixtureLimits.mcpRequest,
        transport:
          mode === "stdio"
            ? {
                type: "stdio",
                command: process.execPath,
                args: [script, mode, state, journal],
              }
            : { type: "http", url },
        scopes: [scope],
        tools: [{ name: "echo" }],
        resourceUriPrefixes: ["fixture://allowed/"],
        prompts: ["summarize"],
      },
    ],
  });
  await mkdir(join(root, "web"));
  await writeFile(join(root, "web", "index.html"), "<main>synthetic</main>");
  const pg = process.env.KAGUYA_TEST_DATABASE_URL;
  db = pg
    ? await createPostgresTestingDatabase(pg)
    : await createTestingDatabase();
  const closeDatabase = db.close.bind(db);
  vi.spyOn(db, "close").mockImplementation(async () => {
    if (!databaseClosed) {
      await closeDatabase();
      databaseClosed = true;
    }
  });
  vi.spyOn(KaguyaDatabase, "connect").mockResolvedValue(db);
  spans.push({
    phase: "fixture files/config/database",
    elapsedMs: Math.round(performance.now() - createdAt),
    outcome: "passed",
    allowanceMs: fixtureLimits.httpReady + fixtureLimits.filesAndDatabase,
  });
  const start = async () => {
    server = await record(
      "Server.start: MCP handshake/catalog + Runtime bootstrap",
      2 * fixtureLimits.mcpRequest + fixtureLimits.runtimeBootstrap,
      () =>
        startKaguyaServer({
          host: "127.0.0.1",
          port: 0,
          gatewayToken: "synthetic-gateway",
          corsOrigins: [],
          trustProxy: false,
          rateLimitMax: 10000,
          rateLimitWindowMs: 60000,
          databaseUrl: "postgresql://synthetic@127.0.0.1/synthetic",
          configRoot: root,
          development: false,
          webDistPath: join(root, "web"),
          logLevel: "silent",
          logFormat: "json",
          inboundAllowlist: [],
          outboundAllowlist: [],
          napcat: {
            enabled: false,
            adapterId: "napcat.qq.main",
            reconnectMs: 3000,
          },
        }),
    );
    runtimeOwner = server.runtime;
    const close = server.close.bind(server);
    server.close = () =>
      record("Server.close", fixtureLimits.close, () => close());
    return server;
  };
  const diagnostics = () => ({
    backend: pg ? "PostgreSQL isolated schema" : "PGlite isolated database",
    workerPid: process.pid,
    workerId: process.env.VITEST_WORKER_ID ?? null,
    sinceFixtureMs: Math.round(performance.now() - createdAt),
    activePhases: [...activePhases.values()].map((phase) => ({
      name: phase.name,
      elapsedMs: Math.round(performance.now() - phase.since),
      allowanceMs: phase.allowanceMs,
    })),
    phases: [...spans],
    ids: { ...ids },
    databaseClosed,
    capturedMcpOwners: ownedMcp.size,
    light: models.light,
    heavy: models.heavy,
    gui: models.gui,
  });
  const waiter = (extra: () => Record<string, unknown> = () => ({})) => {
    const wait = createPersistenceWait(db!, () => ({
      ...diagnostics(),
      ...extra(),
    }));
    return <T>(phase: string, assertion: () => T | Promise<T>) =>
      record(phase, persistenceWait.timeout, () => wait(phase, assertion));
  };
  const facts = (kind: string) =>
    db!.information.find({ kinds: [kind], limit: 100 });
  const causalTurn = async (input: {
    text: string;
    requestId?: string;
  }): Promise<CausalTurn> => {
    let result!: CausalTurn;
    await waiter()(
      "original input: Identity terminal and turn context",
      async () => {
        const inbounds = (await facts("core.message.inbound.text")).filter(
          (atom) => {
            const payload = atom.payload as any;
            return (
              payload.text === input.text &&
              payload.source.platform === "web" &&
              payload.source.adapterId === "web.ui.main" &&
              payload.source.destination.conversationId ===
                "47d34f33-c005-45e1-bae4-06df09bd9dc1" &&
              (!input.requestId ||
                payload.source.platformMessageId === input.requestId)
            );
          },
        );
        expect(inbounds).toHaveLength(1);
        const inbound = inbounds[0]!;
        ids.inbound = inbound.informationId;
        const turns = (
          await facts("agent.router.turn.context.completed")
        ).filter((atom) =>
          (atom.payload.inputs as any[]).some(
            (item) => item.informationId === inbound.informationId,
          ),
        );
        expect(turns).toHaveLength(1);
        const turn = turns[0]!;
        const routerScope =
          "web:web.ui.main:web:47d34f33-c005-45e1-bae4-06df09bd9dc1";
        expect(turn.payload.scopeKey).toBe(routerScope);
        const candidate = await db!.information.get(
          String(turn.payload.candidateInformationId),
        );
        const claim = await db!.information.get(
          String(turn.payload.claimInformationId),
        );
        expect(candidate?.kind).toBe("agent.heartbeat.candidate");
        expect(candidate!.payload).toMatchObject({
          scopeKey: routerScope,
          triggerInformationId: inbound.informationId,
          unreadThroughInformationId: inbound.informationId,
        });
        expect(claim?.kind).toBe("agent.router.turn.claimed");
        expect(claim!.payload).toMatchObject({
          candidateInformationId: candidate!.informationId,
          scopeKey: routerScope,
        });
        expect(turn.references).toContainEqual({
          relation: "agent:turn-claim",
          informationId: claim!.informationId,
        });
        const item = (turn.payload.inputs as any[]).find(
          (item) => item.informationId === inbound.informationId,
        )!;
        const identity = await db!.information.get(
          item.identity.terminalInformationId,
        );
        expect(identity?.kind).toBe("memory.identity.person.context.completed");
        expect(identity!.references).toContainEqual({
          relation: "core:status-of",
          informationId: inbound.informationId,
        });
        expect(identity!.payload.status).toBe(item.identity.status);
        expect(identity!.payload).toMatchObject({
          status: "unresolved",
          scopeMode: "ephemeral",
        });
        expect(turn.references).toContainEqual({
          relation: "core:uses-context",
          informationId: inbound.informationId,
        });
        expect(turn.references).toContainEqual({
          relation: "core:uses-context",
          informationId: identity!.informationId,
        });
        ids.requestId = String(
          (inbound.payload.source as any).platformMessageId,
        );
        ids.runtimeContext = inbound.references.find(
          (ref) => ref.relation === "core:context",
        )!.informationId;
        for (const atom of [identity!, candidate!, claim!, turn]) {
          const reference = atom.references.find(
            (ref) => ref.relation === "core:context",
          );
          if (reference)
            expect(reference.informationId).toBe(ids.runtimeContext);
        }
        ids.identity = identity!.informationId;
        ids.turn = turn.informationId;
        ids.candidate = String(turn.payload.candidateInformationId);
        ids.claim = String(turn.payload.claimInformationId);
        result = { inbound, identity: identity!, turn };
      },
    );
    return result;
  };
  const observedTurn = async (input: { text: string; requestId?: string }) => {
    const result = await causalTurn(input);
    await waiter()(
      "same turn: Situation frozen and Attention observe",
      async () => {
        const situations = (await facts("agent.situation.frozen")).filter(
          (atom) =>
            atom.payload.turnInformationId === result.turn.informationId,
        );
        const observations = (
          await facts("agent.attention.arousal.completed")
        ).filter(
          (atom) =>
            atom.payload.candidateInformationId ===
              result.turn.payload.candidateInformationId &&
            atom.payload.outcome === "observe",
        );
        expect(situations).toHaveLength(1);
        expect(observations).toHaveLength(1);
        ids.situation = situations[0]!.informationId;
        ids.attention = observations[0]!.informationId;
      },
    );
    return result;
  };
  const lightState = async (context: CausalTurn) => {
    const requested = (await facts("core.model.task.requested")).filter(
      (atom) =>
        atom.payload.taskId === "agent.light.decide" &&
        atom.payload.sourceInformationId === context.turn.informationId,
    );
    const completed = (await facts("core.model.task.completed")).filter(
      (atom) =>
        atom.payload.taskId === "agent.light.decide" &&
        atom.references.some(
          (ref) =>
            ref.relation === "core:status-of" &&
            ref.informationId === requested[0]?.informationId,
        ),
    );
    const decisions = (await facts("agent.light.decision.completed")).filter(
      (atom) =>
        atom.payload.turnContextInformationId === context.turn.informationId,
    );
    const intents = (
      await facts("agent.router.message.intent.requested")
    ).filter(
      (atom) =>
        (atom.payload.turn as any).contextInformationId ===
        context.turn.informationId,
    );
    const progress = {
      requested: requested.length,
      completed: completed.length,
      decisions: decisions.length,
      intents: intents.length,
    };
    const ready =
      progress.requested === 1 &&
      progress.completed === 1 &&
      progress.decisions === 1 &&
      progress.intents === 1;
    return { requested, completed, decisions, intents, progress, ready };
  };
  const heavyForTurn = async (context: CausalTurn) => {
    let intent!: FixtureAtom;
    await waiter()(
      "same turn: paired Light completion and Heavy intent",
      async () => {
        const { requested, completed, decisions, intents, ready } =
          await lightState(context);
        expect(ready).toBe(true);
        expect(requested).toHaveLength(1);
        ids.lightRequested = requested[0]!.informationId;
        expect(requested[0]!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: context.turn.informationId,
        });
        expect(completed).toHaveLength(1);
        ids.lightCompleted = completed[0]!.informationId;
        expect(completed[0]!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: requested[0]!.informationId,
        });
        expect(decisions).toHaveLength(1);
        expect(decisions[0]!.payload.action).toMatchObject({
          action: "message",
        });
        expect(decisions[0]!.references).toContainEqual({
          relation: "core:status-of",
          informationId: String(context.turn.payload.claimInformationId),
        });
        expect(decisions[0]!.references).toContainEqual({
          relation: "core:uses-context",
          informationId: completed[0]!.informationId,
        });
        expect(intents).toHaveLength(1);
        expect(intents[0]!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: decisions[0]!.informationId,
        });
        expect(intents[0]!.payload.turn).toMatchObject({
          contextInformationId: context.turn.informationId,
          candidateInformationId: context.turn.payload.candidateInformationId,
          claimInformationId: context.turn.payload.claimInformationId,
        });
        expect(intents[0]!.payload.target).toMatchObject({
          platform: "web",
          adapterId: "web.ui.main",
          destination: {
            kind: "web",
            conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
          },
        });
        for (const reference of [
          {
            relation: "agent:turn-candidate",
            informationId: String(context.turn.payload.candidateInformationId),
          },
          {
            relation: "agent:turn-claim",
            informationId: String(context.turn.payload.claimInformationId),
          },
          {
            relation: "core:uses-context",
            informationId: context.turn.informationId,
          },
        ])
          expect(intents[0]!.references).toContainEqual(reference);
        for (const atom of [
          requested[0]!,
          completed[0]!,
          decisions[0]!,
          intents[0]!,
        ]) {
          const reference = atom.references.find(
            (ref) => ref.relation === "core:context",
          );
          if (reference)
            expect(reference.informationId).toBe(ids.runtimeContext);
        }
        ids.lightDecision = decisions[0]!.informationId;
        ids.heavyIntent = intents[0]!.informationId;
        intent = intents[0]!;
      },
    );
    return intent;
  };
  const scheduledHeavy = async (input: { text: string; requestId?: string }) =>
    heavyForTurn(await observedTurn(input));
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
    manager,
    registerCleanup,
    cleanupNow: async () => {
      const errors = await drainFixtureCleanups(cleanupOwner);
      if (errors.length)
        throw new AggregateError(errors, "controlled fixture cleanup failed");
    },
    mcpPids: () =>
      [...ownedMcp].flatMap((owner) =>
        owner
          .status()
          .flatMap((status) => (status.pid === null ? [] : [status.pid])),
      ),
    waiter,
    causalTurn,
    observedTurn,
    heavyForTurn,
    lightState,
    scheduledHeavy,
    diagnostics,
    update: async (
      next: Record<string, unknown>,
      options: { allowStopped?: boolean } = {},
    ) => {
      const value = { protocol: "2025-11-25", ...flags, ...next };
      await writeFile(state, JSON.stringify(value));
      return applySyntheticControl(journal, value, options);
    },
    start,
    db,
    logs,
    root,
    scope,
    get server() {
      return server!;
    },
    clearServer() {
      server = undefined;
    },
  };
}
it.each(["stdio", "http"] as const)(
  "runs production Server/Heavy/W3 through actual MCP %s and preserves the original call identity",
  async (mode) => {
    const f = await fixture(mode);
    const server = await f.start();
    expect(server.runtime).toBeDefined();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        authorization: "Bearer synthetic-gateway",
        "x-request-id": "mcp-request",
      },
      payload: {
        text: "Run synthetic tool",
        conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
      },
    });
    expect(response.statusCode).toBe(202);
    const wait = f.waiter();
    let runInformationId: unknown;
    let assistantInformationId: string;
    await f.scheduledHeavy({
      text: "Run synthetic tool",
      requestId: response.json().data.requestId,
    });
    expect(
      await f.db.information.find({
        kinds: ["agent.router.message.intent.requested"],
        limit: 10,
      }),
    ).toHaveLength(1);
    await wait(
      "MCP receipt persisted and follow-up Heavy started",
      async () => {
        const receipts = await f.db.information.find({
          kinds: ["agent.heavy.tool.result.v1"],
          limit: 10,
        });
        expect(receipts).toHaveLength(1);
        runInformationId = receipts[0]!.payload.runInformationId;
        expect(receipts[0]!.payload.toolCallId).toBe("mcp-model-original");
        expect(receipts[0]!.payload.value).toMatchObject({
          status: "succeeded",
          evidence: "returned",
          result: {
            source: { scope: f.scope, trust: "untrusted-mcp-data" },
            requests: [
              { method: "tools/call", modelToolCallId: "mcp-model-original" },
            ],
          },
        });
        expect(models.heavy).toBe(2);
      },
    );
    // 三个顺序阶段各继承既有 8 秒预算；模型请求启动、最终持久化和出站交付是不同边界。
    await wait(
      "matching native final, model completion and assistant persisted",
      async () => {
        const terminals = (
          await f.db.information.find({
            kinds: ["agent.heavy.tool.terminal.v1"],
            limit: 10,
          })
        ).filter((atom) => atom.payload.runInformationId === runInformationId);
        expect(terminals).toHaveLength(1);
        expect(terminals[0]!.payload.reason).toBe("final");
        const finalResult = terminals[0]!.payload.modelResult as any;
        const completed = await f.db.information.get(
          finalResult.terminalInformationId,
        );
        expect(completed?.kind).toBe("core.model.task.completed");
        const assistants = await f.db.information.find({
          kinds: ["core.message.assistant.text"],
          limit: 10,
        });
        expect(assistants).toHaveLength(1);
        expect(assistants[0]!.payload.text).toBe("MCP completed");
        expect(assistants[0]!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: completed!.informationId,
        });
        assistantInformationId = assistants[0]!.informationId;
      },
    );
    await wait(
      "Heavy reply durably delivered and persistence settled",
      async () => {
        const deliveries = await f.db.information.find({
          kinds: ["core.delivery.delivered"],
          limit: 10,
        });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.payload.ok).toBe(true);
        const requestId = deliveries[0]!.references.find(
          (reference) => reference.relation === "core:status-of",
        )!.informationId;
        const request = await f.db.information.get(requestId);
        expect(request?.kind).toBe("core.delivery.requested");
        expect(request!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: assistantInformationId,
        });
        await expectPersistenceSettled(f.db);
      },
    );
    // 队列收敛后只读一次正式 HTTP 历史，避免把持久化轮询变成受限流的重复请求。
    const history = await server.app.inject({
      method: "GET",
      url: "/api/v1/messages?conversationId=47d34f33-c005-45e1-bae4-06df09bd9dc1",
      headers: { authorization: "Bearer synthetic-gateway" },
    });
    expect(history.statusCode).toBe(200);
    expect(
      history
        .json()
        .data.messages.filter((message: any) => message.role === "assistant"),
    ).toEqual([
      expect.objectContaining({ role: "assistant", text: "MCP completed" }),
    ]);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    const read = await server.app.inject({
      method: "POST",
      url: "/api/mcp/read",
      headers: { authorization: "Bearer synthetic-gateway" },
      payload: {
        kind: "resource",
        connectionId: "synthetic",
        scope: f.scope,
        uri: "fixture://allowed/item",
      },
    });
    expect(read.statusCode).toBe(200);
    const denied = await server.app.inject({
      method: "POST",
      url: "/api/mcp/read",
      payload: {
        kind: "prompt",
        connectionId: "synthetic",
        scope: f.scope,
        name: "summarize",
        arguments: { topic: "synthetic" },
      },
    });
    expect(denied.statusCode).toBe(401);
    expect(
      (await f.logs()).filter((row) => row.method === "prompts/get"),
    ).toHaveLength(0);
    const prompt = await server.app.inject({
      method: "POST",
      url: "/api/mcp/read",
      headers: { authorization: "Bearer synthetic-gateway" },
      payload: {
        kind: "prompt",
        connectionId: "synthetic",
        scope: f.scope,
        name: "summarize",
        arguments: { topic: "synthetic" },
      },
    });
    expect(prompt.statusCode).toBe(200);
    const action = (
      await f.db.sql.query<{ intent_id: string; scope: string }>(
        "SELECT intent_id FROM information_action_heads LIMIT 1",
      )
    ).rows[0]!;
    const saved = await f.db.actions.read(action.intent_id, f.scope);
    expect(saved.state).toBe("succeeded");
    expect(
      models.requests
        .filter((request) => request.model === "heavy")[1]
        .messages.some(
          (message: any) =>
            message.role === "tool" &&
            message.tool_call_id === "mcp-model-original",
        ),
    ).toBe(true);
    const pid = (await f.logs()).find((row) => row.kind === "start").pid;
    await server.close();
    f.clearServer();
    if (mode === "stdio") expect(() => process.kill(pid, 0)).toThrow();
  },
  serverFixtureBudget({ stages: 6, reads: 2 }),
);
it(
  "keeps same-scope chat on Heavy and runs an idempotent management GUI task with original image continuation",
  async () => {
    const f = await fixture("stdio");
    const config = {
      version: 1 as const,
      revision: "gui-test",
      bindings: [
        {
          scope: f.scope,
          environmentId: "desktop",
          workflowId: "gui-flow",
          gui: true,
          guiModel: {
            routeId: "gui.explicit",
            providerId: "synthetic",
            modelId: "vision",
          },
        },
      ],
    };
    await writeSensitiveJson(join(f.root, "linux-tools.json"), config);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const hash = createHash("sha256").update(png).digest("hex");
    let artifact: any,
      executions = 0;
    const control = (state = "ready") => ({
      environmentId: "desktop",
      scope: f.scope,
      generation: 1,
      state,
    });
    const environment = () => ({
      environmentId: "desktop",
      generation: 1,
      workspaceId: "workspace",
      workflowId: "gui-flow",
      resourceIds: [],
      leaseId: "lease",
      fencing: "1",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
    // 只替换 broker RPC；Host 目录/绑定、W3、持久原图装配和最终 SDK wire 均走生产实现。
    const linux = new LinuxToolsHost(
      config,
      new LinuxEnvironmentClient(async (method, params) => {
        if (method === "environment.inspect") return control();
        if (method === "lease.acquire")
          return {
            environment: environment(),
            token: "synthetic-private-lease-secret-123456",
          };
        if (method === "lease.renew") return environment();
        if (method === "lease.validate") return { valid: true };
        if (method === "lease.release") return control("quarantined");
        if (method === "artifact.read")
          return { artifact, dataBase64: png.toString("base64") };
        if (method === "operation.execute") {
          executions++;
          expect(params.toolName).toBe("gui.observe");
          artifact = {
            id: "gui-original",
            hash,
            mime: "image/png",
            size: png.length,
            scope: f.scope,
            actionId: params.intentId,
            generation: 1,
            observedAt: "2026-10-25T00:00:00.000Z",
            source: "environment-helper",
            retention: "explicit-delete-only",
          };
          return {
            status: "succeeded",
            evidence: "returned",
            artifacts: [artifact],
            truncated: false,
            result: {
              observation: {
                id: "a".repeat(64),
                environmentId: "desktop",
                workflowId: "gui-flow",
                generation: 1,
              },
              image: {
                captureId: "original",
                coordinateFrame: "desktop",
                width: 1,
                height: 1,
                originalWidth: 1,
                originalHeight: 1,
                scale: 1,
                origin: { x: 0, y: 0 },
                target: { kind: "desktop" },
                sha256: hash,
                mime: "image/png",
                capturedAt: "2026-10-25T00:00:00.000Z",
                serviceInstanceId: "service",
                driverInstanceId: "driver",
              },
            },
          };
        }
        throw new Error("unexpected synthetic broker method " + method);
      }),
    );
    f.registerCleanup("Linux fixture", cleanupLimits.auxiliary, () =>
      linux.close(),
    );
    const snapshot = LinuxToolsHost.prototype.snapshot;
    vi.spyOn(LinuxToolsHost.prototype, "snapshot").mockImplementation(() =>
      snapshot.call(linux),
    );
    const server = await f.start();
    const headers = { authorization: "Bearer synthetic-gateway" };
    const chatResponse = await server.app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers,
      payload: {
        text: "ordinary chat",
        conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
      },
    });
    expect(chatResponse.statusCode).toBe(202);
    const wait = f.waiter(() => ({ executions }));
    await f.scheduledHeavy({
      text: "ordinary chat",
      requestId: chatResponse.json().data.requestId,
    });
    expect(
      await f.db.information.find({
        kinds: ["agent.router.message.intent.requested"],
        limit: 10,
      }),
    ).toHaveLength(1);
    await wait("same-scope ordinary chat delivered", async () => {
      expect(
        await f.db.information.find({
          kinds: ["core.delivery.delivered"],
          limit: 10,
        }),
      ).toHaveLength(1);
    });
    const chatRequests = models.requests.filter((r) => r.model === "heavy");
    expect(chatRequests).toHaveLength(2);
    expect(models.gui).toBe(0);
    expect(
      chatRequests.every((r) =>
        r.tools.every(
          (t: any) =>
            !["gui.observe", "gui.act", "gui.verify"].some(
              (id) => nativeToolWireName(id, "1") === t.function.name,
            ),
        ),
      ),
    ).toBe(true);
    const url = "/api/v1/environments/desktop/tasks",
      input = { taskRequestId: randomUUID(), prompt: "inspect the desktop" };
    expect(
      (await server.app.inject({ method: "POST", url, payload: input }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...input, nativeStep: {} },
        })
      ).statusCode,
    ).toBe(400);
    const accepted = await server.app.inject({
      method: "POST",
      url,
      headers,
      payload: input,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await server.app.inject({
          method: "POST",
          url,
          headers,
          payload: input,
        })
      ).json().requestedInformationId,
    ).toBe(accepted.json().requestedInformationId);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...input, prompt: "different" },
        })
      ).statusCode,
    ).toBe(409);
    await wait(
      "GUI result and original image continuation persisted",
      async () => {
        const state = await server.app.inject({
          method: "GET",
          url: url + "/" + input.taskRequestId,
          headers,
        });
        expect(state.json().status).toBe("completed");
      },
    );
    expect(executions).toBe(1);
    expect(models.gui).toBe(2);
    expect(models.heavy).toBe(2);
    const vision = models.requests.filter((r) => r.model === "vision");
    expect(JSON.stringify(vision[1].messages)).toContain(
      "data:image/png;base64," + png.toString("base64"),
    );
    expect(
      vision[1].messages.some(
        (m: any) =>
          m.role === "tool" && m.tool_call_id === "gui-model-original",
      ),
    ).toBe(true);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url,
          headers,
          payload: input,
        })
      ).json().status,
    ).toBe("completed");
    await wait("management task queue settled", () =>
      expectPersistenceSettled(f.db),
    );
    await server.close();
    f.clearServer();
  },
  serverFixtureBudget({ stages: 6 }),
);

it(
  "still closes MCP when the Runtime cleanup reports a failure",
  async () => {
    const f = await fixture("stdio");
    const server = await f.start();
    const pid = (await f.logs()).find((row) => row.kind === "start").pid;
    const original = server.runtime!.close.bind(server.runtime);
    vi.spyOn(server.runtime!, "close").mockImplementationOnce(
      async (options) => {
        await original(options);
        throw new Error("synthetic cleanup failure");
      },
    );
    await expect(server.close()).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
    f.clearServer();
  },
  serverFixtureBudget({}),
);
it(
  "retains a failed MCP cleanup owner for a later shutdown attempt",
  async () => {
    const f = await fixture("stdio");
    const server = await f.start();
    const original = McpHost.prototype.close;
    let attempts = 0;
    const close = vi
      .spyOn(McpHost.prototype, "close")
      .mockImplementation(function (this: McpHost) {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error("synthetic close failure"))
          : original.call(this);
      });
    await expect(server.close()).rejects.toThrow();
    await server.close();
    expect(close).toHaveBeenCalledTimes(2);
    f.clearServer();
  },
  serverFixtureBudget({ closes: 2 }),
);

it(
  "reaps MCP after a partial Runtime startup failure",
  async () => {
    const f = await fixture("stdio");
    vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
      new Error("synthetic start failure"),
    );
    const server = await f.start();
    expect(server.runtime).toBeUndefined();
    const pid = (await f.logs()).find((row) => row.kind === "start").pid;
    expect(() => process.kill(pid, 0)).toThrow();
  },
  serverFixtureBudget({}),
);
it(
  "keeps a candidate MCP owner when Runtime rebuild and candidate cleanup both fail",
  async () => {
    const f = await fixture("stdio");
    const server = await f.start();
    const original = McpHost.prototype.close;
    let failed: McpHost | undefined;
    const calls = new Map<McpHost, number>();
    let ordinal = 0;
    vi.spyOn(McpHost.prototype, "close").mockImplementation(function (
      this: McpHost,
    ) {
      const count = (calls.get(this) ?? 0) + 1;
      calls.set(this, count);
      if (count === 1 && ++ordinal === 2) {
        failed = this;
        return Promise.reject(new Error("synthetic candidate cleanup failure"));
      }
      return original.call(this);
    });
    vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
      new Error("synthetic rebuild failure"),
    );
    const id = f.manager.getSelectedProfileId();
    const profile = await f.manager.getProfile(id);
    await f.manager.replaceProfile(id, {
      name: profile.name,
      acknowledgedWarnings: [],
      identity: { timeZone: "UTC" },
      ai: profile.ai,
      ...(profile.runtime ? { runtime: profile.runtime } : {}),
    });
    const status = await server.app.inject({
      method: "GET",
      url: "/api/v1/configuration/status",
      headers: { authorization: "Bearer synthetic-gateway" },
    });
    const selected = status.json().data;
    const applied = await server.app.inject({
      method: "POST",
      url: "/api/v1/configuration/apply",
      headers: { authorization: "Bearer synthetic-gateway" },
      payload: {
        selectedProfileId: selected.selectedProfileId,
        revision: selected.selectedRevision,
      },
    });
    expect(applied.json()).toMatchObject({
      data: { status: "failed", errorCode: "shutdown_failed" },
    });
    expect(failed).toBeDefined();
    expect(calls.get(failed!)).toBe(1);
    const pids = (await f.logs())
      .filter((row) => row.kind === "start")
      .map((row) => row.pid);
    expect(pids).toHaveLength(2);
    await server.close();
    f.clearServer();
    expect(calls.get(failed!)).toBe(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  },
  serverFixtureBudget({ setups: 2, closes: 2 }),
);

it.each(["before-unknown", "after-unknown"] as const)(
  "persists a scoped late observation %s without changing the W3 head or repeating the effect",
  async (order) => {
    const f = await fixture("stdio", { hold: true });
    let host!: McpHost;
    const snapshot = McpHost.prototype.snapshot;
    vi.spyOn(McpHost.prototype, "snapshot").mockImplementation(function (
      this: McpHost,
    ) {
      host = this;
      return snapshot.call(this);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = f.db.actions.finish.bind(f.db.actions);
    vi.spyOn(f.db.actions, "finish").mockImplementation(async (...args) => {
      if (order === "before-unknown" && args[2].status === "unknown")
        await gate;
      return finish(...args);
    });
    let commitThenFail = order === "after-unknown";
    let committed: any;
    const append = f.db.information.append.bind(f.db.information);
    vi.spyOn(f.db.information, "append").mockImplementation(
      async (atom, ...rest) => {
        await append(atom, ...rest);
        if (atom.kind === mcpLateResultInformationKind.kind) {
          committed = atom;
          if (commitThenFail) {
            commitThenFail = false;
            throw new Error("synthetic error after committed evidence");
          }
        }
      },
    );
    await withModelGateCleanup(
      async () => {
        const server = await f.start();
        const response = await server.app.inject({
          method: "POST",
          url: "/api/v1/messages",
          headers: { authorization: "Bearer synthetic-gateway" },
          payload: {
            text: "Run synthetic held tool",
            conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
          },
        });
        expect(response.statusCode).toBe(202);
        const wait = f.waiter();
        let action!: Awaited<ReturnType<typeof f.db.actions.read>>;
        await f.scheduledHeavy({
          text: "Run synthetic held tool",
          requestId: response.json().data.requestId,
        });
        expect(
          await f.db.information.find({
            kinds: ["agent.router.message.intent.requested"],
            limit: 10,
          }),
        ).toHaveLength(1);
        await wait("MCP side effect has started", async () => {
          expect(
            (await f.logs()).filter((row) => row.kind === "effect"),
          ).toHaveLength(1);
          const row = (
            await f.db.sql.query<{ intent_id: string }>(
              "SELECT intent_id FROM information_action_heads LIMIT 1",
            )
          ).rows[0]!;
          action = await f.db.actions.read(row.intent_id, f.scope);
          expect(action.state).toBe("started");
        });
        await host.snapshot().actionProviders[0]!.cancel!({
          attemptId: action.attemptId,
        } as ActionExecution);
        if (order === "after-unknown") {
          await wait("transport interruption is durably unknown", async () => {
            expect(
              (await f.db.actions.read(action.intentId, f.scope)).state,
            ).toBe("unknown");
            await expectPersistenceSettled(f.db);
          });
        }
        await f.update({ release: true });
        let observation: any;
        await wait(
          "late result is visible through the scope index",
          async () => {
            const atoms = await f.db.information.find({
              kinds: [mcpLateResultInformationKind.kind],
              scopeKey: f.scope,
              limit: 10,
            });
            expect(atoms).toHaveLength(1);
            observation = atoms[0]!;
          },
        );
        expect(observation.payload.envelope).toMatchObject({
          source: {
            scope: f.scope,
            connectionId: "synthetic",
            connectionRevision: action.intent.target.connectionRevision,
            definitionRevision: action.intent.target.definitionRevision,
          },
          requests: [
            {
              intentId: action.intentId,
              operationId: action.intent.operationId,
              attemptId: action.attemptId,
              modelToolCallId: "mcp-model-original",
            },
          ],
        });
        expect(observation.references).toContainEqual({
          relation: "core:caused-by",
          informationId: action.intentId,
        });
        if (order === "before-unknown")
          expect(
            (await f.db.actions.read(action.intentId, f.scope)).state,
          ).toBe("started");
        release();
        await wait("unknown receipt remains after late evidence", async () => {
          expect(
            (await f.db.actions.read(action.intentId, f.scope)).state,
          ).toBe("unknown");
          await expectPersistenceSettled(f.db);
        });
        const inspectionUrl = `/api/v1/inspection/actions/${action.intentId}`;
        expect(
          (
            await server.app.inject({
              url: `${inspectionUrl}?${new URLSearchParams({ scope: f.scope })}`,
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await server.app.inject({
              url: `${inspectionUrl}?${new URLSearchParams({
                scope: JSON.stringify([
                  "web",
                  "web",
                  "conversation",
                  "88a874b7-bf52-4799-8c2a-6255c20eaa11",
                ]),
              })}`,
              headers: { authorization: "Bearer synthetic-gateway" },
            })
          ).statusCode,
        ).toBe(404);
        const inspection = await server.app.inject({
          url: `${inspectionUrl}?${new URLSearchParams({ scope: f.scope })}`,
          headers: { authorization: "Bearer synthetic-gateway" },
        });
        expect(inspection.statusCode).toBe(200);
        const projected = inspection.json().data;
        expect(projected.action.state).toBe("unknown");
        expect(projected.lateEvidence).toHaveLength(1);
        expect(projected.lateEvidence[0].informationId).toBe(
          observation.informationId,
        );
        expect(projected.lateEvidence[0].responseDigest).toMatch(
          /^canonical-json-v1:sha256:[a-f0-9]{64}$/,
        );
        expect(projected.lateEvidence[0].requests.value[0]).toMatchObject({
          intentId: action.intentId,
          operationId: action.intent.operationId,
          attemptId: action.attemptId,
          modelToolCallId: "mcp-model-original",
        });
        const originalHead = await f.db.actions.read(action.intentId, f.scope);
        // 模拟 append 已提交但调用方报错：相同事实重试只读取同 ID，不新增事实。
        await createMcpLateResultRecorder(f.db)(
          committed.payload.envelope,
          committed.informationId,
        );
        expect(await f.db.actions.read(action.intentId, f.scope)).toEqual(
          originalHead,
        );
        expect(
          await f.db.information.find({
            kinds: [mcpLateResultInformationKind.kind],
            scopeKey: f.scope,
            limit: 10,
          }),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
        await server.close();
        f.clearServer();
      },
      release,
      () => f.update({ release: true }, { allowStopped: true }),
    );
  },
  serverFixtureBudget({ stages: 7, controls: 2 }),
);

it(
  "keeps same-turn Light readiness false until its controlled response is released",
  async () => {
    const f = await fixture("stdio");
    const server = await f.start();
    const wait = f.waiter();
    let release!: () => void;
    let entered = false;
    let observer: Promise<FixtureAtom> | undefined;
    let observed: Promise<PromiseSettledResult<FixtureAtom>[]> | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drain = async () => {
      const results = await observed;
      if (results?.[0]?.status === "rejected") throw results[0].reason;
    };
    // 在触发模型前登记兜底；正文断言失败或timeout也先释放gate，再独立等待observer。
    f.registerCleanup(
      "Light gate release and observer settle",
      cleanupLimits.observer,
      async () => {
        release();
        await drain();
      },
    );
    models.lightGate = async (body) => {
      if (JSON.stringify(body.messages).includes("controlled Light handoff")) {
        entered = true;
        await gate;
      }
    };
    await withModelGateCleanup(
      async () => {
        const response = await server.app.inject({
          method: "POST",
          url: "/api/v1/messages",
          headers: {
            authorization: "Bearer synthetic-gateway",
            "x-request-id": "controlled-light-request",
          },
          payload: {
            text: "controlled Light handoff",
            conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
          },
        });
        expect(response.statusCode).toBe(202);
        const context = await f.observedTurn({
          text: "controlled Light handoff",
          requestId: "controlled-light-request",
        });
        await wait("controlled Light fetch entered", () =>
          expect(entered).toBe(true),
        );
        await wait(
          "shared readiness predicate inspected held Light",
          async () => {
            const state = await f.lightState(context);
            expect(state.progress).toEqual({
              requested: 1,
              completed: 0,
              decisions: 0,
              intents: 0,
            });
            expect(state.ready).toBe(false);
          },
        );
        expect(models.heavy).toBe(0);
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(0);
        release();
        // 完成等待从release后重新计时，不借用held观察阶段的8秒。
        observer = f.heavyForTurn(context);
        observed = Promise.allSettled([observer]);
        const intent = await observer;
        expect(intent.payload.turn.contextInformationId).toBe(
          context.turn.informationId,
        );
        await wait("controlled MCP receipt persisted", async () => {
          const results = await f.db.information.find({
            kinds: ["agent.heavy.tool.result.v1"],
            limit: 10,
          });
          expect(results).toHaveLength(1);
          expect(results[0]!.payload.toolCallId).toBe("mcp-model-original");
        });
        await wait("controlled native final persisted", async () => {
          const final = await f.db.information.find({
            kinds: ["agent.heavy.tool.terminal.v1"],
            limit: 10,
          });
          expect(final).toHaveLength(1);
          expect(final[0]!.payload.reason).toBe("final");
        });
        await wait("controlled reply delivered and queue settled", async () => {
          expect(
            await f.db.information.find({
              kinds: ["core.delivery.delivered"],
              limit: 10,
            }),
          ).toHaveLength(1);
          await expectPersistenceSettled(f.db);
        });
        expect(models.heavy).toBe(2);
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
        await server.close();
        f.clearServer();
      },
      release,
      drain,
    );
  },
  serverFixtureBudget({ stages: 8 }),
);

it(
  "retains same-fixture diagnostics and reaps the actual stdio owner when auxiliary cleanup fails and Server.close is blocked",
  async () => {
    const f = await fixture("stdio", {}, { serverCloseMs: 100 });
    const server = await f.start();
    const pids = f.mcpPids();
    expect(pids).toHaveLength(1);
    const close = server.close.bind(server);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let originalWork: Promise<unknown> | undefined;
    vi.spyOn(server, "close").mockImplementationOnce(() => {
      originalWork = gate.then(() => close());
      return originalWork as Promise<void>;
    });
    f.registerCleanup(
      "controlled auxiliary",
      cleanupLimits.auxiliary,
      async () => {
        throw new Error("synthetic auxiliary cleanup failure");
      },
    );
    const work = f.cleanupNow();
    const observed = Promise.allSettled([
      cleanupAttempt("probe cleanup result", cleanupLimits.hook, () => work),
    ]);
    let confirmed = false;
    const failures: unknown[] = [];
    try {
      try {
        await f.waiter()(
          "actual stdio owner exited independently of blocked Server.close",
          () => {
            expect(() => process.kill(pids[0]!, 0)).toThrow();
          },
        );
      } catch (error) {
        failures.push(error);
      } finally {
        release();
        try {
          await cleanupAttempt(
            "probe original Server.close settlement",
            cleanupLimits.settlement,
            async () => {
              await originalWork;
            },
          );
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures.splice(0),
          "probe observation and release failed",
        );
      const [result] = await observed;
      expect(result!.status).toBe("rejected");
      const error = (result as PromiseRejectedResult).reason as AggregateError;
      const messages = (value: unknown): string[] =>
        value instanceof Error
          ? [
              value.message,
              ...(value instanceof AggregateError
                ? value.errors.flatMap(messages)
                : []),
              ...messages(value.cause),
            ]
          : [];
      expect(error.errors).toHaveLength(2);
      expect(messages(error).join("\n")).toContain(
        "synthetic auxiliary cleanup failure",
      );
      expect(messages(error).join("\n")).toContain(
        "Server.close unconfirmed after 100ms",
      );
      expect(f.diagnostics().databaseClosed).toBe(true);
      expect((await stat(f.root)).isDirectory()).toBe(true);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      confirmed = true;
    } catch (error) {
      failures.push(error);
    } finally {
      release();
      for (const [phase, budgetMs, run] of [
        [
          "probe final Server.close settlement",
          cleanupLimits.settlement,
          async () => {
            await originalWork;
          },
        ],
        [
          "probe final cleanup result",
          cleanupLimits.hook,
          async () => {
            await observed;
          },
        ],
      ] as const) {
        try {
          await cleanupAttempt(phase, budgetMs, run);
        } catch (error) {
          failures.push(error);
        }
      }
      // 探针确认全部真实资源已退出后，才移除有意触发的诊断目录；未知释放保留目录。
      if (confirmed && !failures.length) {
        try {
          await cleanupAttempt(
            "confirmed probe files",
            cleanupLimits.files,
            () => rm(f.root, { recursive: true, force: true }),
          );
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "controlled cleanup probe failed");
  },
  serverFixtureBudget({ stages: 1, closes: 0, drains: 2 }) +
    2 * cleanupLimits.settlement,
);

it(
  "retains diagnostics for an earlier same-fixture cleanup failure without retaining an unrelated fixture directory",
  async () => {
    // 两个独立真实DB/file fixture均不启动Server；本例只验证cleanup owner传播边界。
    const failed = await fixture("stdio");
    failed.registerCleanup(
      "controlled auxiliary retention",
      cleanupLimits.auxiliary,
      async () => {
        throw new Error("synthetic prior cleanup failure");
      },
    );
    const [result] = await Promise.allSettled([failed.cleanupNow()]);
    let confirmed = false;
    try {
      expect(result!.status).toBe("rejected");
      const error = (result as PromiseRejectedResult).reason as AggregateError;
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0].cause.message).toBe(
        "synthetic prior cleanup failure",
      );
      expect(failed.diagnostics().databaseClosed).toBe(true);
      expect((await stat(failed.root)).isDirectory()).toBe(true);
      const unrelated = await fixture("stdio");
      await unrelated.cleanupNow();
      expect(unrelated.diagnostics().databaseClosed).toBe(true);
      await expect(stat(unrelated.root)).rejects.toMatchObject({
        code: "ENOENT",
      });
      confirmed = true;
    } finally {
      if (confirmed)
        await cleanupAttempt(
          "confirmed retention probe files",
          cleanupLimits.files,
          () => rm(failed.root, { recursive: true, force: true }),
        );
    }
  },
  2 *
    (fixtureLimits.filesAndDatabase +
      cleanupLimits.database +
      cleanupLimits.files) +
    cleanupLimits.auxiliary +
    fixtureLimits.localIo,
);
