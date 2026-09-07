/**
 * 功能概述：用真实 KaguyaDatabase、Runtime/Core、ModelTaskClient 与 durable claim 验证模型任务持久窗口。
 * 主要职责：fixture 创建 source/context、编译 Prompt 并注入真实 provider client；restart 重建执行宿主；
 * assertLedger 检查唯一 requested/terminal 及审计引用；事务钩子在实际提交前中断，barrier 控制迟到结果。
 * 代码库关系：只消费 #76 capability、#79 registerOnce/commitTerminal/claim/runner、数据库 testing scope
 * 和 Runtime/logger APIs；业务 effect 是测试自有 kind，不修改 reply/person-fact 或生产存储实现。
 * 输入输出与副作用：PGlite 保留同一内存数据库，仅模拟宿主重建与事务回滚；可选 PostgreSQL scope
 * 会关闭并重连 pool，但不杀死 PostgreSQL 服务。无外部 URL 时 PostgreSQL 用例明确 skipped。
 * 日志使用 Runtime 的持久 outbox 与注入 logger，metrics/inspection 分别来自 executionHealth/ModuleHost；
 * 所有敏感字串均为合成探针，清理按 runner、Runtime、数据库顺序执行，不输出真实连接串。
 */
import { existsSync } from "node:fs";
import {
  createPostgresTestingDatabaseScope,
  createTestingDatabase,
} from "@kaguya/database/testing";
import {
  type InformationCore,
  type InformationClaim,
  ModuleHost,
  ReliableInformationRunner,
} from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import {
  createDeferredDeterministicModel,
  createRepeatingDeterministicModel,
} from "@kaguya/llm/testing";
import { createLogger, closeLogger } from "@kaguya/logger";
import * as modules from "@kaguya/modules";
import { PromptCompiler } from "@kaguya/prompt";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationModuleCatalog,
  type ModuleCapabilityImplementation,
} from "@kaguya/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtimeExports from "./index.js";
import {
  modelTaskInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import {
  ModelTaskClient,
  modelTaskCapability,
  type ModelTaskCapability,
  type ModelTaskRequest,
  type ModelTaskResult,
} from "./model-task.js";
import { KaguyaRuntime } from "./runtime.js";

const probes = {
  prompt: "private-prompt-marker-917",
  output: "private-output-marker-246",
  credential: "sk-test-private-credential-531",
  database: "postgresql://test:private-password@private-host/private-db",
  error: "private-provider-raw-error-864",
  cancellation: "private-free-form-cancel-753",
};
const secret = Object.values(probes).join(" ");
const promptInput = [probes.prompt, probes.credential, probes.database].join(
  " ",
);
const input = {
  occurredAt: "2026-09-06T00:00:00.000Z",
  source: "test:persistence",
  references: [],
};
const sourceKind = defineInformationKind({
  kind: "test.model.source",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});
const effectKind = defineInformationKind({
  kind: "test.model.effect",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["core.model.task.completed"],
    },
  },
  log: { enabled: false },
});
const activation = {
  instanceId: "test.worker.one",
  definitionId: "test.worker",
};
const catalog = defineInformationModuleCatalog(
  defineInformationModule({
    manifest: {
      protocolVersion: 1,
      definitionId: activation.definitionId,
      moduleVersion: "1.0.0",
      displayName: "Persistence fixture",
      settingsSchema: z.object({ privateValue: z.string() }).strict(),
      consumes: [sourceKind],
      produces: [effectKind],
      selectors: [],
      promptRenderers: [],
      requires: [modelTaskCapability],
      provides: [],
    },
    create(_options, context) {
      context.use(modelTaskCapability);
      return { subscriptions: [], provisions: [] };
    },
  }),
);
const activations = [{ ...activation, settings: { privateValue: secret } }];
const subscriptions = [
  { subscriptionId: "test.model.consume", kind: sourceKind.kind },
];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const model = () => createRepeatingDeterministicModel({ text: probes.output });
const pgUrl =
  process.env.KAGUYA_TEST_DATABASE_URL ?? process.env.KAGUYA_DATABASE_URL;
type Backend = "PGlite" | "PostgreSQL";

async function fixture(backend: Backend, provider = model()) {
  const scope =
    backend === "PostgreSQL"
      ? await createPostgresTestingDatabaseScope(pgUrl!)
      : undefined;
  let db = scope ? await scope.connect() : await createTestingDatabase();
  cleanups.push(() => (scope ? scope.close() : db.close()));
  const lines: string[] = [];
  const logger = createLogger({
    service: "test.persistence",
    stream: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  cleanups.push(() => closeLogger(logger));
  let core!: InformationCore;
  let client!: ModelTaskClient;
  const createRuntime = (providerModel: ReturnType<typeof model>) =>
    new KaguyaRuntime({
      database: db,
      catalog,
      activations,
      logger,
      capabilities: (context) => {
        core = context.core;
        client = new ModelTaskClient({
          core,
          client: new KaguyaLlmClient({ model: providerModel }),
          resolveModel: () => ({
            providerId: "test-provider",
            modelId: "test-heavy",
          }),
        });
        return [{ capability: modelTaskCapability, value: client }];
      },
    });
  let runtime = createRuntime(provider);
  cleanups.push(() => runtime.close());
  await runtime.start();
  const context = await core.register(runtimeContextInformationKind, {
    ...input,
    payload: {},
  });
  const references = [
    { relation: "core:context", informationId: context.informationId },
  ];
  const history = await core.register(sourceKind, {
    ...input,
    references,
    payload: { text: "context-history" },
  });
  await db.information.reliable.configureSubscriptions(subscriptions);
  const source = await core.register(sourceKind, {
    ...input,
    references,
    payload: { text: promptInput },
  });
  const prompt = new PromptCompiler().compile(
    "memory",
    [history, source].map((atom, index) => ({
      id: `fragment-${index}`,
      informationId: atom.informationId,
      source: "history" as const,
      priority: index,
      content: atom.payload.text,
      metadata: {},
    })),
  );
  let request: ModelTaskRequest<{ text: string }> = {
    task: {
      taskId: "test.extract",
      version: "1",
      outputSchema: z.object({ text: z.string() }).strict(),
      allowedTiers: ["heavy"],
    },
    sourceInformationId: source.informationId,
    contextInformationId: context.informationId,
    activation,
    selectionPolicy: { tier: "heavy" },
    prompt,
    contextAtoms: [history, source],
  };
  return {
    get db() {
      return db;
    },
    get core() {
      return core;
    },
    get client() {
      return client;
    },
    get runtime() {
      return runtime;
    },
    get request() {
      return request;
    },
    provider,
    lines,
    async restart(providerModel = model()) {
      await runtime.close();
      if (scope) {
        await db.close();
        db = await scope.reconnect();
      }
      runtime = createRuntime(providerModel);
      await runtime.start();
      await db.information.reliable.configureSubscriptions(subscriptions);
      request = {
        ...request,
        contextAtoms: await core.getMany(
          request.contextAtoms.map((a) => a.informationId),
        ),
      };
    },
    async claim() {
      const claim = await db.information.reliable.claim(
        subscriptions[0]!.subscriptionId,
        60_000,
      );
      expect(claim?.informationId).toBe(source.informationId);
      return claim!;
    },
    async expire(claim: InformationClaim) {
      await db.sql.query(
        "UPDATE information_deliveries SET lease_until = clock_timestamp() - interval '1 second' WHERE subscription_id = $1 AND information_id = $2 AND token = $3",
        [claim.subscriptionId, claim.informationId, claim.token],
      );
    },
    atoms: () =>
      db.information.find({
        kinds: modelTaskInformationKinds.map((k) => k.kind),
        limit: 100,
      }),
    async effect(result: ModelTaskResult<{ text: string }>) {
      expect(result.status).toBe("completed");
      if (result.status !== "completed")
        throw new Error("Expected completed result");
      return core.registerOnce(
        "test.model.effect.v1",
        result.requestedInformationId,
        effectKind,
        {
          ...input,
          payload: result.output,
          references: [
            {
              relation: "core:caused-by",
              informationId: result.terminalInformationId,
            },
          ],
        },
      );
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertLedger(f: Fixture, result?: ModelTaskResult<unknown>) {
  const atoms = await f.atoms();
  const requested = atoms.filter((a) => a.kind === "core.model.task.requested");
  const terminals = atoms.filter((a) => a.kind !== "core.model.task.requested");
  expect(requested).toHaveLength(1);
  expect(terminals).toHaveLength(result ? 1 : 0);
  const slots = await f.db.sql.query(
    "SELECT slot_type, information_id FROM information_commit_slots WHERE namespace IN ('kaguya.model.task.requested.v1', 'kaguya.model.task.result.v1')",
  );
  expect(slots.rows).toEqual(
    expect.arrayContaining([
      { slot_type: "operation", information_id: requested[0]!.informationId },
    ]),
  );
  expect(slots.rows).toHaveLength(result ? 2 : 1);
  if (result)
    expect(slots.rows).toContainEqual({
      slot_type: "terminal",
      information_id: result.terminalInformationId,
    });
  expect(requested[0]!.payload).toMatchObject({
    taskId: "test.extract",
    version: "1",
    activation,
    sourceInformationId: f.request.sourceInformationId,
    resolvedModel: { providerId: "test-provider", modelId: "test-heavy" },
    selectionPolicy: { tier: "heavy" },
    prompt: f.request.prompt,
  });
  expect(
    requested[0]!.references
      .filter((r) => r.relation === "core:uses-context")
      .map((r) => r.informationId),
  ).toEqual(f.request.contextAtoms.map((a) => a.informationId));
  if (result) {
    expect(result.requestedInformationId).toBe(requested[0]!.informationId);
    expect(result.terminalInformationId).toBe(terminals[0]!.informationId);
    expect(terminals[0]!.kind).toBe(`core.model.task.${result.status}`);
    for (const relation of ["core:caused-by", "core:status-of"])
      expect(terminals[0]!.references).toContainEqual({
        relation,
        informationId: requested[0]!.informationId,
      });
    expect(terminals[0]!.references).toContainEqual({
      relation: "core:context",
      informationId: f.request.contextInformationId,
    });
    if (result.status === "completed")
      expect(result.output).toEqual(terminals[0]!.payload.output);
  }
  return requested[0]!;
}

it("removes retired reply-only lifecycle files and public compatibility exports", () => {
  for (const file of ["llm-lifecycle.ts", "llm-lifecycle.test.ts"])
    expect(existsSync(new URL(file, import.meta.url))).toBe(false);
  for (const exports of [runtimeExports, modules]) {
    expect(exports).not.toHaveProperty("llmCompletedInformationPayloadSchema");
    expect(exports).not.toHaveProperty("LlmLifecycleClient");
  }
});

for (const backend of ["PGlite", "PostgreSQL"] as const) {
  describe.skipIf(backend === "PostgreSQL" && !pgUrl)(
    `${backend} Model Task persistence windows`,
    () => {
      it("starts Runtime without registering retired core.llm kinds", async () => {
        const f = await fixture(backend);
        expect(
          f.core.registry
            .definitions()
            .map((k) => k.kind)
            .filter((k) => k.startsWith("core.llm.")),
        ).toEqual([]);
      });

      it("recovers a durable requested identity after host closure before provider completion", async () => {
        const deferred = createDeferredDeterministicModel({
          text: "discarded-late-output",
        });
        const f = await fixture(backend, deferred.model);
        const firstCore = f.core;
        const firstClient = f.client;
        const claim = await f.claim();
        const pending = f.core.withClaim(
          claim,
          new AbortController().signal,
          () => f.client.execute(f.request),
        );
        const rejected = pending.catch((error: unknown) => error);
        await deferred.started;
        const requested = await assertLedger(f);
        await f.runtime.close();
        deferred.release();
        expect(await rejected).toBeInstanceOf(Error);
        await assertLedger(f);
        await f.expire(claim);
        const recoveredProvider = model();
        await f.restart(recoveredProvider);
        expect(f.core === firstCore).toBe(false);
        expect(f.client === firstClient).toBe(false);
        const recovered = await f.claim();
        expect(recovered.token).not.toBe(claim.token);
        const result = await f.core.withClaim(
          recovered,
          new AbortController().signal,
          () => f.client.execute(f.request),
        );
        expect(result.status).toBe("completed");
        expect(result.requestedInformationId).toBe(requested.informationId);
        await assertLedger(f, result);
        expect(deferred.model.doGenerateCalls).toHaveLength(1);
        expect(recoveredProvider.doGenerateCalls).toHaveLength(1);
        expect(await f.db.information.reliable.ack(claim)).toBe(false);
        expect(await f.db.information.reliable.ack(recovered)).toBe(true);
      });

      it("rolls back a terminal transaction after provider return and recovers the actual winner", async () => {
        const f = await fixture(backend);
        const claim = await f.claim();
        const transaction = f.db.sql.transaction.bind(f.db.sql);
        let interrupted = false;
        const hook = vi
          .spyOn(f.db.sql, "transaction")
          .mockImplementation((run) =>
            transaction(async (tx) => {
              const result = await run(tx);
              if (!interrupted) {
                const persisted = await tx.query(
                  "SELECT information_id FROM information_atoms WHERE kind = 'core.model.task.completed'",
                );
                if (persisted.rowCount) {
                  interrupted = true;
                  throw new Error(secret);
                }
              }
              return result;
            }),
          );
        await expect(
          f.core.withClaim(claim, new AbortController().signal, () =>
            f.client.execute(f.request),
          ),
        ).rejects.toThrow("Model task execution could not be committed");
        hook.mockRestore();
        expect(interrupted).toBe(true);
        expect(f.provider.doGenerateCalls).toHaveLength(1);
        const requested = await assertLedger(f);
        await f.expire(claim);
        const recoveredProvider = createRepeatingDeterministicModel({
          text: "recovery-winner",
        });
        await f.restart(recoveredProvider);
        const recovered = await f.claim();
        const result = await f.core.withClaim(
          recovered,
          new AbortController().signal,
          () => f.client.execute(f.request),
        );
        expect(result).toMatchObject({
          status: "completed",
          requestedInformationId: requested.informationId,
          output: { text: "recovery-winner" },
        });
        expect(await f.client.execute(f.request)).toEqual(result);
        await assertLedger(f, result);
        expect(recoveredProvider.doGenerateCalls).toHaveLength(1);
        expect(await f.db.information.reliable.ack(claim)).toBe(false);
        expect(await f.db.information.reliable.ack(recovered)).toBe(true);
      });

      it("reclaims a committed terminal and business effect after interruption before durable ack", async () => {
        const f = await fixture(backend);
        const claim = await f.claim();
        const first = await f.core.withClaim(
          claim,
          new AbortController().signal,
          async () => {
            const result = await f.client.execute(f.request);
            await f.effect(result);
            return result;
          },
        );
        await assertLedger(f, first);
        expect((await f.core.executionHealth()).pending).toBe(1);
        // 故意不 ack：模拟处理已落账、进程在确认前退出，随后强制到达可领取期限。
        await f.expire(claim);
        const replayProvider = model();
        await f.restart(replayProvider);
        const recovered = await f.claim();
        expect(recovered.token).not.toBe(claim.token);
        expect(recovered.attempt).toBe(claim.attempt + 1);
        const replay = await f.core.withClaim(
          recovered,
          new AbortController().signal,
          async () => {
            const result = await f.client.execute(f.request);
            await f.effect(result);
            return result;
          },
        );
        expect(replay).toEqual(first);
        await assertLedger(f, replay);
        const effects = await f.db.information.find({
          kinds: [effectKind.kind],
          limit: 10,
        });
        expect(effects).toHaveLength(1);
        expect(effects[0]!.references).toEqual([
          {
            relation: "core:caused-by",
            informationId: first.terminalInformationId,
          },
        ]);
        expect(f.provider.doGenerateCalls).toHaveLength(1);
        expect(replayProvider.doGenerateCalls).toHaveLength(0);
        expect(await f.db.information.reliable.ack(claim)).toBe(false);
        expect(await f.db.information.reliable.ack(recovered)).toBe(true);
        expect(await f.core.executionHealth()).toMatchObject({
          pending: 0,
          retry: 0,
          exhausted: 0,
        });
      });

      it("serializes simultaneous first executions into one requested, terminal and business effect", async () => {
        const deferred = createDeferredDeterministicModel({
          text: probes.output,
        });
        const f = await fixture(backend, deferred.model);
        const clients = Array.from(
          { length: 4 },
          () =>
            new ModelTaskClient({
              core: f.core,
              client: new KaguyaLlmClient({ model: deferred.model }),
              resolveModel: () => ({
                providerId: "test-provider",
                modelId: "test-heavy",
              }),
            }),
        );
        const pending = Promise.all(
          clients.map((client) => client.execute(f.request)),
        );
        try {
          await vi.waitFor(() =>
            expect(deferred.model.doGenerateCalls).toHaveLength(4),
          );
          await assertLedger(f);
        } finally {
          deferred.release();
        }
        const results = await pending;
        expect(
          results.every(
            (result) =>
              result.terminalInformationId ===
              results[0]!.terminalInformationId,
          ),
        ).toBe(true);
        await assertLedger(f, results[0]!);
        const effects = await Promise.all(
          results.map((result) => f.effect(result)),
        );
        expect(
          new Set(effects.map((effect) => effect.informationId)).size,
        ).toBe(1);
        expect(
          await f.db.information.find({ kinds: [effectKind.kind], limit: 10 }),
        ).toHaveLength(1);
        expect(await f.client.execute(f.request)).toEqual(results[0]);
        expect(deferred.model.doGenerateCalls).toHaveLength(4);
      });

      it.each(["completed", "failed", "cancelled"] as const)(
        "returns the %s winner to a concurrent late execution and replay",
        async (status) => {
          const deferred = createDeferredDeterministicModel({
            text: "loser-body",
          });
          const f = await fixture(backend, deferred.model);
          const slow = f.client.execute(f.request);
          await deferred.started;
          const requested = await assertLedger(f);
          const otherProvider = model();
          if (status === "failed")
            vi.spyOn(otherProvider, "doGenerate").mockRejectedValue(
              new Error(secret),
            );
          const competitor: ModelTaskCapability = new ModelTaskClient({
            core: f.core,
            client: new KaguyaLlmClient({ model: otherProvider }),
            resolveModel: () => ({
              providerId: "test-provider",
              modelId: "test-heavy",
            }),
          });
          const winner =
            status === "cancelled"
              ? await competitor.cancel({
                  requestedInformationId: requested.informationId,
                  reason: secret,
                })
              : await competitor.execute(f.request);
          expect(winner.status).toBe(status);
          deferred.release();
          expect(await slow).toEqual(winner);
          expect(await f.client.execute(f.request)).toEqual(winner);
          await assertLedger(f, winner);
          expect(deferred.model.doGenerateCalls).toHaveLength(1);
          expect(JSON.stringify(winner)).not.toContain("loser-body");
          if (status !== "completed")
            for (const probe of Object.values(probes))
              expect(JSON.stringify(winner)).not.toContain(probe);
        },
      );

      it("fences an expired real claim even without signal abort and lets its replacement finish", async () => {
        const deferred = createDeferredDeterministicModel({
          text: "expired-output",
        });
        const f = await fixture(backend, deferred.model);
        const claim = await f.claim();
        const controller = new AbortController();
        const pending = f.core.withClaim(claim, controller.signal, () =>
          f.client.execute(f.request),
        );
        const rejected = pending.catch((error: unknown) => error);
        await deferred.started;
        await assertLedger(f);
        await f.expire(claim);
        const replacement = await f.claim();
        expect(replacement.token).not.toBe(claim.token);
        deferred.release();
        expect(controller.signal.aborted).toBe(false);
        expect(await rejected).toBeInstanceOf(Error);
        await assertLedger(f);
        const result = await f.core.withClaim(
          replacement,
          controller.signal,
          () => f.client.execute(f.request),
        );
        await assertLedger(f, result);
        expect(await f.db.information.reliable.ack(claim)).toBe(false);
        expect(await f.db.information.reliable.ack(replacement)).toBe(true);
      });

      it("shutdown abort releases a runner claim without business cancellation and a fresh runner recovers", async () => {
        const deferred = createDeferredDeterministicModel({
          text: "shutdown-late",
        });
        const f = await fixture(backend, deferred.model);
        let signal: AbortSignal | undefined;
        const finished = barrier();
        const failures: unknown[] = [];
        const runner = new ReliableInformationRunner({
          core: f.core,
          pollIntervalMs: 5,
          drainTimeoutMs: 100,
          subscriptions: [
            {
              ...subscriptions[0]!,
              async handle(_atom, executionSignal) {
                signal = executionSignal;
                try {
                  await f.client.execute(f.request);
                } catch (error) {
                  failures.push(error);
                } finally {
                  finished.release();
                }
              },
            },
          ],
        });
        cleanups.push(() => runner.stop());
        await runner.start();
        await deferred.started;
        await assertLedger(f);
        await runner.stop();
        expect(signal?.aborted).toBe(true);
        deferred.release();
        await finished.promise;
        expect(failures).toHaveLength(1);
        await assertLedger(f);
        const delivery = await f.db.sql.query(
          "SELECT state, attempts FROM information_deliveries WHERE subscription_id = $1",
          [subscriptions[0]!.subscriptionId],
        );
        expect(delivery.rows).toEqual([{ state: "pending", attempts: 0 }]);
        const recoveredProvider = model();
        await f.restart(recoveredProvider);
        const outcomes: ModelTaskResult<{ text: string }>[] = [];
        const replacement = new ReliableInformationRunner({
          core: f.core,
          pollIntervalMs: 5,
          subscriptions: [
            {
              ...subscriptions[0]!,
              async handle() {
                const result = await f.client.execute(f.request);
                await f.effect(result);
                outcomes.push(result);
              },
            },
          ],
        });
        cleanups.push(() => replacement.stop());
        await replacement.start();
        await vi.waitFor(async () =>
          expect((await f.core.executionHealth()).pending).toBe(0),
        );
        expect(outcomes).toHaveLength(1);
        await assertLedger(f, outcomes[0]!);
        expect(recoveredProvider.doGenerateCalls).toHaveLength(1);
        expect(
          await f.db.information.find({ kinds: [effectKind.kind], limit: 10 }),
        ).toHaveLength(1);
      });

      it.each(["completed", "failed", "cancelled"] as const)(
        "redacts %s persisted projections, Runtime logger, metrics and inspection",
        async (status) => {
          const provider = model();
          const f = await fixture(backend, provider);
          const entered = barrier();
          const release = barrier();
          if (status !== "completed")
            vi.spyOn(provider, "doGenerate").mockImplementation(async () => {
              entered.release();
              await release.promise;
              throw Object.assign(new Error(secret), {
                name: probes.error,
                apiKey: probes.credential,
                databaseUrl: probes.database,
              });
            });
          const pending = f.client.execute(f.request);
          if (status !== "completed") {
            await entered.promise;
            const requested = await assertLedger(f);
            if (status === "cancelled")
              await f.client.cancel({
                requestedInformationId: requested.informationId,
                reason: secret,
              });
            release.release();
          }
          const result = await pending;
          expect(result.status).toBe(status);
          if (status === "completed")
            expect(result).toMatchObject({ output: { text: probes.output } });
          await assertLedger(f, result);
          const atoms = await f.atoms();
          const projections = atoms.map((atom) => {
            const definition = modelTaskInformationKinds.find(
              (k) => k.kind === atom.kind,
            )!;
            expect(definition.log.enabled).toBe(true);
            return definition.log.enabled
              ? definition.log.project(atom as never)
              : undefined;
          });
          const outbox = await f.db.sql.query(
            "SELECT information_id, projected_at, last_error FROM information_log_outbox",
          );
          const loggedAtoms = await f.db.information.find({
            kinds: [
              runtimeContextInformationKind.kind,
              ...modelTaskInformationKinds.map(({ kind }) => kind),
            ],
            limit: 100,
          });
          expect(outbox.rows.map((r) => r.information_id).sort()).toEqual(
            loggedAtoms.map((atom) => atom.informationId).sort(),
          );
          expect(
            outbox.rows.every(
              (r) => r.projected_at !== null && r.last_error === null,
            ),
          ).toBe(true);
          expect(await f.db.information.listPendingLogProjections(100)).toEqual(
            [],
          );
          const provision: ModuleCapabilityImplementation<ModelTaskCapability> =
            { capability: modelTaskCapability, value: f.client };
          const host = new ModuleHost({
            core: f.core,
            catalog,
            capabilities: [provision],
          });
          cleanups.push(() => host.stop());
          await host.start(activations);
          const inspection = host.inspect();
          expect(inspection).toMatchObject([
            {
              definitionId: activation.definitionId,
              requires: [{ id: "kaguya:model-task", apiVersion: 1 }],
              bindings: [{ instanceId: activation.instanceId }],
            },
          ]);
          const metrics = await f.core.executionHealth();
          expect(metrics).toMatchObject({ pending: 1, retry: 0, exhausted: 0 });
          const logs = f.lines.map(
            (line) => JSON.parse(line) as Record<string, unknown>,
          );
          const lifecycleLogs = logs.filter(
            (line) => line.event === "model.task.lifecycle",
          );
          expect(logs.every((line) => line.promptFull === undefined)).toBe(
            true,
          );
          expect(lifecycleLogs.map((line) => line.status)).toEqual([
            "requested",
            status,
          ]);
          expect(
            lifecycleLogs.map((line) => line.informationId).sort(),
          ).toEqual(atoms.map((a) => a.informationId).sort());
          for (const projection of [metrics, inspection, outbox.rows])
            for (const probe of Object.values(probes))
              expect(JSON.stringify(projection)).not.toContain(probe);
          for (const projection of [projections, logs]) {
            const serialized = JSON.stringify(projection);
            expect(serialized).toContain(probes.prompt);
            for (const probe of [
              probes.output,
              probes.credential,
              probes.database,
              probes.error,
              probes.cancellation,
            ])
              expect(serialized).not.toContain(probe);
          }
        },
      );
    },
  );
}
