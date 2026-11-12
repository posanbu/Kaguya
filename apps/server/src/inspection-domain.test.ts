/**
 * 功能概述：以独立 PGlite/真实 PostgreSQL 和合成持久事实验证跨领域 Inspection 的实际 HTTP 投影。
 * fixture 只构造测试证据；所有写入先 await，GET 前后比较持久状态，不把投影测试冒充 provider 执行。
 * 覆盖认证先行、只读事务、固定边界/过滤游标、独立水位、Memory 历史、取消与迟到证据，以及内容泄露。
 * 正规来源绑定 Atom 身份；迟到结果覆盖规范 JSON 摘要、历史摘要与篡改拒绝，不依赖 JSONB 键序。
 * 代码库关系：组合正式 schema、database、Inspection 路由和 Gateway 认证；无模型/外部网络/生产数据。
 * 清理等待 Fastify 与数据库关闭；没有固定 sleep、默认轮询或未等待后台任务。
 * 显式要求 PostgreSQL 时缺少连接串直接失败，不能静默退回仅 PGlite 的验收。
 */
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import {
  actionDigest,
  withInspectionRead,
  type KaguyaDatabase,
} from "@kaguya/database";
import { freezeInformationAtom, type JsonObject } from "@kaguya/schema";
import {
  createInspectionService,
  registerInspectionRoutes,
} from "./inspection.js";
import { createGatewayAuthenticator } from "./gateway-auth.js";

const scope = JSON.stringify(["qq", "qq", "group", "G"]),
  other = JSON.stringify(["qq", "qq", "group", "H"]);
const token = "synthetic-inspection-gateway";
const address = {
  platform: "qq",
  adapterId: "qq",
  destination: { kind: "group", groupId: "G" },
};
const stamp = "2026-01-01T00:00:00.000Z";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Inspection fixture cleanup failed");
});
const postgresUrl = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !postgresUrl)
  throw new Error("PostgreSQL Inspection URL required");
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(postgresUrl
    ? [
        {
          name: "PostgreSQL",
          create: () => createPostgresTestingDatabase(postgresUrl),
        },
      ]
    : []),
];
const kinds = [
  "core.runtime.context",
  "core.message.inbound.text",
  "agent.situation.frozen",
  "agent.heavy.tool.run.v1",
  "agent.heavy.tool.step.frozen.v1",
  "core.model.task.requested",
  "core.model.task.dispatched.v1",
  "core.model.task.completed",
  "core.model.task.failed",
  "agent.heavy.tool.result.v1",
  "agent.heavy.tool.terminal.v1",
  "agent.heavy.tool.origin.cancelled.v1",
  "agent.heavy.tool.cancel.forwarded.v1",
  "core.action.intent.v1",
  "core.action.started.v1",
  "agent.action.decision.v1",
  "core.action.result.v1",
  "core.action.reconciled.v1",
  "mcp.client.late-result.v1",
  "agent.gui.task.requested.v1",
  "agent.gui.task.terminal.v1",
  "memory.native.source.v1",
  "memory.native.revision.v1",
];
async function fixture(create: () => Promise<KaguyaDatabase>) {
  const db = await create();
  cleanups.push(() => db.close());
  await db.prepareSchema();
  await db.information.synchronizeKinds(kinds);
  const app = Fastify();
  cleanups.push(() => app.close());
  let controlReads = 0;
  const service = createInspectionService({
    ledger: db.information,
    database: db,
    modules: () => [],
    secrets: { gatewayToken: token, apiKey: "private-model-key" },
    environments: () => ({
      inspect: async (id) => {
        controlReads++;
        return {
          environmentId: id,
          scope,
          generation: 4,
          state: "human",
          pendingControl: { mode: "automation", generation: 5 },
          token: "never-return-this",
        };
      },
      queryHuman: async (_id, operationId) => ({
        operationId,
        attemptId: "human-attempt",
        outcome: {
          status: "unknown",
          evidence: "unconfirmed",
          result: {
            path: "/home/private/screen.png",
            dataUrl: "data:image/png;base64,secret",
          },
        },
      }),
    }),
  });
  const auth = createGatewayAuthenticator(token);
  registerInspectionRoutes(app, service, async (req, reply) => {
    if (
      !(await auth.authorize(
        req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        "management",
      ))
    )
      return reply.code(401).send({ error: "unauthorized" });
  });
  const get = (path: string, q: Record<string, unknown> = {}) =>
    app.inject({
      url:
        "/api/v1/inspection/" +
        path +
        "?" +
        new URLSearchParams(
          Object.entries({ scope, ...q }).map(([k, v]) => [k, String(v)]),
        ).toString(),
      headers: { authorization: `Bearer ${token}` },
    });
  const atom = async (
    id: string,
    kind: string,
    payload: JsonObject = {},
    refs: { relation: string; informationId: string }[] = [],
  ) => {
    await db.information.append(
      freezeInformationAtom({
        informationId: id,
        kind,
        occurredAt: stamp,
        source: "test:inspection",
        payload,
        references: refs,
      }),
      [...new Set(refs.map((r) => r.relation))].map((relation) => ({
        relation,
        required: false,
        multiple: true,
      })),
    );
  };
  const stream = async (consumer = "agent.situation") => {
    const sid = "stream:" + consumer;
    await db.sql.query(
      "INSERT INTO information_scenes(scene_id,address,legacy_scope_key) VALUES('scene',$1::jsonb,'old') ON CONFLICT DO NOTHING",
      [JSON.stringify(address)],
    );
    await db.sql.query(
      `INSERT INTO information_observation_progress(stream_id,scene_id,consumer_id,policy_version,contract,through_position,discovered_through,allocated_through,revision)
      VALUES($1,'scene',$2,'v1',$3::jsonb,2,10,8,1) ON CONFLICT DO NOTHING`,
      [
        sid,
        consumer,
        JSON.stringify({
          consumerId: consumer,
          policyVersion: "v1",
          address,
          kinds: ["core.message.inbound.text"],
          resultKind: "agent.situation.frozen",
        }),
      ],
    );
    return sid;
  };
  const observation = async (
    id = "obs",
    manifest: unknown = null,
    consumer = "agent.situation",
  ) => {
    const sid = await stream(consumer);
    await db.sql.query(
      `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,status,manifest,complete,received_through)
      VALUES($1,$2,2,4,'["source"]','[]',true,'failed',$3::jsonb,true,10)`,
      [id, sid, JSON.stringify(manifest)],
    );
  };
  await atom("source", "core.message.inbound.text", {
    text: "original",
    source: address,
  });
  return {
    db,
    app,
    get,
    atom,
    stream,
    observation,
    controlReads: () => controlReads,
  };
}
async function actionFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  native = false,
  overrides: JsonObject = {},
) {
  const intent = {
    operationId: native
      ? `native:native-run:0:0:${actionDigest("call")}`
      : "operation",
    runInformationId: "action-run",
    decisionInformationId: "decision",
    scope,
    sceneId: "scene",
    toolName: "browser.download",
    toolCallId: "call",
    providerId: "mcp:connection",
    providerVersion: "v1",
    executor: "host",
    authorizationId: "grant",
    authorizationVersion: 1,
    domain: "tool",
    target: {
      connectionId: "connection",
      connectionRevision: "config1",
      definitionRevision: "def1",
      protocol: "stdio",
    },
    arguments: {},
    dependsOn: [],
    deadline: "2030-01-01T00:00:00.000Z",
    dependencies: {
      ...(native ? { evidenceInformationId: "model-complete" } : {}),
      observationId: "obs",
      sourceInformationIds: ["source"],
      memoryRevisions: [],
    },
    ...overrides,
  };
  await f.atom("intent", "core.action.intent.v1", intent);
  await f.db.sql.query(
    `INSERT INTO information_action_heads(intent_id,operation_id,input,digest,state,attempt_id) VALUES('intent',$3,$1::jsonb,$2,'unknown','attempt')`,
    [JSON.stringify(intent), actionDigest(intent), intent.operationId],
  );
  const outcome = {
    status: "unknown",
    evidence: "unconfirmed",
    result: {
      verificationKind: "current-file-state",
      causalAttribution: "unconfirmed",
      association: "latest-input-window",
      path: "/home/private/file",
      apiKey: "private-model-key",
    },
    artifacts: [],
    truncated: false,
    providerReceiptId: "provider-receipt",
    environmentValidation: "current",
  };
  const payload = {
    intentId: "intent",
    intent,
    attemptId: "attempt",
    startedInformationId: null,
    reconcilesReceiptId: null,
    outcome,
    resultHash: actionDigest({ result: outcome.result, artifacts: [] }),
  };
  await f.atom("receipt", "core.action.result.v1", payload, [
    { relation: "core:uses-context", informationId: "intent" },
  ]);
  await f.db.sql.query(
    "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES('receipt','intent','key')",
  );
  await f.db.sql.query(
    "UPDATE information_action_heads SET receipt_id='receipt' WHERE intent_id='intent'",
  );
  return { intent, payload, outcome };
}
async function runFixture(f: Awaited<ReturnType<typeof fixture>>) {
  await f.observation();
  await f.atom("action-run", "core.runtime.context", { scope });
  const { payload } = await actionFixture(f, true);
  const origin = {
    instanceId: "heavy",
    definitionId: "agent.heavy",
    taskId: "agent.gui.execute",
    sourceInformationId: "gui-source",
  };
  const spec = {
    origin,
    actionRunInformationId: "action-run",
    observationId: "obs",
    sceneId: "scene",
    scope,
    deadline: "2030-01-01T00:00:00.000Z",
    budget: { maxSteps: 8 },
    declarations: [
      { id: "browser.download", version: "v1", wireName: "download" },
    ],
  };
  await f.atom("gui-source", "agent.gui.task.requested.v1", {
    taskRequestId: randomUUID(),
    environmentId: "env",
    scope,
    workflowId: "workflow",
    generation: 4,
    revision: "config1",
    observationId: "obs",
    turn: { claimInformationId: "action-run" },
    activation: { instanceId: "heavy", definitionId: "agent.heavy" },
    selectionPolicy: { tier: "heavy", routeId: "gui" },
    prompt: "PRIVATE GUI PROMPT",
  });
  await f.atom("native-run", "agent.heavy.tool.run.v1", { key: "run", spec });
  await f.db.sql.query(
    "INSERT INTO information_native_tool_runs(run_id,run_key,spec,context_id,steps_count,calls_count,output_bytes) VALUES('native-run','run',$1::jsonb,'source',1,1,100)",
    [JSON.stringify(spec)],
  );
  await f.atom("step", "agent.heavy.tool.step.frozen.v1", {
    runInformationId: "native-run",
    observationId: "obs",
    stepIndex: 0,
    previousStepInformationId: null,
    modelCompletedInformationId: null,
    receiptIds: [],
    memory: null,
    supplements: [],
  });
  const nativeStep = { runInformationId: "native-run", stepIndex: 0 };
  const trimming = {
    measurement: "native-message-array-json-utf8",
    omittedSegments: 2,
    truncated: true,
    originalBytes: 4000,
    retainedBytes: 1500,
    budgetBytes: 2000,
  };
  await f.atom(
    "request",
    "core.model.task.requested",
    {
      nativeStep,
      contextTrimming: trimming,
      prompt: { text: "PRIVATE MODEL PROMPT" },
    },
    [{ relation: "core:uses-context", informationId: "step" }],
  );
  await f.atom(
    "dispatch",
    "core.model.task.dispatched.v1",
    { requestedInformationId: "request", nonce: "secret-nonce" },
    [{ relation: "core:caused-by", informationId: "request" }],
  );
  await f.db.sql.query(
    "INSERT INTO information_native_tool_steps(run_id,step_index,frozen_id,request_id,dispatched_id) VALUES('native-run',0,'step','request','dispatch')",
  );
  const call = {
    toolCallId: "call",
    toolName: "download",
    rawInput: "{}",
    input: {},
    validation: "valid",
  };
  await f.atom(
    "model-complete",
    "core.model.task.completed",
    { nativeStep, generationKind: "tool-calls", toolCalls: [call] },
    [{ relation: "core:status-of", informationId: "request" }],
  );
  await f.atom(
    "decision",
    "agent.action.decision.v1",
    {
      observationId: "obs",
      domain: "tool",
      reason: "native-call",
      policyVersion: "native-loop.v1",
    },
    [
      { relation: "core:uses-context", informationId: "model-complete" },
      { relation: "core:uses-context", informationId: "action-run" },
    ],
  );
  await f.atom(
    "paired",
    "agent.heavy.tool.result.v1",
    {
      runInformationId: "native-run",
      stepIndex: 0,
      toolCallId: "call",
      modelCompletedInformationId: "model-complete",
      intentId: "intent",
      receiptId: "receipt",
      value: {
        ...payload.outcome,
        receiptId: "receipt",
        resultHash: payload.resultHash,
      },
      outputBytes: 100,
    },
    [{ relation: "core:uses-context", informationId: "receipt" }],
  );
  await f.db.sql.query(
    "INSERT INTO information_native_tool_calls(run_id,step_index,call_index,call_id,completed_id,call,intent_id,result_id) VALUES('native-run',0,0,'call','model-complete',$1::jsonb,'intent','paired')",
    [JSON.stringify(call)],
  );
  return { origin, trimming };
}
async function publication(
  f: Awaited<ReturnType<typeof fixture>>,
  node: any,
  extra: any = {},
) {
  const id = randomUUID();
  await f.atom(id, "memory.native.revision.v1", {
    nodes: [node],
    edges: [],
    removeEdges: [],
    ...extra,
  });
  await f.db.sql.query(
    "INSERT INTO memory_native_publications(operation_id,input_hash,information_id,nodes) VALUES($1,'hash',$1,$2::jsonb)",
    [id, JSON.stringify([node])],
  );
  const row = (
    await f.db.sql.query<{ position: string }>(
      "SELECT position::text FROM information_lifecycle WHERE information_id=$1",
      [id],
    )
  ).rows[0]!;
  return { ...row, id };
}
const memorySnapshot = (position: string) => ({
  version: 1,
  status: "enabled",
  frozenAt: "2030-01-01T00:00:00.000Z",
  scope,
  owners: ["person:a"],
  cutoff: { publicationPosition: position },
  fixed: [],
  recalled: [],
  degraded: [],
  budget: { dynamicCharacters: 100, omittedNodeIds: [] },
});
for (const backend of backends)
  describe(`continuous Inspection ${backend.name}`, () => {
    it("authenticates before input parsing, sets no-store, and performs read-only transactions", async () => {
      const f = await fixture(backend.create);
      for (const path of [
        "sources/absent",
        "observations",
        "observations/absent",
        "progress",
        "runs",
        "runs/absent",
        "actions",
        "actions/absent",
        "memory/id/history",
        "gui-tasks",
        "gui-tasks/absent",
        "environments/env",
        "environments/env/operations/op",
      ]) {
        const response = await f.app.inject({
          url: "/api/v1/inspection/" + path + "?limit=bad",
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(f.controlReads()).toBe(0);
      const result = await f.get("runs", { scope: other });
      expect(result.statusCode).toBe(200);
      expect(result.json().data.items).toEqual([]);
      await expect(
        withInspectionRead(f.db.sql, (r) =>
          r.tx.query("DELETE FROM information_atoms"),
        ),
      ).rejects.toThrow();
      expect((await f.get("observations/missing")).statusCode).toBe(404);
    });
    it("keeps independent progress and holes, original frozen content and missing references", async () => {
      const f = await fixture(backend.create);
      await f.observation("obs", {
        content: { text: "frozen", prompt: { text: "private prompt" } },
        sourceInformationIds: ["source", "missing"],
      });
      await f.stream("memory.native");
      await f.db.sql.query(
        "UPDATE information_observation_progress SET through_position=0 WHERE consumer_id='memory.native'",
      );
      const before = await f.db.sql.query(
        "SELECT * FROM information_observation_progress ORDER BY stream_id",
      );
      const response = await f.get("progress");
      expect(response.statusCode).toBe(200);
      const items = response.json().data.items;
      expect(
        items.find((x: any) => x.consumerId === "memory.native")
          .successfulThrough,
      ).toBe("0");
      const p = items.find((x: any) => x.consumerId === "agent.situation");
      expect(p.successfulThrough).toBe("2");
      expect(p.holes[0].throughPosition).toBe("4");
      expect(p.backlog).toEqual({ afterPosition: "8", throughPosition: "10" });
      const detail = (await f.get("observations/obs")).json().data;
      expect(detail.manifest.value.content.text).toBe("frozen");
      expect(detail.manifest.omitted).toContain("prompt");
      expect(
        detail.references.find((r: any) => r.id === "missing").availability,
      ).toBe("missing-or-denied");
      expect(
        (
          await f.db.sql.query(
            "SELECT * FROM information_observation_progress ORDER BY stream_id",
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (await f.get("observations/obs", { scope: other })).statusCode,
      ).toBe(404);
    });
    it("binds signed cursors to filters and fixed directory upper bounds", async () => {
      const f = await fixture(backend.create);
      await f.observation("z");
      await f.observation("a");
      const first = (await f.get("observations", { limit: 1 })).json().data;
      expect(first.items[0].observationId).toBe("z");
      await f.observation("m");
      const next = (
        await f.get("observations", { cursor: first.nextCursor, limit: 1 })
      ).json().data;
      expect(next.items.map((x: any) => x.observationId)).toEqual(["a"]);
      expect(
        (
          await f.get("observations", {
            scope: other,
            cursor: first.nextCursor,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await f.get("progress", { cursor: first.nextCursor })).statusCode,
      ).toBe(400);
      expect(
        (await f.get("observations", { cursor: first.nextCursor + "x" }))
          .statusCode,
      ).toBe(400);
    });
    it("separates original unknown, provider receipt, current-file heuristic and verified late evidence", async () => {
      const f = await fixture(backend.create);
      const { intent } = await actionFixture(f);
      const envelope = {
        source: {
          scope,
          connectionId: "connection",
          connectionRevision: "config1",
          definitionRevision: "def1",
          protocol: "stdio",
          transportGeneration: "gen1",
          observedAt: stamp,
          trust: "untrusted-mcp-data",
        },
        requests: [
          {
            rpcId: 1,
            method: "tools/call",
            intentId: "intent",
            attemptId: "attempt",
            operationId: "operation",
            modelToolCallId: "call",
          },
        ],
        value: {
          result: "late",
          nested: { z: 2, a: 1 },
          dataUrl: "data:image/png;base64,private",
        },
      };
      const payload = {
        scopeKey: scope,
        envelope,
        responseDigest: `canonical-json-v1:sha256:${actionDigest(envelope.value)}`,
      };
      await f.atom("late", "mcp.client.late-result.v1", payload, [
        { relation: "core:caused-by", informationId: "intent" },
      ]);
      await f.atom(
        "wrong",
        "mcp.client.late-result.v1",
        {
          ...payload,
          envelope: {
            ...envelope,
            source: { ...envelope.source, scope: other },
          },
        },
        [{ relation: "core:caused-by", informationId: "intent" }],
      );
      // Canonical hashing accepts reordered nested JSON, but never a different value.
      expect(actionDigest(envelope.value)).toBe(
        actionDigest({
          dataUrl: envelope.value.dataUrl,
          nested: { a: 1, z: 2 },
          result: "late",
        }),
      );
      await f.atom(
        "tampered",
        "mcp.client.late-result.v1",
        {
          ...payload,
          envelope: {
            ...envelope,
            value: { ...envelope.value, result: "TAMPERED LATE VALUE" },
          },
        },
        [{ relation: "core:caused-by", informationId: "intent" }],
      );
      const legacyValue = "legacy late result";
      await f.atom(
        "legacy-late",
        "mcp.client.late-result.v1",
        {
          ...payload,
          envelope: { ...envelope, value: legacyValue },
          responseDigest: createHash("sha256")
            .update(JSON.stringify(legacyValue))
            .digest("hex"),
        },
        [{ relation: "core:caused-by", informationId: "intent" }],
      );
      const response = await f.get("actions/intent");
      expect(response.statusCode).toBe(200);
      const a = response.json().data;
      expect(a.action.state).toBe("unknown");
      expect(a.receipts[0].evidence).toBe("unconfirmed");
      expect(a.receipts[0].providerReceiptId).toBe("provider-receipt");
      expect(a.receipts[0].content.value.result.causalAttribution).toBe(
        "unconfirmed",
      );
      expect(a.lateEvidence.map((e: any) => e.informationId)).toEqual([
        "legacy-late",
        "late",
      ]);
      expect(a.rejectedEvidenceCount).toBe(2);
      expect(response.body).not.toContain("TAMPERED LATE VALUE");
      expect(response.body).not.toContain("/home/private");
      expect(response.body).not.toContain("private-model-key");
      expect(response.body).not.toContain("data:image");
      expect((await f.get("actions/intent", { scope: other })).statusCode).toBe(
        404,
      );
      expect(
        (
          await f.db.sql.query(
            "SELECT input,state FROM information_action_heads",
          )
        ).rows,
      ).toEqual([{ input: intent, state: "unknown" }]);
    });
    it("projects paired native calls with two run IDs and exact trimming metadata", async () => {
      const f = await fixture(backend.create);
      const { trimming } = await runFixture(f);
      const response = await f.get("runs/native-run");
      expect(response.statusCode, response.body).toBe(200);
      const data = response.json().data;
      expect(data.run.actionRunInformationId).toBe("action-run");
      expect(data.run.runInformationId).toBe("native-run");
      expect(data.steps[0].phase).toBe("completed");
      expect(data.steps[0].contextTrimming).toEqual(trimming);
      expect(data.calls[0].pairing).toBe("verified");
      expect(data.calls[0].receipt.id).toBe("receipt");
      expect(response.body).not.toContain("PRIVATE MODEL PROMPT");
      expect(response.body).not.toContain("secret-nonce");
      expect(
        (await f.get("runs/native-run", { scope: other })).statusCode,
      ).toBe(404);
    });
    it("keeps durable stopped and pending/forwarded cancellation independent of original unknown", async () => {
      const f = await fixture(backend.create);
      const { origin } = await runFixture(f);
      await f.atom("cancel", "agent.heavy.tool.origin.cancelled.v1", {
        originKey: actionDigest(origin),
      });
      await f.atom("stop", "agent.heavy.tool.terminal.v1", {
        runInformationId: "native-run",
        reason: "cancelled",
        modelResult: null,
      });
      await f.db.sql.query(
        "UPDATE information_native_tool_runs SET stopped_id='stop'",
      );
      const task = (await f.get("gui-tasks/gui-source")).json().data;
      expect(task.status).toBe("stopped");
      expect(task.terminalSource).toBe("native-run");
      expect(task.cancellation.state).toBe("pending");
      await f.atom(
        "forwarded",
        "agent.heavy.tool.cancel.forwarded.v1",
        { originKey: actionDigest(origin) },
        [{ relation: "core:uses-context", informationId: "cancel" }],
      );
      const next = (await f.get("gui-tasks/gui-source")).json().data;
      expect(next.cancellation).toMatchObject({
        state: "forwarded",
        forwardedInformationId: "forwarded",
      });
      expect((await f.get("actions/intent")).json().data.action.state).toBe(
        "unknown",
      );
      expect(JSON.stringify(next)).not.toContain("PRIVATE GUI PROMPT");
    });
    it("marks wrong call-result pairing invalid without exposing its contents", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      await f.atom("foreign", "agent.heavy.tool.result.v1", {
        runInformationId: "another-run",
        value: { text: "FOREIGN RESULT" },
      });
      await f.db.sql.query(
        "UPDATE information_native_tool_calls SET result_id='foreign'",
      );
      const response = await f.get("runs/native-run");
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.calls[0].pairing).toBe("invalid");
      expect(response.body).not.toContain("FOREIGN RESULT");
    });
    it("uses typed model unknown and treats missing trimming as unrecorded", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      // A separate immutable step represents the restored request; no original terminal is rewritten.
      await f.atom("step2", "agent.heavy.tool.step.frozen.v1", {
        runInformationId: "native-run",
        observationId: "obs",
        stepIndex: 1,
        memory: null,
        supplements: [],
      });
      await f.atom(
        "req2",
        "core.model.task.requested",
        { nativeStep: { runInformationId: "native-run", stepIndex: 1 } },
        [{ relation: "core:uses-context", informationId: "step2" }],
      );
      await f.atom(
        "failed2",
        "core.model.task.failed",
        { error: { reasonCode: "dispatched-without-terminal" } },
        [{ relation: "core:status-of", informationId: "req2" }],
      );
      await f.db.sql.query(
        "INSERT INTO information_native_tool_steps(run_id,step_index,frozen_id,request_id) VALUES('native-run',1,'step2','req2')",
      );
      await f.atom("stop", "agent.heavy.tool.terminal.v1", {
        runInformationId: "native-run",
        reason: "model-outcome-unknown",
        modelResult: null,
      });
      await f.db.sql.query(
        "UPDATE information_native_tool_runs SET stopped_id='stop'",
      );
      const data = (await f.get("runs/native-run")).json().data;
      expect(data.run.terminalReason).toBe("model-outcome-unknown");
      expect(data.steps[1].reasonCode).toBe("dispatched-without-terminal");
      expect(data.steps[1].contextTrimming).toBeNull();
    });
    it("pins original Memory revision and gives successor its own publication cutoff", async () => {
      const f = await fixture(backend.create);
      const id = randomUUID();
      const node = {
        id,
        content: "original knowledge",
        metadata: {
          system: "native-v1",
          kind: "person",
          ownerId: "person:a",
          scope,
          level: 1,
          revision: 1,
          status: "active",
          locked: false,
          sourceIds: [],
          aliases: [],
          tags: [],
          occurredAt: stamp,
        },
      };
      const p1 = await publication(f, node);
      await f.observation("memory-observation", {
        content: { memory: memorySnapshot(p1.position) },
      });
      const p2 = await publication(f, {
        ...node,
        content: "corrected knowledge",
        metadata: { ...node.metadata, revision: 2 },
      });
      const query = { observationId: "memory-observation" };
      const old = await f.get(`memory/${id}/history`, query);
      expect(old.statusCode, old.body).toBe(200);
      expect(old.json().data.items.map((n: any) => n.revision)).toEqual([1]);
      await f.atom("memory-run", "agent.heavy.tool.run.v1", {
        spec: { scope },
      });
      await f.db.sql.query(
        "INSERT INTO information_native_tool_runs(run_id,run_key,spec,context_id) VALUES('memory-run','memory-run',$1::jsonb,'source')",
        [JSON.stringify({ scope, observationId: "memory-observation" })],
      );
      await f.atom("successor", "agent.heavy.tool.step.frozen.v1", {
        runInformationId: "memory-run",
        observationId: "memory-observation",
        stepIndex: 1,
        memory: memorySnapshot(p2.position),
        supplements: [memorySnapshot(p1.position)],
      });
      await f.db.sql.query(
        "INSERT INTO information_native_tool_steps(run_id,step_index,frozen_id) VALUES('memory-run',1,'successor')",
      );
      const next = await f.get(`memory/${id}/history`, {
        ...query,
        stepInformationId: "successor",
        limit: 1,
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.json().data.items[0].revision).toBe(2);
      const last = await f.get(`memory/${id}/history`, {
        ...query,
        stepInformationId: "successor",
        cursor: next.json().data.nextCursor,
      });
      expect(last.json().data.items[0].revision).toBe(1);
      const epoch = (await f.db.sql.query("SELECT * FROM memory_native_epoch"))
        .rows;
      await f.get(`memory/${id}/history`, query);
      expect(
        (await f.db.sql.query("SELECT * FROM memory_native_epoch")).rows,
      ).toEqual(epoch);
    });
    it("distinguishes missing source proof from current source withdrawal without rewriting history", async () => {
      const f = await fixture(backend.create);
      const id = randomUUID();
      const node = {
        id,
        content: "PROTECTED HISTORY",
        metadata: {
          system: "native-v1",
          kind: "person",
          ownerId: "person:a",
          scope,
          level: 1,
          revision: 1,
          status: "active",
          locked: false,
          sourceIds: ["source"],
          aliases: [],
          tags: [],
          occurredAt: stamp,
        },
      };
      await f.atom("memory-native-source:source", "memory.native.source.v1", {
        memorySource: {
          id: "source",
          ownerId: "person:a",
          scope,
          text: "legacy",
        },
      });
      const p1 = await publication(f, node);
      await f.observation("memory-observation", {
        content: { memory: memorySnapshot(p1.position) },
      });
      const response = await f.get(`memory/${id}/history`, {
        observationId: "memory-observation",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.items[0].reasons).toContain(
        "source-proof-missing",
      );
      expect(response.body).not.toContain("PROTECTED HISTORY");
      const canonical = await f.get("sources/memory-native-source:source");
      expect(canonical.statusCode).toBe(200);
      expect(canonical.json().data.reason).toBe("source-proof-missing");
      const n2 = {
        ...node,
        metadata: {
          ...node.metadata,
          revision: 2,
          proofOwners: [{ ownerId: "person:a", sourceIds: ["source"] }],
        },
      };
      const p2 = await publication(f, n2);
      await f.observation("proved", {
        content: { memory: memorySnapshot(p2.position) },
      });
      expect(
        (
          await f.get(`memory/${id}/history`, {
            observationId: "proved",
            limit: 1,
          })
        ).json().data.items[0].availability,
      ).toBe("available");
      await publication(f, n2, {
        invalidations: [{ kind: "source-withdrawal", targetId: "source" }],
      });
      const withdrawn = (
        await f.get(`memory/${id}/history`, {
          observationId: "proved",
          limit: 1,
        })
      ).json().data;
      expect(withdrawn.items[0].reasons).toContain("source-withdrawal");
      expect(withdrawn.knowledgeCutoff).toBe(p2.position);
    });
    it("binds canonical source proof to the requested atom identity", async () => {
      const f = await fixture(backend.create);
      const source = {
        memorySource: {
          id: "source",
          ownerId: "person:a",
          scope,
          text: "proved source",
        },
        originalInformationId: "source",
        sourceProofVersion: 1,
        sourceOwners: ["person:a"],
      };
      const references = [
        { relation: "core:uses-context", informationId: "source" },
      ];
      await f.atom(
        "memory-native-source:source",
        "memory.native.source.v1",
        source,
        references,
      );
      await f.atom(
        "source-alias",
        "memory.native.source.v1",
        {
          ...source,
          memorySource: { ...source.memorySource, text: "UNPROVED ALIAS TEXT" },
        },
        references,
      );
      const canonical = await f.get("sources/memory-native-source:source");
      expect(canonical.statusCode, canonical.body).toBe(200);
      expect(canonical.json().data.availability).toBe("available");
      expect(canonical.json().data.content.value.memorySource.text).toBe(
        "proved source",
      );
      const alias = await f.get("sources/source-alias");
      expect(alias.statusCode, alias.body).toBe(200);
      expect(alias.json().data).toMatchObject({
        availability: "unavailable",
        reason: "source-proof-missing",
        content: null,
        references: [],
      });
      expect(alias.body).not.toContain("UNPROVED ALIAS TEXT");
      for (const variant of ["wrong-original", "wrong-reference"]) {
        await f.atom(variant, "core.message.inbound.text", {
          text: "independent source",
          source: address,
        });
        await f.atom(
          `memory-native-source:${variant}`,
          "memory.native.source.v1",
          {
            ...source,
            originalInformationId:
              variant === "wrong-original" ? "source" : variant,
            memorySource: {
              ...source.memorySource,
              id: variant,
              text: "INCONSISTENT SOURCE TEXT",
            },
          },
          [
            {
              relation: "core:uses-context",
              informationId: variant === "wrong-reference" ? "source" : variant,
            },
          ],
        );
        const invalid = await f.get(`sources/memory-native-source:${variant}`);
        expect(invalid.statusCode, invalid.body).toBe(200);
        expect(invalid.json().data.reason).toBe("source-proof-missing");
        expect(invalid.body).not.toContain("INCONSISTENT SOURCE TEXT");
      }
    });
    it("rejects directory drift from late observations and newly registered consumers", async () => {
      const f = await fixture(backend.create);
      await f.observation("z");
      await f.observation("a");
      const first = (await f.get("observations", { limit: 1 })).json().data;
      await f.observation("m");
      // Emulates a transaction whose INSERT timestamp precedes the first page but commits later.
      await f.db.sql.query(
        "UPDATE information_observations SET recorded_at=$1::timestamptz WHERE observation_id='m'",
        [stamp],
      );
      const drift = await f.get("observations", { cursor: first.nextCursor });
      expect(drift.statusCode).toBe(409);
      expect(drift.json().error.code).toBe("inspection_directory_changed");
      await f.stream("memory.native");
      const progress = (await f.get("progress", { limit: 1 })).json().data;
      await f.stream("new-consumer");
      expect(
        (await f.get("progress", { cursor: progress.nextCursor })).statusCode,
      ).toBe(409);
    });
    if (backend.name === "PostgreSQL")
      it("rejects a genuinely late commit across independent PostgreSQL transactions", async () => {
        const f = await fixture(backend.create);
        await f.observation("z");
        await f.observation("a");
        const inserted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const transaction = f.db.sql.transaction(async (tx) => {
          try {
            await tx.query(`INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,status,complete,received_through)
            VALUES('m','stream:agent.situation',2,4,'[]','[]',false,'completed',true,4)`);
            inserted.resolve();
            await release.promise;
          } catch (error) {
            inserted.reject(error);
            throw error;
          }
        });
        try {
          await inserted.promise;
          const first = await f.get("observations", { limit: 1 });
          expect(first.statusCode, first.body).toBe(200);
          expect(first.json().data.items[0].observationId).toBe("z");
          release.resolve();
          await transaction;
          const next = await f.get("observations", {
            cursor: first.json().data.nextCursor,
          });
          expect(next.statusCode, next.body).toBe(409);
          expect(next.json().error.code).toBe("inspection_directory_changed");
        } finally {
          release.resolve();
          await transaction;
        }
      });
    it("bounds the directory to 500 members and makes exhausted-window truncation explicit", async () => {
      const f = await fixture(backend.create);
      const sid = await f.stream();
      await f.db.sql.query(
        `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,status,complete,received_through)
        SELECT 'window-'||lpad(n::text,4,'0'),$1,2,4,'[]','[]',false,'completed',true,4 FROM generate_series(1,503) n`,
        [sid],
      );
      const ids = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const response = await f.get("observations", {
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        expect(response.statusCode, response.body).toBe(200);
        const data = response.json().data;
        expect(data.directory).toEqual({ limit: 500, truncated: true });
        for (const item of data.items) ids.add(item.observationId);
        cursor = data.nextCursor;
      }
      expect(ids.size).toBe(500);
      expect(cursor).toBeNull();
    });
    it("navigates scoped framework evidence and domain links without exposing operational raw payloads", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      for (const id of [
        "request",
        "dispatch",
        "model-complete",
        "receipt",
        "paired",
      ]) {
        const result = await f.get(`sources/${id}`);
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json().data.content).toBeNull();
        expect(result.json().data.reason).toBe("domain-detail-required");
        expect(
          (await f.get(`sources/${id}`, { scope: other })).statusCode,
        ).toBe(404);
      }
      const refs = (await f.get("observations/obs")).json().data.references;
      expect(refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "native-run",
            domain: "run",
            availability: "available",
          }),
          expect.objectContaining({
            id: "intent",
            domain: "action",
            availability: "available",
          }),
          expect.objectContaining({
            id: "gui-source",
            domain: "gui-task",
            availability: "available",
          }),
        ]),
      );
    });
    it("reads migrated legacy run cancellation from its durable origin key", async () => {
      const f = await fixture(backend.create);
      const { origin } = await runFixture(f);
      await f.db.sql.query(
        "UPDATE information_native_tool_runs SET spec=spec-'origin',origin_key=$1",
        [actionDigest(origin)],
      );
      await f.atom("legacy-cancel", "agent.heavy.tool.origin.cancelled.v1", {
        originKey: actionDigest(origin),
      });
      expect(
        (await f.get("runs/native-run")).json().data.cancellation.state,
      ).toBe("pending");
      await f.atom(
        "legacy-forward",
        "agent.heavy.tool.cancel.forwarded.v1",
        { originKey: actionDigest(origin) },
        [{ relation: "core:uses-context", informationId: "legacy-cancel" }],
      );
      expect(
        (await f.get("runs/native-run")).json().data.cancellation,
      ).toMatchObject({
        state: "forwarded",
        forwardedInformationId: "legacy-forward",
      });
    });
    it("rejects a substituted result value even when all identity fields match", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      const old = (
        await f.db.sql.query(
          "SELECT payload FROM information_atoms WHERE information_id='paired'",
        )
      ).rows[0]!.payload as JsonObject;
      await f.atom(
        "substituted",
        "agent.heavy.tool.result.v1",
        { ...old, value: { text: "SUBSTITUTED VALUE" } },
        [{ relation: "core:uses-context", informationId: "receipt" }],
      );
      await f.db.sql.query(
        "UPDATE information_native_tool_calls SET result_id='substituted'",
      );
      const result = await f.get("runs/native-run");
      expect(result.json().data.calls[0].pairing).toBe("invalid");
      expect(result.body).not.toContain("SUBSTITUTED VALUE");
    });
    it("redacts top-level provider identifiers and reports bounded omitted references", async () => {
      const f = await fixture(backend.create);
      const { payload } = await actionFixture(f);
      await f.atom(
        "sensitive-receipt",
        "core.action.result.v1",
        {
          ...payload,
          outcome: {
            ...payload.outcome,
            providerReceiptId:
              "https://user:private-model-key@provider/receipt /home/private/key",
          },
        },
        [{ relation: "core:uses-context", informationId: "intent" }],
      );
      await f.db.sql.query(
        "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES('sensitive-receipt','intent','sensitive-key')",
      );
      const result = await f.get("actions/intent");
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).not.toContain("private-model-key");
      expect(result.body).not.toContain("/home/private/key");
      await f.observation("bounded", {
        sourceInformationIds: Array.from(
          { length: 102 },
          (_, i) => `missing-${i}`,
        ),
      });
      const bounded = (await f.get("observations/bounded")).json().data;
      expect(bounded.references).toHaveLength(100);
      expect(bounded.referencesTruncated).toBe(true);
    });
    it("omits nested native Memory text from original bundles while retaining historical identities", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      const node = {
        id: randomUUID(),
        content: "UNPROVED NESTED MEMORY",
        metadata: {
          system: "native-v1",
          revision: 1,
          aliases: ["PROTECTED ALIAS"],
        },
      };
      const snapshot = {
        ...memorySnapshot("0"),
        fixed: [node],
        pendingEvidence: [
          {
            informationId: "source",
            text: "PENDING MEMORY TEXT",
            occurredAt: stamp,
          },
        ],
        recalled: [{ node, traces: [], truncated: false }],
      };
      await f.observation("nested", { content: { memory: snapshot } });
      const response = await f.get("observations/nested");
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain("UNPROVED NESTED MEMORY");
      expect(response.body).not.toContain("PROTECTED ALIAS");
      expect(response.body).not.toContain("PENDING MEMORY TEXT");
      expect(response.json().data.manifest.omitted).toContain(
        "memory-node-content:use-history",
      );
      expect(
        response.json().data.manifest.value.content.memory.fixed[0],
      ).toEqual({ nodeId: node.id, revision: 1 });
    });
    it("rejects a GUI terminal linked to a foreign native run", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      await f.atom(
        "wrong-gui-terminal",
        "agent.gui.task.terminal.v1",
        {
          status: "completed",
          runInformationId: "foreign-run",
          reason: "final",
          output: "FOREIGN OUTPUT",
        },
        [
          { relation: "core:status-of", informationId: "gui-source" },
          { relation: "core:caused-by", informationId: "gui-source" },
        ],
      );
      const response = await f.get("gui-tasks/gui-source");
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("FOREIGN OUTPUT");
    });
    it("rejects malformed chat scopes with 400 while retaining opaque scopes in other domains", async () => {
      const f = await fixture(backend.create);
      for (const route of ["observations", "progress", "observations/missing"])
        for (const bad of ["not-json", "{}", '["qq"]']) {
          const response = await f.get(route, { scope: bad });
          expect(response.statusCode, response.body).toBe(400);
          expect(response.json().error.code).toBe("invalid_inspection_request");
        }
      await f.atom("opaque", "core.runtime.context", {
        scope: "opaque-tool-scope",
        text: "scoped",
      });
      expect(
        (await f.get("sources/opaque", { scope: "opaque-tool-scope" }))
          .statusCode,
      ).toBe(200);
    });
    it("binds repeated call IDs to the exact step operation and decision evidence", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      const payload = (
        await f.db.sql.query(
          "SELECT payload FROM information_atoms WHERE information_id='receipt'",
        )
      ).rows[0]!.payload as any;
      const call = (
        await f.db.sql.query(
          "SELECT call FROM information_native_tool_calls WHERE run_id='native-run'",
        )
      ).rows[0]!.call as any;
      await f.atom("reused-step", "agent.heavy.tool.step.frozen.v1", {
        runInformationId: "native-run",
        observationId: "obs",
        stepIndex: 1,
      });
      await f.atom(
        "reused-request",
        "core.model.task.requested",
        { nativeStep: { runInformationId: "native-run", stepIndex: 1 } },
        [{ relation: "core:uses-context", informationId: "reused-step" }],
      );
      await f.atom(
        "reused-completed",
        "core.model.task.completed",
        {
          nativeStep: { runInformationId: "native-run", stepIndex: 1 },
          generationKind: "tool-calls",
          toolCalls: [call],
        },
        [{ relation: "core:status-of", informationId: "reused-request" }],
      );
      await f.db.sql.query(
        "INSERT INTO information_native_tool_steps(run_id,step_index,frozen_id,request_id) VALUES('native-run',1,'reused-step','reused-request')",
      );
      const value = {
        ...payload.outcome,
        receiptId: "receipt",
        resultHash: payload.resultHash,
      };
      const result = {
        runInformationId: "native-run",
        stepIndex: 1,
        toolCallId: "call",
        modelCompletedInformationId: "reused-completed",
        intentId: "intent",
        receiptId: "receipt",
        value,
        outputBytes: 100,
      };
      await f.atom("reused-result", "agent.heavy.tool.result.v1", result, [
        { relation: "core:uses-context", informationId: "receipt" },
      ]);
      await f.db.sql.query(
        "INSERT INTO information_native_tool_calls(run_id,step_index,call_index,call_id,completed_id,call,intent_id,result_id) VALUES('native-run',1,0,'call','reused-completed',$1::jsonb,'intent','reused-result')",
        [JSON.stringify(call)],
      );
      const wrong = (await f.get("runs/native-run")).json().data;
      expect(wrong.calls.map((c: any) => c.pairing)).toEqual([
        "verified",
        "invalid",
      ]);
      expect(wrong.calls[1].result).toBeNull();
      const intent = {
        ...payload.intent,
        operationId: `native:native-run:1:0:${actionDigest("call")}`,
        decisionInformationId: "decision-next",
        dependencies: {
          ...payload.intent.dependencies,
          evidenceInformationId: "reused-completed",
        },
      };
      await f.atom(
        "decision-next",
        "agent.action.decision.v1",
        {
          observationId: "obs",
          domain: "tool",
          reason: "native-call",
          policyVersion: "native-loop.v1",
        },
        [
          { relation: "core:uses-context", informationId: "reused-completed" },
          { relation: "core:uses-context", informationId: "action-run" },
        ],
      );
      await f.atom("intent-next", "core.action.intent.v1", intent);
      await f.db.sql.query(
        "INSERT INTO information_action_heads(intent_id,operation_id,input,digest,state,attempt_id) VALUES('intent-next',$1,$2::jsonb,$3,'unknown','next-attempt')",
        [intent.operationId, JSON.stringify(intent), actionDigest(intent)],
      );
      await f.atom(
        "receipt-next",
        "core.action.result.v1",
        {
          ...payload,
          intentId: "intent-next",
          intent,
          attemptId: "next-attempt",
        },
        [{ relation: "core:uses-context", informationId: "intent-next" }],
      );
      await f.db.sql.query(
        "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES('receipt-next','intent-next','next-key')",
      );
      await f.atom(
        "result-next",
        "agent.heavy.tool.result.v1",
        {
          ...result,
          intentId: "intent-next",
          receiptId: "receipt-next",
          value: { ...value, receiptId: "receipt-next" },
        },
        [{ relation: "core:uses-context", informationId: "receipt-next" }],
      );
      await f.db.sql.query(
        "UPDATE information_native_tool_calls SET intent_id='intent-next',result_id='result-next' WHERE step_index=1",
      );
      const correct = await f.get("runs/native-run");
      expect(correct.statusCode, correct.body).toBe(200);
      expect(correct.json().data.calls.map((c: any) => c.pairing)).toEqual([
        "verified",
        "verified",
      ]);
    });
    it("rejects unregistered receipts and wrong started evidence through the formal W3 proof read", async () => {
      const f = await fixture(backend.create);
      await runFixture(f);
      const payload = (
        await f.db.sql.query(
          "SELECT payload FROM information_atoms WHERE information_id='receipt'",
        )
      ).rows[0]!.payload as any;
      await f.atom("unregistered", "core.action.result.v1", payload, [
        { relation: "core:uses-context", informationId: "intent" },
      ]);
      const paired = (
        await f.db.sql.query(
          "SELECT payload FROM information_atoms WHERE information_id='paired'",
        )
      ).rows[0]!.payload as any;
      await f.atom(
        "unregistered-result",
        "agent.heavy.tool.result.v1",
        {
          ...paired,
          receiptId: "unregistered",
          value: { ...paired.value, receiptId: "unregistered" },
        },
        [{ relation: "core:uses-context", informationId: "unregistered" }],
      );
      await f.db.sql.query(
        "UPDATE information_native_tool_calls SET result_id='unregistered-result'",
      );
      expect(
        (await f.get("runs/native-run")).json().data.calls[0].pairing,
      ).toBe("invalid");
      await f.atom("started", "core.action.started.v1", {
        intentId: "intent",
        attemptId: "attempt",
        operationId: payload.intent.operationId,
        digest: actionDigest(payload.intent),
      });
      await f.db.sql.query(
        "UPDATE information_action_heads SET started_id='started'",
      );
      for (const [id, startedInformationId, includeStarted] of [
        ["good-started", "started", true],
        ["wrong-started", "wrong", true],
        ["missing-start-ref", "started", false],
      ] as const) {
        await f.atom(
          id,
          "core.action.result.v1",
          { ...payload, startedInformationId },
          [
            { relation: "core:uses-context", informationId: "intent" },
            ...(includeStarted
              ? [{ relation: "core:uses-context", informationId: "started" }]
              : []),
          ],
        );
        await f.db.sql.query(
          "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES($1,'intent',$1)",
          [id],
        );
      }
      const response = await f.get("actions/intent");
      expect(response.statusCode, response.body).toBe(200);
      expect(
        response.json().data.receipts.map((r: any) => r.informationId),
      ).toEqual(["good-started"]);
      expect(response.json().data.rejectedEvidenceCount).toBe(3);
    });
    it("checks GUI artifacts and image/observation metadata before exposing verified receipts", async () => {
      const f = await fixture(backend.create);
      const environment = {
        environmentId: "env",
        generation: 7,
        workflowId: "flow",
        workspaceId: "workspace",
        resourceIds: [],
        leaseId: "lease",
        fencing: "7",
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
      const { payload } = await actionFixture(f, false, {
        toolName: "gui.observe",
        environment,
      });
      const image = {
        captureId: "capture",
        coordinateFrame: "desktop",
        width: 100,
        height: 100,
        originalWidth: 100,
        originalHeight: 100,
        scale: 1,
        origin: { x: 0, y: 0 },
        target: { kind: "desktop" },
        sha256: "a".repeat(64),
        mime: "image/png",
        capturedAt: stamp,
        serviceInstanceId: "service",
        driverInstanceId: "driver",
      };
      const artifact = {
        id: "artifact",
        hash: image.sha256,
        mime: image.mime,
        size: 100,
        scope,
        actionId: "intent",
        generation: 7,
        observedAt: stamp,
        source: "gui",
        retention: "durable",
      };
      const observation = {
        id: "b".repeat(64),
        environmentId: "env",
        workflowId: "flow",
        generation: 7,
      };
      const good = {
        status: "succeeded",
        evidence: "observed",
        result: { image, observation },
        artifacts: [artifact],
        truncated: false,
      };
      const variants = [
        good,
        { ...good, artifacts: [{ ...artifact, scope: other }] },
        { ...good, artifacts: [{ ...artifact, actionId: "foreign" }] },
        { ...good, artifacts: [{ ...artifact, generation: 8 }] },
        { ...good, artifacts: [{ ...artifact, hash: "c".repeat(64) }] },
        {
          ...good,
          result: {
            image,
            observation: { ...observation, environmentId: "foreign" },
          },
        },
        {
          ...good,
          result: { image, observation: { ...observation, generation: 8 } },
        },
        { ...good, status: "unknown", evidence: "returned" },
      ];
      for (const [index, outcome] of variants.entries()) {
        const id = `gui-receipt-${index}`;
        await f.atom(
          id,
          "core.action.result.v1",
          {
            ...payload,
            outcome,
            resultHash: actionDigest({
              result: outcome.result,
              artifacts: outcome.artifacts,
            }),
          },
          [{ relation: "core:uses-context", informationId: "intent" }],
        );
        await f.db.sql.query(
          "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES($1,'intent',$1)",
          [id],
        );
      }
      const response = await f.get("actions/intent");
      expect(response.statusCode, response.body).toBe(200);
      expect(
        response.json().data.receipts.map((r: any) => r.informationId),
      ).toEqual(["gui-receipt-0", "receipt"]);
      expect(response.json().data.rejectedEvidenceCount).toBe(7);
    });
    it("reads control pending generation and human outcome without exposing private bindings", async () => {
      const f = await fixture(backend.create);
      const control = (await f.get("environments/env")).json().data;
      expect(control.control).toMatchObject({
        state: "human",
        generation: 4,
        pendingControl: { generation: 5 },
      });
      expect(control.control.token).toBeUndefined();
      expect(
        (await f.get("environments/env", { scope: other })).statusCode,
      ).toBe(404);
      const op = await f.get("environments/env/operations/op");
      expect(op.statusCode).toBe(200);
      expect(op.body).not.toContain("/home/private");
      expect(op.body).not.toContain("data:image");
      expect(op.json().data.outcome.value.status).toBe("unknown");
    });
  });
