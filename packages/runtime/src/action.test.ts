/**
 * 功能概述：以真实 PGlite/PostgreSQL 证明行动 admission、取消、恢复与冻结证据的竞争边界。
 * 主要职责：fixture 经生产 observation 校验冻结来源；替换测试经 schema 校验生成可写 manifest；受控 provider 统计实际 effect；
 * barrier 明确进入/释放/完成阶段，并检查 admission 后来源失效和期限到达；失败路径释放阻塞后关闭数据库。
 * 代码库关系：调用生产 ActionExecutor/PostgresActionStore 与 LinuxEnvironmentClient 适配，不调用模型、QQ 或真实桌面。
 * 输入输出与副作用：每例独立数据库；PG 恢复关闭并重连 pool，未接外部服务不冒充端到端验收。
 */
import { randomUUID } from "node:crypto";
import {
  setTimeout as realTimeout,
  clearTimeout as clearRealTimeout,
} from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KaguyaDatabase,
  actionDigest,
  actionBasisDigest,
  actionExecutionDigest,
} from "@kaguya/database";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
  type PostgresTestingDatabaseScope,
} from "@kaguya/database/testing";
import {
  freezeInformationAtom,
  informationAtomSchema,
  type NativeMemoryNode,
} from "@kaguya/schema";
import { createNativeMemoryAccess } from "@kaguya/memory";
import {
  observationManifestSchema,
  type ActionIntent,
  type ActionProvider,
  type ActionOutcome,
} from "@kaguya/sdk";
import { ActionExecutor } from "./action.js";
import { LinuxEnvironmentClient } from "./environment.js";

const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const backends = [false, ...(url ? [true] : [])];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, "Action cleanup failed");
});
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
async function enteredBeforeCompletion(
  work: Promise<unknown>,
  entered: Promise<void>,
) {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      work.then(() => {
        throw new Error("Action completed before the expected barrier");
      }),
      new Promise<never>((_, reject) => {
        timer = realTimeout(
          () => reject(new Error("Action barrier not reached in 8000ms")),
          8000,
        );
      }),
    ]);
  } finally {
    clearRealTimeout(timer);
  }
}
const success: ActionOutcome = {
  status: "succeeded",
  evidence: "effect-verified",
  result: { receipt: "external-1" },
  artifacts: [],
  truncated: false,
};
const unknown: ActionOutcome = {
  status: "unknown",
  evidence: "unconfirmed",
  result: null,
  artifacts: [],
  truncated: false,
};

async function fixture(
  postgres: boolean,
  memory = false,
  pending?: "inbound" | "delivered",
) {
  let pg: PostgresTestingDatabaseScope | undefined = postgres
    ? await createPostgresTestingDatabaseScope(url!)
    : undefined;
  if (pg) cleanups.push(() => pg.close());
  let db = pg ? await pg.connect() : await createTestingDatabase();
  if (!pg) cleanups.push(() => db.close());
  await db.prepareSchema();
  const address = {
    platform: "qq",
    adapterId: "test",
    destination: { kind: "group" as const, groupId: "G" },
  };
  const scope = JSON.stringify(["qq", "test", "group", "G"]);
  const append = async (
    kind: string,
    payload: any = {},
    refs: string[] = [],
    relation = "core:uses-context",
  ) => {
    await db.information.synchronizeKinds([kind]);
    const id = randomUUID();
    await db.information.append(
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: id,
          kind,
          occurredAt: new Date().toISOString(),
          source: "test:action",
          payload,
          references: refs.map((informationId) => ({
            relation,
            informationId,
          })),
        }),
      ),
      [{ relation, required: false, multiple: true }],
    );
    return id;
  };
  let pendingId: string | undefined;
  if (pending === "inbound")
    pendingId = await append("core.message.inbound.text", {
      text: "先前的证据",
      source: { ...address, senderId: "b" },
    });
  if (pending === "delivered") {
    const req = await append("core.delivery.requested", {
      platform: "qq",
      adapterId: "test",
      destination: address.destination,
      message: { kind: "text", text: "已经告知" },
    });
    pendingId = await append(
      "core.delivery.delivered",
      {
        ok: true,
        platform: "qq",
        adapterId: "test",
        target: address.destination,
      },
      [req],
      "core:status-of",
    );
  }
  const sourceId = await append("core.message.inbound.text", {
    text: "虚构活动",
    source: { ...address, senderId: "a" },
  });
  const run = await append("agent.router.turn.claimed");
  let node: NativeMemoryNode | undefined;
  if (memory) {
    node = {
      id: randomUUID(),
      content: "虚构经历",
      metadata: {
        system: "native-v1",
        kind: "experience",
        scope,
        ownerId: `conversation:${scope}`,
        level: 1,
        revision: 1,
        status: "active",
        locked: false,
        sourceIds: [sourceId],
        aliases: [],
        tags: [],
        occurredAt: new Date().toISOString(),
      },
    };
    [node] = await db.memoryGraph.native.publish({
      operationId: "initial",
      actor: "manual",
      nodes: [{ node, expectedRevision: 0 }],
    });
  }
  const access = createNativeMemoryAccess({
    enabled: true,
    store: db.memoryGraph.native,
  });
  const frozenMemory = await access.freeze({
    scope,
    owners: [`conversation:${scope}`],
    asOf: new Date().toISOString(),
    query: "虚构",
    ...(node ? { explicitIds: [node.id] } : {}),
  });
  const content = {
    background: { evidence: [{ id: sourceId }] },
    memory: frozenMemory,
  };
  const src = (
    await db.information.find({ informationIds: [sourceId], limit: 1 })
  )[0]!;
  const turn = await append("agent.router.turn.context.completed", {
    source: { ...address, senderId: "a" },
    claimInformationId: run,
    observedThroughInformationId: sourceId,
    inputs: [
      {
        informationId: sourceId,
        text: src.payload.text,
        source: src.payload.source,
      },
    ],
  });
  const frozenId = await append(
    "agent.situation.frozen",
    { turnInformationId: turn, frame: content },
    [turn],
  );
  const refs = [
    ...frozenMemory.fixed,
    ...frozenMemory.recalled.map((r) => r.node),
  ].map((n) => ({ id: n.id, revision: n.metadata.revision }));
  const observation = (await db.observations.freezeNext({
    consumerId: "agent.situation",
    policyVersion: "observation.v1",
    address,
    kinds: ["core.message.inbound.text"],
    senderId: "a",
    resultKind: "agent.observation.completed.v1",
    operationKey: "frozen",
    manifest: {
      version: 1,
      runInformationId: run,
      frozenInformationId: frozenId,
      sourceInformationIds: [sourceId],
      knowledgeCutoff: {
        informationId: frozenId,
        memoryPublicationPosition: frozenMemory.cutoff!.publicationPosition,
        memoryRevisions: refs,
      },
      content: JSON.parse(JSON.stringify(content)),
    },
  }))!;
  const decisionId = await append(
    "agent.action.decision.v1",
    {
      observationId: observation.observationId,
      domain: "tool",
      reason: "synthetic",
      policyVersion: "test.v1",
    },
    [run, frozenId],
  );
  const authorizationId = randomUUID();
  const intent: ActionIntent = {
    operationId: "stable-operation",
    runInformationId: run,
    decisionInformationId: decisionId,
    scope,
    sceneId: observation.sceneId,
    authorizationId,
    authorizationVersion: 1,
    domain: "tool",
    providerId: "test",
    providerVersion: "1",
    executor: "agent:test",
    toolName: "test-effect",
    target: { document: "synthetic" },
    arguments: { value: 1 },
    dependencies: {
      observationId: observation.observationId,
      memoryRevisions: refs,
      sourceInformationIds: [
        ...new Set([
          sourceId,
          ...(frozenMemory.pendingEvidence ?? []).map((e) => e.informationId),
        ]),
      ],
    },
    dependsOn: [],
    deadline: new Date(Date.now() + 120000).toISOString(),
  };
  const authorize = async () => {
    intent.authorizationId = randomUUID();
    await db.actions.authorize({
      executionDigest: actionExecutionDigest(intent),
      id: intent.authorizationId,
      operationId: intent.operationId,
      basisDigest: actionBasisDigest(intent),
      scope,
      version: 1,
      providerId: intent.providerId,
      executor: intent.executor,
      targetDigest: actionDigest(intent.target),
      argumentsDigest: actionDigest(intent.arguments),
      expiresAt: new Date(Date.parse(intent.deadline) + 3600000).toISOString(),
      causeInformationId: sourceId,
    });
  };
  await authorize();
  let effects = 0;
  let behavior = async (): Promise<ActionOutcome> => {
    effects++;
    return success;
  };
  const provider: ActionProvider = {
    id: "test",
    version: "1",
    capabilities: {
      cancellation: "request-confirm",
      idempotency: "operation",
      reconciliation: true,
      successEvidence: "effect-verified",
      fencing: "none",
    },
    execute: () => behavior(),
    cancel: async () => undefined,
    reconcile: async () => success,
  };
  const executor = () =>
    new ActionExecutor({ store: db.actions, providers: [provider] });
  const withdraw = () =>
    db.memoryGraph.native.publish({
      operationId: "withdraw",
      actor: "manual",
      nodes: [],
      invalidations: [
        {
          kind: "source-withdrawal",
          targetId: sourceId,
          reason: "synthetic correction",
        },
      ],
    });
  return {
    get db() {
      return db;
    },
    append,
    authorize,
    pendingId,
    scope,
    intent,
    provider,
    executor,
    observation,
    sourceId,
    run,
    node,
    withdraw,
    effects: () => effects,
    behavior: (b: typeof behavior) => {
      behavior = b;
    },
    effect: () => {
      effects++;
    },
    intervention: (id: string) => ({
      intentId: id,
      scope,
      causeInformationId: sourceId,
      controlAuthorizationId: intent.authorizationId,
    }),
    reconnect: async () => {
      if (pg) {
        await db.close();
        db = await pg.reconnect();
      } else db = new KaguyaDatabase(db.sql);
    },
  };
}

describe.each(backends)("action lifecycle (PostgreSQL=%s)", (postgres) => {
  it("persists broker action results without persisting the private lease token", async () => {
    const f = await fixture(postgres);
    const environment = {
      environmentId: "env",
      generation: 1,
      workspaceId: "workspace",
      resourceIds: ["desktop"],
      workflowId: "workflow",
      leaseId: "lease",
      fencing: "1",
      expiresAt: f.intent.deadline,
    };
    const token = "synthetic-private-environment-credential";
    let effects = 0;
    const client = new LinuxEnvironmentClient(async (method, params) => {
      if (method === "lease.acquire") return { environment, token };
      if (method === "lease.validate") return { valid: true };
      expect(method).toBe("operation.execute");
      expect(params.token).toBe(token);
      expect(params.attemptId).toBeTypeOf("string");
      effects++;
      return { ...success, evidence: "returned" };
    });
    f.intent.environment = await client.acquire({
      environmentId: "env",
      scope: f.scope,
      workflowId: "workflow",
    });
    f.intent.toolName = "shell.exec";
    await f.authorize();
    const executor = new ActionExecutor({
      store: f.db.actions,
      providers: [client.provider("test")],
      ...client.actionHooks,
    });
    cleanups.push(() => executor.close());
    const registered = await executor.register(f.intent);
    const result = await executor.execute(registered.intentId, f.scope);
    expect(result.state).toBe("succeeded");
    await executor.execute(registered.intentId, f.scope);
    expect(effects).toBe(1);
    const receipt = await executor.readReceipt(
      result.receiptId!,
      f.scope,
      f.intent.authorizationId,
    );
    expect(receipt.outcome.environmentValidation).toBe("current");
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(
      JSON.stringify(await executor.read(registered.intentId, f.scope)),
    ).not.toContain(token);
    const facts = await f.db.sql.query<{ kind: string; payload: unknown }>(
      "SELECT kind, payload FROM information_atoms WHERE kind LIKE 'core.action.%'",
    );
    expect(facts.rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining([
        "core.action.intent.v1",
        "core.action.started.v1",
        "core.action.result.v1",
      ]),
    );
    expect(JSON.stringify(facts.rows)).not.toContain(token);
  });

  it.each(["unknown", "partial"] as const)(
    "accepts cancellation forwarding after a lost broker success without upgrading the original %s receipt",
    async (state) => {
      const f = await fixture(postgres);
      const environment = {
        environmentId: "env",
        generation: 1,
        workspaceId: "workspace",
        resourceIds: ["desktop"],
        workflowId: "workflow",
        leaseId: "original-lease",
        fencing: "1",
        expiresAt: f.intent.deadline,
      };
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      let effects = 0;
      const clientFor = (reference: typeof environment) =>
        new LinuxEnvironmentClient(async (method, params) => {
          calls.push({ method, params });
          if (method === "lease.acquire")
            return {
              environment: reference,
              token: "synthetic-private-control-lease-token",
            };
          if (method === "lease.validate") return { valid: true };
          if (method === "operation.execute") {
            effects++;
            if (state === "unknown")
              throw new Error("lost successful broker response");
            return { ...success, status: "partial" };
          }
          if (method === "operation.cancel") return success;
          throw new Error(`unexpected RPC: ${method}`);
        });
      const original = clientFor(environment);
      f.intent.environment = await original.acquire({
        environmentId: "env",
        scope: f.scope,
        workflowId: "workflow",
      });
      f.intent.toolName = "gui.observe";
      await f.authorize();
      const first = new ActionExecutor({
        store: f.db.actions,
        providers: [original.provider("test")],
        ...original.actionHooks,
      });
      cleanups.push(() => first.close());
      const registered = await first.register(f.intent);
      const before = await first.execute(registered.intentId, f.scope);
      expect(before.state).toBe(state);
      await first.close();
      await f.reconnect();
      const restored = clientFor({
        ...environment,
        generation: 2,
        leaseId: "control-lease",
        fencing: "2",
      });
      await restored.acquire({
        environmentId: "env",
        scope: f.scope,
        workflowId: "workflow",
      });
      const executor = new ActionExecutor({
        store: f.db.actions,
        providers: [restored.provider("test")],
        ...restored.actionHooks,
      });
      cleanups.push(() => executor.close());
      for (let retry = 0; retry < 2; retry++) {
        const after = await executor.cancelForwarded(
          f.intervention(registered.intentId),
        );
        expect(after.state).toBe(state);
        expect(after.receiptId).toBe(before.receiptId);
        expect(after.attemptId).toBe(before.attemptId);
      }
      const dispatched = calls.find(
        (call) => call.method === "operation.execute",
      )!.params;
      const cancellations = calls.filter(
        (call) => call.method === "operation.cancel",
      );
      expect(cancellations).toHaveLength(2);
      for (const { params } of cancellations)
        expect(params).toMatchObject({
          attemptId: dispatched.attemptId,
          operationId: dispatched.operationId,
          digest: dispatched.digest,
          environment,
          controlEnvironment: { generation: 2, leaseId: "control-lease" },
        });
      const receipt = await executor.readReceipt(
        before.receiptId!,
        f.scope,
        f.intent.authorizationId,
      );
      expect(receipt.outcome.status).toBe(state);
      expect(
        (
          await f.db.sql.query(
            "SELECT information_id FROM information_atoms WHERE kind IN ('core.action.result.v1','core.action.reconciled.v1')",
          )
        ).rows,
      ).toHaveLength(1);
      expect(effects).toBe(1);
    },
  );

  it.each([true, false])(
    "serializes real Memory-lock competition (admission first=%s)",
    async (admissionFirst) => {
      const f = await fixture(postgres),
        locked = barrier(),
        release = barrier();
      let gate = true;
      const sql: typeof f.db.sql = {
        query: f.db.sql.query.bind(f.db.sql),
        exec: f.db.sql.exec.bind(f.db.sql),
        close: async () => undefined,
        transaction: (run) =>
          f.db.sql.transaction((tx) =>
            run({
              exec: tx.exec.bind(tx),
              query: async (text, values) => {
                const result = await tx.query(text, values);
                if (gate && text === "SELECT pg_advisory_xact_lock(7149321)") {
                  gate = false;
                  locked.release();
                  await release.promise;
                }
                return result as any;
              },
            }),
          ),
      };
      const gated = new KaguyaDatabase(sql),
        e = new ActionExecutor({
          store: admissionFirst ? gated.actions : f.db.actions,
          providers: [f.provider],
        });
      const a = await f.db.actions.register(f.intent);
      const first = admissionFirst
        ? e.execute(a.intentId, f.scope)
        : gated.memoryGraph.native.publish({
            operationId: "withdraw-first",
            actor: "manual",
            nodes: [],
            invalidations: [
              {
                kind: "source-withdrawal",
                targetId: f.sourceId,
                reason: "synthetic",
              },
            ],
          });
      let second: Promise<unknown> | undefined;
      const canInvoke = gated.actions.canInvoke.bind(gated.actions);
      const invocation = admissionFirst
        ? vi
            .spyOn(gated.actions, "canInvoke")
            .mockImplementation(async (...args) => {
              await second;
              return canInvoke(...args);
            })
        : undefined;
      try {
        await enteredBeforeCompletion(first, locked.promise);
        second = admissionFirst ? f.withdraw() : e.execute(a.intentId, f.scope);
        void second.catch(() => undefined);
        release.release();
        await Promise.all([first, second]);
        expect((await e.read(a.intentId, f.scope)).state).toBe(
          admissionFirst ? "cancelled" : "rejected",
        );
        expect(f.effects()).toBe(0);
      } finally {
        release.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        invocation?.mockRestore();
        await e.close();
      }
    },
  );

  it("closes the recovery scan before database cleanup", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      recover = vi
        .spyOn(f.db.actions, "recoverExpired")
        .mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      e.startRecovery();
      await vi.advanceTimersByTimeAsync(1000);
      expect(recover).toHaveBeenCalledTimes(1);
      await e.close();
      await vi.advanceTimersByTimeAsync(3000);
      expect(recover).toHaveBeenCalledTimes(1);
    } finally {
      try {
        await e.close();
      } finally {
        vi.useRealTimers();
        recover.mockRestore();
      }
    }
  });
  it("shares one absolute budget across preparation and result validation", async () => {
    const f = await fixture(postgres),
      prepared = barrier(),
      prepareRelease = barrier(),
      validating = barrier(),
      resultRelease = barrier();
    f.intent.environment = {
      environmentId: "env",
      generation: 1,
      workspaceId: "workspace",
      resourceIds: ["desktop"],
      workflowId: "workflow",
      leaseId: "lease",
      fencing: "1",
      expiresAt: f.intent.deadline,
    };
    await f.authorize();
    f.provider.capabilities.fencing = "environment";
    const e = new ActionExecutor({
      store: f.db.actions,
      providers: [f.provider],
      leaseMs: 10000,
      resolveLeaseCredential: async () => ({ token: "synthetic-lease" }),
      validateEnvironment: async (_, mode) => {
        if (mode === "execute") {
          prepared.release();
          await prepareRelease.promise;
        } else {
          validating.release();
          await resultRelease.promise;
        }
        return true;
      },
    });
    const a = await e.register(f.intent);
    let work: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      work = e.execute(a.intentId, f.scope);
      await enteredBeforeCompletion(work, prepared.promise);
      await vi.advanceTimersByTimeAsync(5000);
      prepareRelease.release();
      await enteredBeforeCompletion(work, validating.promise);
      await vi.advanceTimersByTimeAsync(4000);
      await work;
      const result = await e.read(a.intentId, f.scope);
      const receipt = await e.readReceipt(
        result.receiptId!,
        f.scope,
        f.intent.authorizationId,
      );
      expect(receipt.outcome).toEqual({
        ...success,
        environmentValidation: "unconfirmed",
      });
      expect(f.effects()).toBe(1);
    } finally {
      prepareRelease.release();
      resultRelease.release();
      try {
        await e.close();
        await work?.catch(() => undefined);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each(["toolName", "providerVersion", "environment", "dependsOn"] as const)(
    "binds the authorized execution specification before registration: %s",
    async (field) => {
      const f = await fixture(postgres),
        e = f.executor();
      const change =
        field === "toolName"
          ? { toolName: "delete-file" }
          : field === "providerVersion"
            ? { providerVersion: "2" }
            : field === "dependsOn"
              ? { dependsOn: ["unapproved-dependency"] }
              : {
                  environment: {
                    environmentId: "foreign",
                    generation: 9,
                    workspaceId: "foreign",
                    resourceIds: ["desktop"],
                    workflowId: "foreign",
                    leaseId: "foreign",
                    fencing: "9",
                    expiresAt: f.intent.deadline,
                  },
                };
      await expect(e.register({ ...f.intent, ...change })).rejects.toThrow(
        "authorization-denied",
      );
      expect(f.effects()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT 1 FROM information_action_heads")).rows,
      ).toHaveLength(0);
    },
  );

  it.each(["resolve", "prepare", "result"] as const)(
    "bounds a stalled environment %s stage and releases its claim",
    async (stage) => {
      const f = await fixture(postgres),
        entered = barrier(),
        release = barrier();
      f.intent.environment = {
        environmentId: "env",
        generation: 1,
        workspaceId: "workspace",
        resourceIds: ["desktop"],
        workflowId: "workflow",
        leaseId: "lease",
        fencing: "1",
        expiresAt: f.intent.deadline,
      };
      await f.authorize();
      f.provider.capabilities.fencing = "environment";
      const wait = async () => {
        entered.release();
        await release.promise;
      };
      const e = new ActionExecutor({
        store: f.db.actions,
        providers: [f.provider],
        resolveLeaseCredential: async () => {
          if (stage === "resolve") await wait();
          return { token: "synthetic-private-lease" };
        },
        validateEnvironment: async (_, mode) => {
          if (
            (stage === "prepare" && mode === "execute") ||
            (stage === "result" && mode === "result")
          )
            await wait();
          return true;
        },
      });
      const a = await e.register(f.intent),
        work = e.execute(a.intentId, f.scope);
      cleanups.push(async () => {
        release.release();
        e.close();
        await work;
      });
      await enteredBeforeCompletion(work, entered.promise);
      await f.withdraw(); // 外部阶段不持有 Memory 锁。
      e.close();
      const result = await work;
      expect(result.state).toBe(stage === "result" ? "succeeded" : "unknown");
      expect(f.effects()).toBe(stage === "result" ? 1 : 0);
      const receipt = await e.readReceipt(
        result.receiptId!,
        f.scope,
        f.intent.authorizationId,
      );
      if (stage === "result")
        expect(receipt.outcome.environmentValidation).toBe("unconfirmed");
      expect(
        (
          await f.db.sql.query<{ live: boolean }>(
            "SELECT lease_until>clock_timestamp() live FROM information_action_heads WHERE intent_id=$1",
            [a.intentId],
          )
        ).rows[0]!.live,
      ).toBe(false);
      release.release();
    },
  );
  it("keeps original effects and artifacts when takeover occurs during result validation", async () => {
    const f = await fixture(postgres),
      entered = barrier(),
      release = barrier();
    f.intent.environment = {
      environmentId: "env",
      generation: 1,
      workspaceId: "workspace",
      resourceIds: ["desktop"],
      workflowId: "workflow",
      leaseId: "lease",
      fencing: "1",
      expiresAt: f.intent.deadline,
    };
    await f.authorize();
    f.provider.capabilities.fencing = "environment";
    const e = new ActionExecutor({
      store: f.db.actions,
      providers: [f.provider],
      resolveLeaseCredential: async () => ({
        token: "synthetic-private-lease",
      }),
      validateEnvironment: async (_, mode) => {
        if (mode === "result") {
          entered.release();
          await release.promise;
          return false;
        }
        return true;
      },
    });
    const a = await e.register(f.intent);
    const artifact = {
      id: "artifact",
      hash: "synthetic-hash",
      mime: "text/plain",
      size: 1,
      scope: f.scope,
      actionId: a.intentId,
      generation: 1,
      observedAt: new Date().toISOString(),
      source: "broker-journal",
      retention: "task",
    };
    f.behavior(async () => {
      f.effect();
      return { ...success, artifacts: [artifact] };
    });
    const work = e.execute(a.intentId, f.scope);
    cleanups.push(async () => {
      release.release();
      e.close();
      await work;
    });
    await enteredBeforeCompletion(work, entered.promise);
    release.release();
    const r = await work,
      receipt = await e.readReceipt(
        r.receiptId!,
        f.scope,
        f.intent.authorizationId,
      );
    expect(receipt.outcome).toEqual({
      ...success,
      artifacts: [artifact],
      environmentValidation: "fenced",
    });
    expect(receipt.intent.environment?.generation).toBe(1);
    expect((await e.execute(a.intentId, f.scope)).state).toBe("succeeded");
    expect(f.effects()).toBe(1);
  });
  it.each(["credential", "artifact"] as const)(
    "never persists a cancel result with foreign %s",
    async (fault) => {
      const f = await fixture(postgres);
      f.intent.environment = {
        environmentId: "env",
        generation: 1,
        workspaceId: "workspace",
        resourceIds: ["desktop"],
        workflowId: "workflow",
        leaseId: "lease",
        fencing: "1",
        expiresAt: f.intent.deadline,
      };
      await f.authorize();
      f.provider.capabilities.fencing = "environment";
      const e = new ActionExecutor({
        store: f.db.actions,
        providers: [f.provider],
        resolveLeaseCredential: async () => ({
          token: "synthetic-private-lease",
        }),
        validateEnvironment: async () => true,
      });
      const a = await e.register(f.intent),
        admitted = await f.db.actions.admit(a.intentId, f.scope, 30000);
      const bad: ActionOutcome = {
        ...success,
        status: "partial",
        result:
          fault === "credential" ? { leaked: "synthetic-private-lease" } : null,
        artifacts:
          fault === "artifact"
            ? [
                {
                  id: "foreign-artifact",
                  hash: "hash",
                  mime: "text/plain",
                  size: 1,
                  scope: "foreign",
                  actionId: "other-action",
                  generation: 2,
                  observedAt: new Date().toISOString(),
                  source: "broker-journal",
                  retention: "task",
                },
              ]
            : [],
      };
      f.provider.cancel = async () => bad;
      await e.cancel(f.intervention(a.intentId));
      if (fault === "artifact")
        await expect(
          f.db.actions.confirmCancellation(
            f.intervention(a.intentId),
            admitted.claim!.attemptId,
            bad,
          ),
        ).rejects.toThrow("artifact-mismatch");
      const rows = await f.db.sql.query(
        "SELECT payload FROM information_atoms WHERE kind IN ('core.action.result.v1','core.action.reconciled.v1')",
      );
      expect(JSON.stringify(rows.rows)).not.toContain(
        "synthetic-private-lease",
      );
      expect(JSON.stringify(rows.rows)).not.toContain("foreign-artifact");
      await f.db.actions.release(admitted.claim!, f.scope);
    },
  );

  it.each(["inbound", "delivered"] as const)(
    "validates frozen pending-only %s evidence and rejects underreporting",
    async (pending) => {
      const f = await fixture(postgres, false, pending);
      expect(f.observation.manifest!.sourceInformationIds).not.toContain(
        f.pendingId,
      );
      expect(f.intent.dependencies.sourceInformationIds).toContain(f.pendingId);
      expect(
        (await f.db.memoryGraph.native.checkDependencies(f.intent.dependencies))
          .reasons,
      ).toEqual([]);
      expect(
        (
          await f.db.memoryGraph.native.checkDependencies({
            ...f.intent.dependencies,
            sourceInformationIds: [],
          })
        ).valid,
      ).toBe(false);
      const e = f.executor(),
        a = await e.register(f.intent);
      await f.db.memoryGraph.native.publish({
        operationId: "withdraw-pending",
        actor: "manual",
        nodes: [],
        invalidations: [
          {
            kind: "source-withdrawal",
            targetId: f.pendingId!,
            reason: "撤回先前证据",
          },
        ],
      });
      expect((await e.execute(a.intentId, f.scope)).state).toBe("rejected");
      expect(f.effects()).toBe(0);
      await expect(
        e.register({
          ...f.intent,
          operationId: "omit-source",
          dependencies: { ...f.intent.dependencies, sourceInformationIds: [] },
        }),
      ).rejects.toThrow("authorization-denied");
    },
  );
  it("confirmed partial effect survives a later aborted execute result", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent),
      entered = barrier(),
      release = barrier();
    f.behavior(async () => {
      f.effect();
      entered.release();
      await release.promise;
      return unknown;
    });
    f.provider.cancel = async () => ({
      ...success,
      status: "partial",
      result: { completed: 1 },
    });
    const work = e.execute(a.intentId, f.scope);
    cleanups.push(async () => {
      release.release();
      await work;
    });
    await enteredBeforeCompletion(work, entered.promise);
    const partial = await e.cancel(f.intervention(a.intentId));
    e.close();
    expect((await work).receiptId).toBe(partial.receiptId);
    expect((await e.read(a.intentId, f.scope)).state).toBe("partial");
    expect(f.effects()).toBe(1);
    expect(
      (
        await f.db.sql.query(
          "SELECT 1 FROM information_action_receipts WHERE intent_id=$1",
          [a.intentId],
        )
      ).rowCount,
    ).toBe(2);
  });
  it("uses a new reconciliation budget after the original execution deadline", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent);
    f.behavior(async () => {
      f.effect();
      return unknown;
    });
    await e.execute(a.intentId, f.scope);
    const entered = barrier(),
      release = barrier();
    f.provider.reconcile = async () => {
      entered.release();
      await release.promise;
      return success;
    };
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.parse(f.intent.deadline) + 1000);
    const work = e.reconcile(a.intentId, f.scope, f.intent.authorizationId);
    try {
      await enteredBeforeCompletion(work, entered.promise);
      await vi.advanceTimersByTimeAsync(20);
      release.release();
      expect((await work).state).toBe("succeeded");
      expect(f.effects()).toBe(1);
    } finally {
      release.release();
      e.close();
      try {
        await work.catch(() => undefined);
      } finally {
        vi.useRealTimers();
      }
    }
  });
  it("reuses stable identity, rejects changed parameters and validates receipt scope/hash", async () => {
    const f = await fixture(postgres),
      e = f.executor();
    const [a, b] = await Promise.all([
      e.register(f.intent),
      e.register(f.intent),
    ]);
    expect(a.intentId).toBe(b.intentId);
    await expect(
      e.register({ ...f.intent, arguments: { value: 2 } }),
    ).rejects.toThrow("action-operation-conflict");
    const result = await e.execute(a.intentId, f.scope);
    expect(result.state).toBe("succeeded");
    expect(f.effects()).toBe(1);
    const receipt = await e.readReceipt(
      result.receiptId!,
      f.scope,
      f.intent.authorizationId,
    );
    expect(receipt.receiptId).toBe(result.receiptId);
    expect(receipt.attemptId).toBe(result.attemptId);
    expect(BigInt(receipt.registeredPosition)).toBeGreaterThan(0n);
    expect(JSON.stringify(receipt)).not.toContain("leaseToken");
    await expect(
      e.readReceipt(result.receiptId!, "other", f.intent.authorizationId),
    ).rejects.toThrow("denied");
    await f.db.actions.revoke(f.intent.authorizationId, f.sourceId);
    await expect(
      e.readReceipt(result.receiptId!, f.scope, f.intent.authorizationId),
    ).rejects.toThrow("denied");
  });
  it("keeps a superseded observation on a delayed message instead of granting legacy delivery", async () => {
    const f = await fixture(postgres);
    await f.append(
      "agent.light.decision.completed",
      { action: { action: "message" } },
      [f.run],
      "core:status-of",
    );
    const requestId = await f.append(
      "core.delivery.requested",
      {
        adapterId: "test",
        platform: "qq",
        destination: { kind: "group", groupId: "G" },
        message: { kind: "text", text: "obsolete reply" },
        turn: { claimInformationId: f.run },
      },
      [f.sourceId],
      "core:context",
    );
    expect(f.observation.manifest).not.toBeNull();
    const manifest = observationManifestSchema.parse(f.observation.manifest);
    await f.db.observations.replace(
      f.observation.observationId,
      "corrected-observation",
      manifest,
    );
    const action = await f.db.actions.prepareDelivery(requestId);
    expect(action.intent.dependencies.observationId).toBe(
      f.observation.observationId,
    );
    const admission = await f.db.actions.admit(action.intentId, f.scope, 30000);
    expect(admission.claim).toBeUndefined();
    expect(admission.view.state).toBe("rejected");
    const receipt = await f.db.actions.readReceipt(
      admission.view.receiptId!,
      f.scope,
      action.intent.authorizationId,
    );
    expect(receipt.outcome).toMatchObject({
      status: "rejected",
      evidence: "not-executed",
      result: { reason: "dependency-invalid" },
    });
    await f.reconnect();
    expect((await f.db.actions.prepareDelivery(requestId)).intentId).toBe(
      action.intentId,
    );
    expect(
      (await f.db.actions.admit(action.intentId, f.scope, 30000)).claim,
    ).toBeUndefined();
    expect(f.effects()).toBe(0);
  });

  it.each(["expired", "stopped", "revoked"] as const)(
    "records %s message preparation as not executed instead of throwing into unknown recovery",
    async (reason) => {
      const f = await fixture(postgres);
      await f.db.information.synchronizeKinds(["core.delivery.requested"]);
      await f.db.sql.query(
        "INSERT INTO information_subscriptions(subscription_id,kind,enabled) VALUES('kaguya.runtime.delivery','core.delivery.requested',true)",
      );
      const requestId = await f.append(
        "core.delivery.requested",
        {
          adapterId: "test",
          platform: "qq",
          destination: { kind: "group", groupId: "G" },
          message: { kind: "text", text: "old casual reply" },
        },
        [f.sourceId],
        "core:context",
      );
      if (reason === "expired")
        await f.db.sql.query(
          "UPDATE information_deliveries SET created_at=clock_timestamp()-interval '1 day' WHERE information_id=$1",
          [requestId],
        );
      else if (reason === "stopped")
        await f.db.actions.invalidateRun(f.sourceId, f.scope, f.sourceId);
      await f.reconnect();
      const authorize = f.db.actions.authorize.bind(f.db.actions);
      const hook = vi
        .spyOn(f.db.actions, "authorize")
        .mockImplementation(async (input) => {
          await authorize(input);
          if (reason === "revoked")
            await f.db.actions.revoke(input.id, f.sourceId);
        });
      cleanups.push(async () => {
        hook.mockRestore();
      });
      const action = await f.db.actions.prepareDelivery(requestId);
      const admission = await f.db.actions.admit(
        action.intentId,
        f.scope,
        30000,
      );
      expect(admission.claim).toBeUndefined();
      expect(admission.view.state).toBe("rejected");
      expect(admission.view.attemptId).toBeNull();
      const outcome = await f.db.actions.deliveryResult(requestId);
      expect(outcome).toMatchObject({
        status: "rejected",
        evidence: "not-executed",
        result: {
          reason:
            reason === "stopped" ? "run-invalidated" : "authorization-denied",
        },
      });
      await f.reconnect();
      const replay = await f.db.actions.prepareDelivery(requestId);
      expect(replay.intentId).toBe(action.intentId);
      expect(replay.intent.deadline).toBe(action.intent.deadline);
      expect(await f.db.actions.deliveryResult(requestId)).toEqual(outcome);
      expect(f.effects()).toBe(0);
    },
  );

  it("does not revive a queued action after downtime past its deadline", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent);
    await f.reconnect();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(f.intent.deadline) + 1);
    try {
      const recovered = await f.executor().execute(a.intentId, f.scope);
      expect(recovered.state).toBe("rejected");
      expect(recovered.attemptId).toBeNull();
      now.mockRestore();
      const receipt = await f.db.actions.readReceipt(
        recovered.receiptId!,
        f.scope,
        f.intent.authorizationId,
      );
      expect(receipt.outcome.result).toMatchObject({
        reason: "deadline-expired",
      });
      expect((await f.executor().execute(a.intentId, f.scope)).receiptId).toBe(
        recovered.receiptId,
      );
      expect(f.effects()).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it("revocation before admission performs zero effects", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent);
    await f.db.actions.revoke(f.intent.authorizationId, f.sourceId);
    expect((await e.execute(a.intentId, f.scope)).state).toBe("rejected");
    expect(f.effects()).toBe(0);
  });
  it.each([false, true])(
    "rechecks raw/historical sources after a successful diagnostic (memory=%s)",
    async (memory) => {
      const f = await fixture(postgres, memory),
        e = f.executor(),
        a = await e.register(f.intent);
      expect(
        (await f.db.memoryGraph.native.checkDependencies(f.intent.dependencies))
          .reasons,
      ).toEqual([]);
      if (f.node)
        await f.db.memoryGraph.native.publish({
          operationId: "remove-source",
          actor: "manual",
          nodes: [
            {
              expectedRevision: 1,
              node: {
                ...f.node,
                metadata: {
                  ...f.node.metadata,
                  revision: 2,
                  sourceIds: [],
                  proofOwners: [],
                },
              },
            },
          ],
        });
      await f.withdraw();
      const check = await f.db.memoryGraph.native.checkDependencies(
        f.intent.dependencies,
      );
      expect(
        check.reasons.some(
          (r) => r.id === f.sourceId && r.reason === "source-withdrawn",
        ),
      ).toBe(true);
      expect((await e.execute(a.intentId, f.scope)).state).toBe("rejected");
      expect(f.effects()).toBe(0);
      expect(
        (await f.db.observations.read(f.observation.observationId))!.manifest,
      ).toEqual(f.observation.manifest);
    },
  );
  it("cancel-first and run invalidation fence late model output", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent);
    await e.cancel(f.intervention(a.intentId));
    expect((await e.execute(a.intentId, f.scope)).state).toBe("cancelled");
    expect(f.effects()).toBe(0);
    await f.db.actions.invalidateRun(f.run, f.scope, f.sourceId);
    await expect(
      e.register({ ...f.intent, operationId: "late-model" }),
    ).rejects.toThrow(/run-invalidated|authorization-denied/);
  });
  it("cancellation between started and invocation blocks the delayed call", async () => {
    const f = await fixture(postgres),
      a = await f.db.actions.register(f.intent);
    const admitted = await f.db.actions.admit(a.intentId, f.scope, 30000);
    await f.db.actions.intervene(f.intervention(a.intentId));
    expect(await f.db.actions.canInvoke(admitted.claim!, f.scope)).toBe(false);
    expect(f.effects()).toBe(0);
  });
  it("withdrawal after admission prevents the provider call", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent),
      entered = barrier(),
      release = barrier();
    const canInvoke = f.db.actions.canInvoke.bind(f.db.actions);
    const spy = vi
      .spyOn(f.db.actions, "canInvoke")
      .mockImplementation(async (...args) => {
        entered.release();
        await release.promise;
        return canInvoke(...args);
      });
    const work = e.execute(a.intentId, f.scope);
    cleanups.push(async () => {
      release.release();
      try {
        await work;
      } finally {
        spy.mockRestore();
      }
    });
    await enteredBeforeCompletion(work, entered.promise);
    await f.withdraw();
    release.release();
    expect((await work).state).toBe("cancelled");
    expect(f.effects()).toBe(0);
  });
  it("rejects invocation after the intent deadline even with a live claim", async () => {
    const f = await fixture(postgres),
      a = await f.db.actions.register(f.intent),
      admitted = await f.db.actions.admit(a.intentId, f.scope, 300000);
    expect(admitted.claim).toBeDefined();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse(f.intent.deadline));
    try {
      expect(await f.db.actions.canInvoke(admitted.claim!, f.scope)).toBe(
        false,
      );
    } finally {
      now.mockRestore();
    }
    expect(f.effects()).toBe(0);
  });
  it("started-first keeps late success and ignores a later cancellation as outcome", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent),
      entered = barrier(),
      release = barrier();
    f.behavior(async () => {
      f.effect();
      entered.release();
      await release.promise;
      return success;
    });
    const work = e.execute(a.intentId, f.scope);
    cleanups.push(async () => {
      release.release();
      await work;
    });
    await enteredBeforeCompletion(work, entered.promise);
    expect((await e.cancel(f.intervention(a.intentId))).state).toBe(
      "cancel_requested",
    );
    await f.withdraw(); // 挂起 provider 没有持有 Memory 写锁。
    release.release();
    expect((await work).state).toBe("succeeded");
    expect(f.effects()).toBe(1);
    expect((await e.cancel(f.intervention(a.intentId))).state).toBe(
      "succeeded",
    );
  });
  it("keeps partial cancellation evidence separate from completion", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent),
      entered = barrier(),
      release = barrier();
    const partial: ActionOutcome = {
      ...success,
      status: "partial",
      result: { completed: 1, remaining: 2 },
    };
    f.behavior(async () => {
      f.effect();
      entered.release();
      await release.promise;
      return partial;
    });
    f.provider.cancel = async () => partial;
    const work = e.execute(a.intentId, f.scope);
    cleanups.push(async () => {
      release.release();
      await work;
    });
    await enteredBeforeCompletion(work, entered.promise);
    expect((await e.cancel(f.intervention(a.intentId))).state).toBe("partial");
    release.release();
    expect((await work).state).toBe("partial");
    expect(f.effects()).toBe(1);
  });
  it("lost receipt is unknown and restart reconciliation retrieves it without a second effect", async () => {
    const f = await fixture(postgres),
      e = f.executor(),
      a = await e.register(f.intent);
    f.behavior(async () => {
      f.effect();
      throw new Error("lost transport response");
    });
    const u = await e.execute(a.intentId, f.scope);
    expect(u.state).toBe("unknown");
    await f.reconnect();
    const recovered = f.executor();
    expect((await recovered.execute(a.intentId, f.scope)).state).toBe(
      "unknown",
    );
    const r = await recovered.reconcile(
      a.intentId,
      f.scope,
      f.intent.authorizationId,
    );
    expect(r.state).toBe("succeeded");
    expect(f.effects()).toBe(1);
    expect(
      (
        await recovered.readReceipt(
          r.receiptId!,
          f.scope,
          f.intent.authorizationId,
        )
      ).reconcilesReceiptId,
    ).toBe(u.receiptId);
    expect(
      (
        await recovered.readReceipt(
          u.receiptId!,
          f.scope,
          f.intent.authorizationId,
        )
      ).outcome.status,
    ).toBe("unknown");
  });
  it("committed completion before ack survives reconnect and duplicate workers", async () => {
    const f = await fixture(postgres),
      a = await f.db.actions.register(f.intent);
    const admitted = await f.db.actions.admit(a.intentId, f.scope, 30000);
    f.effect();
    await f.db.actions.finish(admitted.claim!, f.scope, success);
    await f.reconnect();
    const results = await Promise.all([
      f.executor().execute(a.intentId, f.scope),
      f.executor().execute(a.intentId, f.scope),
    ]);
    expect(results.every((r) => r.state === "succeeded")).toBe(true);
    expect(f.effects()).toBe(1);
    await f.db.actions.acknowledge(a.intentId, f.scope);
  });
  it("expired claim cannot commit late success and recovery never blindly repeats", async () => {
    const f = await fixture(postgres),
      a = await f.db.actions.register(f.intent);
    const admitted = await f.db.actions.admit(a.intentId, f.scope, 30000);
    f.effect();
    await f.db.sql.query(
      "UPDATE information_action_heads SET lease_until=clock_timestamp()-interval '1 second' WHERE intent_id=$1",
      [a.intentId],
    );
    await expect(
      f.db.actions.finish(admitted.claim!, f.scope, success),
    ).rejects.toThrow("claim-lost");
    expect((await f.executor().execute(a.intentId, f.scope)).state).toBe(
      "unknown",
    );
    expect(f.effects()).toBe(1);
  });
  it("two workers call the provider only once while unrelated publications preserve admission", async () => {
    const f = await fixture(postgres),
      a = await f.db.actions.register(f.intent),
      entered = barrier(),
      release = barrier();
    await f.db.memoryGraph.native.publish({
      operationId: "unrelated",
      actor: "manual",
      nodes: [],
    });
    f.behavior(async () => {
      f.effect();
      entered.release();
      await release.promise;
      return success;
    });
    const first = f.executor().execute(a.intentId, f.scope);
    cleanups.push(async () => {
      release.release();
      await first;
    });
    await enteredBeforeCompletion(first, entered.promise);
    expect((await f.executor().execute(a.intentId, f.scope)).state).toBe(
      "started",
    );
    release.release();
    expect((await first).state).toBe("succeeded");
    expect(f.effects()).toBe(1);
  });
});
