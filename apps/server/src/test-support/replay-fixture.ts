/**
 * 功能概述：W11 多人重放的真实 Server/Adapter/Identity/Memory/Heavy/W3/MCP 夹具。
 * createReplayFixture 只替换模型 HTTP、数据库连接工厂和 QQ 发送边界；stdio 服务独立运行并记录 effect。
 * submit 经 AdapterHost.ingress；restart 关闭 Runtime/MCP 与 PG pool 后重连同 schema，不预填业务事实。
 * wait 为每个绑定 ID 的阶段记录实际耗时；gate 在失败清理前释放，close 逆序尝试所有资源并保留错误。
 * 代码库关系：issue279-replay.test.ts 提供确定性模型响应；复用 MCP testing 与 persistence helper，
 * 输出可选证据文件明确区分 scripted 模型、真实 SQL、真实 MCP 传输及尚未运行的物理 GUI。
 * readReplaySourceState 在每例开始和清理后记录源码身份；证据不能把执行期间变更过的输入标成最终验收。
 * wait 默认等待一个持久阶段；同一次确认包含多个冻结页时按页数累加原 8 秒预算，并记录实际预算。
 */
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, expect } from "vitest";
import { KaguyaDatabase } from "@kaguya/database";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
  type PostgresTestingDatabaseScope,
} from "@kaguya/database/testing";
import {
  FileUserConfigManager,
  loadModuleInstanceConfigs,
  writeSensitiveJson,
} from "@kaguya/config";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { KaguyaRuntime } from "@kaguya/runtime";
import { McpHost } from "@kaguya/mcp";
import {
  applySyntheticControl,
  syntheticServerSource,
} from "@kaguya/mcp/testing";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
import { startKaguyaServer, type StartedKaguyaServer } from "../server.js";
import {
  createPersistenceWait,
  persistenceWait,
  expectPersistenceSettled,
} from "./persistence.js";

export const replayScenario = {
  version: 1,
  people: ["甲", "乙", "丙"],
  groups: ["G", "H"],
  prefix: [
    "甲提议周六活动",
    "乙表示周六值班",
    "丙插话询问午饭",
    "甲建议公园",
    "乙准备确认排班",
    "丙补充路线",
    "甲询问天气",
    "乙稍后确认",
  ],
  correction: "乙更正：已经调班，周六可以参加活动",
} as const;
export const replayScope = (group = "G", adapter = "replay.qq") =>
  JSON.stringify(["qq", adapter, "group", group]);
export type ReplayResponse = (
  body: any,
  fixture: ReplayFixture,
) => Promise<any>;
export interface ReplayFixture {
  backend: "PGlite" | "PostgreSQL";
  root: string;
  requests: any[];
  sent: any[];
  spans: any[];
  gates: Array<() => void>;
  active: Set<Promise<unknown>>;
  readonly db: KaguyaDatabase;
  readonly server: StartedKaguyaServer;
  facts(kind: string): ReturnType<KaguyaDatabase["information"]["find"]>;
  wait<T>(
    phase: string,
    assertion: () => T | Promise<T>,
    stages?: number,
  ): Promise<T>;
  logs(): Promise<any[]>;
  message(
    id: string,
    text: string,
    group?: string,
    actor?: string,
    adapter?: string,
    occurredAt?: string,
  ): PlatformInboundMessage;
  submit(
    input: PlatformInboundMessage,
  ): Promise<
    Awaited<
      ReturnType<StartedKaguyaServer["adapterHost"]["ingress"]["submit"]>
    > & { inboundInformationId: string }
  >;
  update(
    flags: Record<string, unknown>,
  ): ReturnType<typeof applySyntheticControl>;
  get(
    path: string,
    group?: string,
    extra?: Record<string, string>,
  ): Promise<{ statusCode: number; json(): any; body: string }>;
  settled(): Promise<void>;
  restart(): Promise<void>;
  complete(ids: string[]): void;
  close(): Promise<void>;
}
export const replayCleanupBudget = 120_000;
export const replayBudget = (stages: number, restarts = 0) =>
  90_000 + stages * 8_000 + restarts * 60_000 + replayCleanupBudget;
async function readReplaySourceState() {
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        "apps/server/src/test-support/replay-fixture.ts",
        "apps/server/src/issue279-replay.test.ts",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  const git = (args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", timeout: 2_000 }).trim();
  return {
    headSha: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"])),
    sourceHashes,
  };
}
async function boundedReplay<T>(
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
          () =>
            reject(
              new Error(`Replay ${phase} not confirmed after ${budgetMs}ms`),
            ),
          budgetMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createReplayFixture(
  backend: "PGlite" | "PostgreSQL",
  installHttp: (fetch: typeof globalThis.fetch) => void,
  response: ReplayResponse,
) {
  const sourceBefore = await readReplaySourceState();
  const startedAt = performance.now();
  const root = await mkdtemp(join(tmpdir(), "kaguya-replay-"));
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const mcpOwners = new Set<McpHost>();
  const ownedRuntimeClose = KaguyaRuntime.prototype.close;
  const ownedMcpClose = McpHost.prototype.close;
  const script = join(root, "mcp.mjs"),
    state = join(root, "state.json"),
    journal = join(root, "journal.jsonl");
  let db!: KaguyaDatabase;
  let schema: PostgresTestingDatabaseScope | undefined;
  let runtimeOwner: KaguyaRuntime | undefined;
  let fixture: ReplayFixture | undefined;
  const ingressEvidence: unknown[] = [];
  let controlState: Record<string, unknown> = { protocol: "2025-11-25" };
  const realClose = new Map<KaguyaDatabase, () => Promise<void>>();
  const gates: Array<() => void> = [];
  const active = new Set<Promise<unknown>>();
  const requests: any[] = [],
    sent: any[] = [],
    spans: any[] = [];
  let server: StartedKaguyaServer | undefined;
  let closed = false,
    passed = false;
  let assertions: string[] = [];
  const cleanupPhases: { phase: string; status: string }[] = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    async function attempt(
      phase: string,
      budget: number,
      run: () => Promise<unknown>,
    ) {
      try {
        await boundedReplay(phase, budget, run);
        cleanupPhases.push({ phase, status: "confirmed" });
      } catch (error) {
        cleanupPhases.push({ phase, status: "unconfirmed" });
        errors.push(error);
      }
    }
    for (const release of gates)
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    if (mcpOwners.size)
      await attempt("release actual MCP test barriers", 2_000, () =>
        applySyntheticControl(
          journal,
          { ...controlState, release: true },
          { allowStopped: true },
        ),
      );
    await attempt("Server close", 20_000, async () => {
      await server?.close();
    });
    await attempt("Runtime owner close", 20_000, async () => {
      if (runtimeOwner) await ownedRuntimeClose.call(runtimeOwner);
    });
    await attempt("independent MCP owners close", 8_000, async () => {
      const outcomes = await Promise.allSettled(
        [...mcpOwners].map((host) => ownedMcpClose.call(host)),
      );
      const failures = outcomes
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason);
      if (failures.length)
        throw new AggregateError(failures, "MCP owners cleanup failed");
    });
    await attempt("model HTTP observers settle", 16_000, async () => {
      while (active.size) {
        const outcomes = await Promise.allSettled([...active]);
        for (const result of outcomes)
          if (result.status === "rejected") throw result.reason;
      }
    });
    let persisted: unknown = null;
    await attempt("read-only evidence snapshot", 8_000, async () => {
      if (!db) return;
      const observations = await db.sql.query<{ observation_id: string }>(
        "SELECT observation_id FROM information_observations ORDER BY recorded_at,observation_id",
      );
      const actions = await db.sql.query(
        "SELECT intent_id,input,state,attempt_id,receipt_id,cancellation_id FROM information_action_heads ORDER BY intent_id",
      );
      persisted = {
        observations: await Promise.all(
          observations.rows.map((r) => db.observations.read(r.observation_id)),
        ),
        actions: actions.rows,
        facts: await db.information.find({
          kinds: [
            "core.message.inbound.text",
            "memory.identity.person.context.completed",
            "memory.native.source.v1",
            "memory.native.formation.requested.v1",
            "memory.native.formation.completed.v1",
            "memory.native.revision.v1",
            "agent.situation.frozen",
            "core.model.task.requested",
            "core.model.task.completed",
            "core.model.task.failed",
            "agent.heavy.tool.run.v1",
            "agent.heavy.tool.step.frozen.v1",
            "agent.heavy.tool.result.v1",
            "agent.heavy.tool.terminal.v1",
            "core.message.assistant.text",
            "core.delivery.requested",
            "core.delivery.delivered",
            "core.delivery.failed",
            "core.action.intent.v1",
            "core.action.started.v1",
            "core.action.result.v1",
            "mcp.client.late-result.v1",
          ],
          limit: 10_000,
          registrationOrder: true,
        }),
      };
    });
    let oracle: unknown[] = [];
    await attempt("MCP journal read", 5_000, async () => {
      const raw = await readFile(journal, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      oracle = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((r) =>
          ["start", "effect", "returned", "request", "worker"].includes(r.kind),
        );
    });
    await attempt("SQL connection close", 10_000, async () => {
      if (db) await realClose.get(db)?.();
    });
    await attempt("PostgreSQL schema cleanup", 10_000, async () => {
      await schema?.close();
    });
    if (!errors.length)
      await attempt("fixture directory removal", 5_000, () =>
        rm(root, { recursive: true, force: true }),
      );
    if (process.env.KAGUYA_REPLAY_EVIDENCE_DIR)
      await attempt("evidence manifest write", 5_000, async () => {
        const directory = process.env.KAGUYA_REPLAY_EVIDENCE_DIR!;
        await mkdir(directory, { recursive: true });
        const sourceAfter = await readReplaySourceState();
        const manifest = {
          schemaVersion: 1,
          headSha: sourceAfter.headSha,
          dirty: sourceBefore.dirty || sourceAfter.dirty,
          sourceHashes: sourceAfter.sourceHashes,
          sourceState: { before: sourceBefore, after: sourceAfter },
          backend,
          fixtureSha256: createHash("sha256")
            .update(JSON.stringify(replayScenario))
            .digest("hex"),
          dataClassification: "synthetic",
          producer:
            "AdapterHost.ingress.submit → Runtime/Identity/native Memory/Situation/Heavy/W3",
          ingress: ingressEvidence,
          providers: {
            model: "scripted-http",
            mcp: "actual-stdio-synthetic-service",
            mcpSourceSha256: createHash("sha256")
              .update(syntheticServerSource)
              .digest("hex"),
            physicalGui: "not-run",
            imageDigest: null,
          },
          assertions,
          passed: passed && errors.length === 0,
          phases: spans,
          totalDurationMs: performance.now() - startedAt,
          calls: {
            model: requests.length,
            tool: oracle.filter((r: any) => r.kind === "effect").length,
          },
          usage: {
            source: "synthetic-provider-values",
            inputTokens: requests.every((r) => r.usage !== null)
              ? requests.reduce((n, r) => n + r.usage.inputTokens, 0)
              : null,
            outputTokens: requests.every((r) => r.usage !== null)
              ? requests.reduce((n, r) => n + r.usage.outputTokens, 0)
              : null,
            knownInputTokens: requests.reduce(
              (n, r) => n + (r.usage?.inputTokens ?? 0),
              0,
            ),
            knownOutputTokens: requests.reduce(
              (n, r) => n + (r.usage?.outputTokens ?? 0),
              0,
            ),
            unknownUsageRequests: requests.filter((r) => r.usage === null)
              .length,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cost: null,
          },
          resources: {
            cpuMicroseconds: process.cpuUsage(cpuStart),
            rssStartBytes: rssStart,
            rssEndBytes: process.memoryUsage().rss,
            container: null,
            operatorSteps: null,
          },
          persisted,
          oracle,
          cleanup: {
            phases: [...cleanupPhases],
            modelTasksSettled: active.size === 0,
            directoryRetained: errors.length > 0,
            errors: errors.map(String),
          },
        };
        await writeFile(
          join(directory, `${backend}-${randomUUID()}.json`),
          JSON.stringify(manifest, null, 2),
        );
      });
    if (errors.length)
      throw new AggregateError(
        errors,
        `Replay cleanup failed; diagnostics retained at ${root}`,
      );
  };
  try {
    schema =
      backend === "PostgreSQL"
        ? await createPostgresTestingDatabaseScope(
            process.env.KAGUYA_TEST_DATABASE_URL!,
          )
        : undefined;
    db = schema ? await schema.connect() : await createTestingDatabase();
    // Server owns runtime/MCP, while this fixture retains the SQL scope for explicit reconstruction.
    const protect = () => {
      vi.spyOn(db, "close").mockResolvedValue(undefined);
    };
    realClose.set(db, db.close.bind(db));
    protect();
    vi.spyOn(KaguyaDatabase, "connect").mockImplementation(async () => db);
    const originalStart = KaguyaRuntime.prototype.start;
    vi.spyOn(KaguyaRuntime.prototype, "start").mockImplementation(
      async function (this: KaguyaRuntime) {
        runtimeOwner = this;
        for (const adapterId of ["replay.qq", "replay.other"])
          this.registerTransport({
            adapterId,
            platform: "qq",
            transport: {
              sendMessage: async (target, message) => {
                sent.push({ target, message });
                return {
                  ok: true as const,
                  adapterId,
                  platform: "qq" as const,
                  target,
                  platformMessageId: `replay-out-${sent.length}`,
                  raw: {},
                };
              },
            },
          });
        return originalStart.call(this);
      },
    );
    const openMcp = McpHost.open;
    vi.spyOn(McpHost, "open").mockImplementation(async (...args) => {
      const host = await openMcp.apply(McpHost, args);
      if (args[2]?.ownershipDirectory === join(root, "mcp-processes"))
        mcpOwners.add(host);
      return host;
    });
    const defaults = createFirstPartyModuleConfigDefaults().map((config) => ({
      ...config,
      enabled:
        config.definitionId === "memory.native"
          ? true
          : config.definitionId === "plugin.qq-expression"
            ? false
            : config.enabled,
      settings:
        config.definitionId === "agent.lifecycle"
          ? {
              ...config.settings,
              pulse: { intervalMs: 3600000 },
              observation: {
                ...(config.settings.observation as any),
                interruptQuietMs: 0,
                noActionBackoffBaseMs: 0,
                noActionBackoffCapMs: 0,
              },
            }
          : config.settings,
    }));
    const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
    await loadModuleInstanceConfigs({ rootDir: root, defaults });
    const runtime = {
      host: "127.0.0.1",
      port: 3000,
      databaseMode: "external" as const,
      databaseUrl: "postgresql://synthetic@127.0.0.1/replay",
      webDistPath: join(root, "web"),
      corsOrigins: [],
      trustProxy: false as const,
      rateLimitMax: 10000,
      rateLimitWindowMs: 60000,
      logLevel: "silent" as const,
      logFormat: "json" as const,
      inboundAllowlist: ["qq:group:*"],
      outboundAllowlist: ["qq:group:*"],
    };
    await manager.replaceProfile(manager.getSelectedProfileId(), {
      name: "replay",
      acknowledgedWarnings: [],
      identity: { timeZone: "Asia/Shanghai" },
      runtime,
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
            models: ["light", "heavy"],
            settings: {},
          },
        ],
      },
    });
    await manager.acknowledgeConfigurationWarnings(
      manager.getSelectedProfileId(),
      [],
    );
    await writeFile(script, syntheticServerSource);
    await writeFile(state, JSON.stringify({ protocol: "2025-11-25" }));
    await writeFile(journal, "");
    await writeSensitiveJson(join(root, "mcp.json"), {
      version: 1,
      connections: [
        {
          id: "weather",
          revision: "replay",
          enabled: true,
          protocol: "2025-11-25",
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [script, "stdio", state, journal],
          },
          scopes: [replayScope()],
          tools: [{ name: "echo" }],
          resourceUriPrefixes: ["fixture://allowed/"],
          prompts: ["summarize"],
        },
      ],
    });
    await mkdir(runtime.webDistPath);
    await writeFile(
      join(runtime.webDistPath, "index.html"),
      "<main>synthetic replay</main>",
    );
    installHttp(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const record = {
        body,
        sinceMs: performance.now() - startedAt,
        durationMs: 0,
        usage: null as { inputTokens: number; outputTokens: number } | null,
      };
      requests.push(record);
      const work = response(body, fixture!);
      active.add(work);
      try {
        const output = await work;
        if (output instanceof Response) return output;
        record.usage = { inputTokens: 1, outputTokens: 1 };
        const message = output.tool_calls
          ? { role: "assistant", content: null, tool_calls: output.tool_calls }
          : { role: "assistant", content: JSON.stringify(output) };
        return new Response(
          JSON.stringify({
            id: randomUUID(),
            model: body.model,
            object: "chat.completion",
            created: 1,
            choices: [
              {
                index: 0,
                message,
                finish_reason: output.tool_calls ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      } finally {
        active.delete(work);
        record.durationMs = performance.now() - startedAt - record.sinceMs;
      }
    });
    const facts = (kind: string) =>
      db.information.find({
        kinds: [kind],
        limit: 2000,
        registrationOrder: true,
      });
    const wait = async <T>(
      phase: string,
      assertion: () => T | Promise<T>,
      stages = 1,
    ) => {
      if (!Number.isSafeInteger(stages) || stages < 1 || stages > 32)
        throw new Error(
          "Replay wait must cover 1–32 explicit persisted stages",
        );
      const start = performance.now();
      const budgetMs = persistenceWait.timeout * stages;
      try {
        return await createPersistenceWait(db, () => ({
          backend,
          phase,
          requests: requests.length,
          root,
        }))(phase, assertion, { ...persistenceWait, timeout: budgetMs });
      } finally {
        spans.push({ phase, budgetMs, durationMs: performance.now() - start });
      }
    };
    const logs = async () =>
      (await readFile(journal, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const start = async () => {
      server = await startKaguyaServer({
        ...runtime,
        port: 0,
        gatewayToken: "replay-gateway",
        configRoot: root,
        development: false,
        nativeMemoryTools: true,
        napcat: {
          enabled: false,
          adapterId: "napcat.qq.main",
          reconnectMs: 3000,
        },
      });
      expect(server.runtime).toBeDefined();
    };
    const message = (
      id: string,
      text: string,
      group = "G",
      actor = "甲",
      adapter = "replay.qq",
      occurredAt = new Date().toISOString(),
    ): PlatformInboundMessage => ({
      adapterId: adapter,
      platform: "qq",
      platformMessageId: id,
      occurredAt,
      text,
      selfId: "agent",
      mentions: [{ kind: "user", id: "agent" }],
      target: { kind: "group", groupId: group },
      sender: { userId: actor, nickname: actor },
      raw: {},
    });
    fixture = {
      backend,
      root,
      requests,
      sent,
      spans,
      gates,
      active,
      get db() {
        return db;
      },
      get server() {
        return server!;
      },
      facts,
      wait,
      logs,
      message,
      submit: async (input: PlatformInboundMessage) => {
        const receipt = await server!.adapterHost.ingress.submit(input);
        const inbounds = (await facts("core.message.inbound.text")).filter(
          (a) =>
            a.references.some(
              (r) =>
                r.relation === "core:context" &&
                r.informationId === receipt.rootInformationId,
            ),
        );
        expect(inbounds).toHaveLength(1);
        ingressEvidence.push({
          contextInformationId: receipt.rootInformationId,
          inboundInformationId: inbounds[0]!.informationId,
          adapterId: input.adapterId,
          target: input.target,
          senderId: input.sender.userId,
          platformMessageId: input.platformMessageId,
        });
        return { ...receipt, inboundInformationId: inbounds[0]!.informationId };
      },
      update: (flags: Record<string, unknown>) => {
        controlState = { protocol: "2025-11-25", ...flags };
        return applySyntheticControl(journal, controlState);
      },
      get: (path: string, group = "G", extra: Record<string, string> = {}) =>
        server!.app.inject({
          url: `/api/v1/inspection/${path}?${new URLSearchParams({ scope: replayScope(group), ...extra })}`,
          headers: { authorization: "Bearer replay-gateway" },
        }),
      async settled() {
        await wait("all Runtime/model/action/native work settled", async () => {
          await expectPersistenceSettled(db);
          expect((await db.information.reliable.health()).exhausted).toBe(0);
          const rows = await db.sql.query(
            `SELECT (SELECT count(*)::int FROM information_action_heads WHERE state IN ('queued','started','cancel_requested')) actions,(SELECT count(*)::int FROM information_native_tool_runs WHERE stopped_id IS NULL) native`,
          );
          expect(rows.rows[0]).toEqual({ actions: 0, native: 0 });
          expect(active.size).toBe(0);
        });
      },
      async restart() {
        await server!.close();
        server = undefined;
        if (schema) {
          await realClose.get(db)!();
          db = await schema.reconnect();
          realClose.set(db, db.close.bind(db));
          protect();
        }
        await start();
      },
      complete(ids: string[]) {
        assertions = ids;
        passed = true;
      },
      close,
    };
    await start();
    return fixture;
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Replay setup and cleanup failed",
      );
    }
    throw error;
  }
}
