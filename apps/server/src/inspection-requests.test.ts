/**
 * 功能概述：在隔离 PGlite 上验证逐次模型请求的真实只读路由、因果投影、历史归属与完整脱敏 Prompt。
 * 主要职责：seedRequest 构造精确引用链；用 Fastify inject 覆盖分页、非赢家输出、取消/打断、缺失来源和直接/授权投递。
 * 代码库关系：消费正式 inspection 服务与 Schema，纯内存游标测试单独核实 501 条扫描边界；不启动模型、Runtime 或后台队列。
 * 输入输出与副作用：初始化和写入均显式 await；beforeAll 为 PGlite 留 15 秒预算，afterAll 关闭数据库，无固定 sleep 或短轮询。
 */
import Fastify from "fastify";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  freezeInformationAtom,
  type InformationAtom,
  type InspectionModule,
  inspectionRequestDetailSchema,
  inspectionRequestPageSchema,
} from "@kaguya/schema";
import {
  createInspectionService,
  registerInspectionRoutes,
} from "./inspection.js";
import { requestPage, type RequestBrowser } from "./inspection-requests.js";

let database: Awaited<ReturnType<typeof createTestingDatabase>>;
const app = Fastify();
const time = "2026-09-19T10:00:00.000Z";
const headers = { authorization: "Bearer test-inspection" };
const secret = "private-config-value-for-boundary";
const longText = "消息".repeat(134) + secret + "完整尾部";
const longPrompt =
  "冻结 Prompt\n" + "具体上下文。".repeat(2500) + secret + "\nPrompt 最后一行";
const target = {
  adapterId: "test",
  platform: "qq",
  destination: { kind: "group", groupId: "group-a" },
};
const planner: RequestBrowser = {
  id: "requests",
  type: "model-request-browser",
  area: "main",
  viewId: "requests",
  taskId: "agent.turn.plan",
  mode: "planner",
};
const composer: RequestBrowser = {
  ...planner,
  taskId: "agent.message.compose",
  mode: "composer",
};
function moduleFor(
  definitionId: string,
  browser: RequestBrowser,
): InspectionModule {
  return {
    definitionId,
    displayName: definitionId,
    summary: "请求记录",
    description: "测试",
    moduleVersion: "1",
    protocolVersion: 1,
    settingsSchemaFingerprint: "test",
    consumes: [],
    produces: [],
    selectors: [],
    promptRenderers: [],
    diagnostics: [],
    requires: [],
    provides: [],
    bindings: [{ instanceId: "new-instance", capabilities: [] }],
    inspection: {
      mechanism: [],
      views: [],
      surface: {
        version: 1,
        id: "requests",
        title: "请求",
        layout: { type: "sections", areas: ["main"] },
        components: [browser],
      },
    },
  };
}
const modules = [
  moduleFor("agent.heartflow.online", planner),
  moduleFor("agent.message-composer", composer),
];
const base = (mode: "planner" | "composer" = "planner") =>
  `/api/v1/inspection/modules/${mode === "planner" ? "agent.heartflow.online" : "agent.message-composer"}/surfaces/requests`;
const get = (suffix = "", mode: "planner" | "composer" = "planner") =>
  app.inject({ method: "GET", url: base(mode) + suffix, headers });
const ref = (relation: string, informationId: string) => ({
  relation,
  informationId,
});
const context = ref("core:context", "runtime-context");
async function append(
  id: string,
  kind: string,
  payload: InformationAtom["payload"] = {},
  references: InformationAtom["references"] = [],
) {
  const atom = freezeInformationAtom({
    informationId: id,
    kind,
    occurredAt: time,
    source: "test:inspection",
    payload,
    references,
  });
  await database.information.append(
    atom,
    [...new Set(references.map((r) => r.relation))].map((relation) => ({
      relation,
      required: false,
      multiple: true,
    })),
  );
  return atom;
}
type SeedOptions = {
  mode?: "planner" | "composer";
  terminal?: "completed" | "failed" | "cancelled" | "pending";
  action?: "message" | "wait" | "silent";
  adopted?: boolean;
  missingContext?: boolean;
  delivery?: "delivered" | "failed";
  confirmed?: boolean;
  authorization?: "manual" | "automatic";
};
async function seedRequest(id: string, options: SeedOptions = {}) {
  const mode = options.mode ?? "planner";
  const terminal = options.terminal ?? "completed";
  const action = options.action ?? "message";
  const browser = mode === "planner" ? planner : composer;
  const definitionId =
    mode === "planner" ? modules[0]!.definitionId : modules[1]!.definitionId;
  await append(id + "-candidate", "agent.turn.candidate");
  await append(id + "-claim", "agent.turn.claimed");
  const turn = {
    candidateInformationId: id + "-candidate",
    claimInformationId: id + "-claim",
    contextInformationId: id + "-turn",
  };
  await append(
    id + "-turn",
    "agent.turn.context.completed",
    {
      ...turn,
      inputs: [
        {
          informationId: id + "-inbound-a",
          occurredAt: time,
          text: "第一条冻结输入",
          source: { ...target, senderId: "alice" },
        },
        {
          informationId: id + "-inbound-b",
          occurredAt: time,
          text: longText,
          source: { ...target, senderId: "bob", sender: { nickname: "小白" } },
        },
      ],
    },
    [context],
  );
  if (options.authorization)
    await append(
      id + "-authorization",
      "agent.message.target.authorized",
      {
        target,
        turn,
        instruction: "向目标会话发送这条批准指令",
        expiresAt: "2026-09-19T11:00:00.000Z",
      },
      [context, ref("core:uses-context", id + "-turn")],
    );
  const sourceTurn =
    options.authorization === "manual"
      ? { ...turn, contextInformationId: id + "-authorization" }
      : turn;
  const sourceRefs = [
    context,
    ...(mode === "planner" ? [ref("core:caused-by", id + "-turn")] : []),
    ...(options.missingContext
      ? []
      : options.authorization
        ? [
            ref("core:uses-context", id + "-authorization"),
            ref("agent:target-authorization", id + "-authorization"),
          ]
        : [ref("core:uses-context", id + "-turn")]),
  ];
  await append(
    id + "-source",
    mode === "planner"
      ? "agent.attention.arousal.completed"
      : "agent.message.intent.requested",
    mode === "planner"
      ? { ...turn, turnContextInformationId: id + "-turn", outcome: "attend" }
      : { turn: sourceTurn, target },
    sourceRefs,
  );
  const metadata = {
    taskId: browser.taskId,
    version: "1",
    activation: { definitionId, instanceId: "old-instance" },
    sourceInformationId: id + "-source",
    contextInformationId: "runtime-context",
    resolvedModel: { providerId: "test-provider", modelId: "test-model" },
  };
  await append(
    id,
    "core.model.task.requested",
    { ...metadata, prompt: { text: longPrompt } },
    [context, ref("core:caused-by", id + "-source")],
  );
  if (terminal === "pending") return { metadata, turn: sourceTurn };
  await append(
    id + "-terminal",
    "core.model.task." + terminal,
    {
      ...metadata,
      ...(terminal === "completed"
        ? {
            output:
              mode === "composer"
                ? longText
                : {
                    action: "wait",
                    waitSeconds: 30,
                    reason: "await-more-context",
                  },
          }
        : terminal === "failed"
          ? {
              error: {
                kind: "provider-request",
                message: "provider rejected " + secret,
              },
            }
          : { reason: "Explicit cancellation requested" }),
    },
    [context, ref("core:caused-by", id), ref("core:status-of", id)],
  );
  if (mode === "planner" && options.adopted !== false) {
    await append(
      id + "-plan",
      "agent.turn.plan.completed",
      {
        gateInformationId: id + "-source",
        action: {
          action,
          reason: action === "silent" ? "wait-budget-exhausted" : "respond",
          ...(action === "wait" ? { waitSeconds: 30 } : {}),
        },
      },
      [
        context,
        ref("core:uses-context", id + "-terminal"),
        ref("core:caused-by", id + "-source"),
        ref("core:status-of", id + "-claim"),
      ],
    );
    if (action !== "message")
      await append(
        id + "-turn-terminal",
        "agent.turn." + (action === "wait" ? "waiting" : "silent"),
        { ...turn, dueAt: "2026-09-19T10:00:30.000Z" },
        [
          context,
          ref("core:caused-by", id + "-source"),
          ref("core:status-of", id + "-candidate"),
          ref("agent:turn-claim", id + "-claim"),
        ],
      );
  }
  if (
    mode === "composer" &&
    terminal === "completed" &&
    options.adopted !== false
  ) {
    await append(
      id + "-assistant",
      "core.message.assistant.text",
      {
        text: longText,
        source: target,
        originatingModuleInstanceId: "old-instance",
        turn: sourceTurn,
      },
      [context, ref("core:caused-by", id + "-terminal")],
    );
    if (options.confirmed)
      await append(
        id + "-confirmed",
        "agent.message.content.confirmed",
        { assistantInformationId: id + "-assistant" },
        [context, ref("core:caused-by", id + "-assistant")],
      );
    if (options.delivery) {
      await append(
        id + "-delivery",
        "core.delivery.requested",
        {
          ...target,
          turn: sourceTurn,
          message: { kind: "text", text: longText },
        },
        [
          context,
          ref(
            "core:caused-by",
            id + (options.confirmed ? "-confirmed" : "-assistant"),
          ),
        ],
      );
      await append(
        id + "-receipt",
        "core.delivery." + options.delivery,
        {
          adapterId: target.adapterId,
          platform: target.platform,
          target: target.destination,
          ok: options.delivery === "delivered",
        },
        [
          context,
          ref("core:caused-by", id + "-delivery"),
          ref("core:status-of", id + "-delivery"),
        ],
      );
      await append(
        id + "-turn-terminal",
        "agent.turn." +
          (options.delivery === "delivered" ? "completed" : "failed"),
        {
          ...sourceTurn,
          ...(options.delivery === "delivered"
            ? { deliveryTerminalInformationId: id + "-receipt" }
            : { reason: "delivery-failed" }),
        },
        [
          context,
          ref("core:caused-by", id + "-receipt"),
          ref("core:status-of", id + "-candidate"),
          ref("agent:turn-claim", id + "-claim"),
        ],
      );
    }
  }
  return { metadata, turn: sourceTurn };
}

beforeAll(async () => {
  database = await createTestingDatabase();
  await database.prepareSchema();
  await database.information.synchronizeKinds([
    "core.runtime.context",
    "core.message.inbound.text",
    "agent.turn.candidate",
    "agent.turn.claimed",
    "agent.turn.context.completed",
    "agent.attention.arousal.completed",
    "agent.message.intent.requested",
    "agent.message.target.authorized",
    "core.model.task.requested",
    "core.model.task.completed",
    "core.model.task.failed",
    "core.model.task.cancelled",
    "agent.turn.plan.completed",
    "agent.turn.decision.interrupted",
    "agent.turn.waiting",
    "agent.turn.silent",
    "agent.turn.completed",
    "agent.turn.failed",
    "core.message.assistant.text",
    "agent.message.content.confirmed",
    "core.delivery.requested",
    "core.delivery.delivered",
    "core.delivery.failed",
  ]);
  await append("runtime-context", "core.runtime.context");
  for (const [id, options] of [
    ["plan-message", {}],
    ["plan-wait", { action: "wait" }],
    ["plan-silent", { action: "silent" }],
    ["plan-pending", { terminal: "pending" }],
    ["plan-failed", { terminal: "failed", action: "silent" }],
    ["plan-cancelled", { terminal: "cancelled", action: "silent" }],
    ["plan-interrupted", { adopted: false }],
    ["plan-missing", { missingContext: true }],
    ["compose-delivered", { mode: "composer", delivery: "delivered" }],
    ["compose-failed-delivery", { mode: "composer", delivery: "failed" }],
    [
      "compose-confirmed",
      {
        mode: "composer",
        delivery: "delivered",
        confirmed: true,
        authorization: "manual",
      },
    ],
    ["compose-authorized", { mode: "composer", authorization: "automatic" }],
    ["compose-model-only", { mode: "composer", adopted: false }],
  ] as [string, SeedOptions][])
    await seedRequest(id, options);
  await append(
    "plan-interrupt-winner",
    "agent.turn.decision.interrupted",
    {
      candidateInformationId: "plan-interrupted-candidate",
      claimInformationId: "plan-interrupted-claim",
    },
    [context, ref("core:status-of", "plan-interrupted-claim")],
  );
  await append("foreign-request", "core.model.task.requested", {
    taskId: planner.taskId,
    activation: { definitionId: "foreign-module" },
  });
  await append("wrong-task-request", "core.model.task.requested", {
    taskId: "foreign-task",
    activation: { definitionId: modules[0]!.definitionId },
  });
  registerInspectionRoutes(
    app,
    createInspectionService({
      ledger: database.information,
      modules: () => modules,
      secrets: { apiKey: secret },
    }),
    async (request, reply) => {
      if (request.headers.authorization !== headers.authorization)
        return reply.code(401).send({ error: { code: "unauthorized" } });
    },
  );
  await app.ready();
}, 15000);
afterAll(async () => {
  await app.close();
  await database?.close();
});

it("authenticates both routes, preserves historical bindings and isolates task/module and stable cursors", async () => {
  expect((await app.inject({ method: "GET", url: base() })).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        method: "GET",
        url: base() + "/requests/plan-message",
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ method: "POST", url: base(), headers })).statusCode,
  ).toBe(404);
  const firstResponse = await get("?limit=2");
  expect(firstResponse.headers["cache-control"]).toBe("no-store");
  const first = inspectionRequestPageSchema.parse(firstResponse.json().data);
  expect(first.items).toHaveLength(2);
  const second = inspectionRequestPageSchema.parse(
    (await get(`?limit=2&cursor=${first.nextCursor}`)).json().data,
  );
  expect(
    new Set([...first.items, ...second.items].map((item) => item.requestId))
      .size,
  ).toBe(4);
  expect(
    (await get(`?cursor=${first.nextCursor}`, "composer")).statusCode,
  ).toBe(400);
  expect((await get("?q=not-supported")).statusCode).toBe(400);
  expect((await get("?limit=51")).statusCode).toBe(400);
  for (const id of [
    "foreign-request",
    "wrong-task-request",
    "compose-delivered",
    "missing",
  ])
    expect((await get("/requests/" + id)).statusCode).toBe(404);
  const all = (await get()).json().data;
  expect(all.items).toHaveLength(8);
  expect(
    all.items.map((item: { requestId: string }) => item.requestId),
  ).not.toContain("wrong-task-request");
});

it("keeps frozen batches and complete prompts, redacts before truncation and never changes the ledger", async () => {
  const before = await database.information.get("plan-message");
  const response = await get("/requests/plan-message");
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const detail = inspectionRequestDetailSchema.parse(response.json().data);
  expect(detail.contextAvailable).toBe(true);
  expect(detail.inputs).toHaveLength(2);
  expect(detail.inputs[1]!.sender).toBe("小白");
  expect(detail.prompt.text).toBe(longPrompt.replaceAll(secret, "[REDACTED]"));
  expect(detail.prompt.text!.length).toBeGreaterThan(10000);
  expect(detail.request.triggerText).not.toContain(secret.slice(0, 8));
  expect((await get()).body).not.toContain(secret.slice(0, 8));
  expect(response.body).not.toContain(secret);
  expect(await database.information.get("plan-message")).toEqual(before);
});

it("shows adopted planner decisions instead of raw outputs and distinguishes pending, failed, cancelled and interrupted", async () => {
  const detail = async (id: string) =>
    inspectionRequestDetailSchema.parse(
      (await get("/requests/" + id)).json().data,
    );
  expect((await detail("plan-silent")).result).toMatchObject({
    action: "silent",
    reason: "wait-budget-exhausted",
  });
  const wait = await detail("plan-wait");
  expect(wait.request.outcomeText).toBe("等待 30 秒");
  expect(wait.trace).toContainEqual(
    expect.objectContaining({
      informationId: "plan-wait-turn-terminal",
      status: "waiting",
    }),
  );
  expect((await detail("plan-pending")).request).toMatchObject({
    status: "pending",
    outcomeText: "尚未记录结果",
  });
  expect((await detail("plan-failed")).request.status).toBe("failed");
  expect((await detail("plan-cancelled")).request.status).toBe("cancelled");
  const interrupted = await detail("plan-interrupted");
  expect(interrupted.request.status).toBe("interrupted");
  expect(interrupted.result.action).toBeUndefined();
  const missing = await detail("plan-missing");
  expect(missing.contextAvailable).toBe(false);
  expect(missing.inputs).toEqual([]);
  expect(missing.prompt.available).toBe(true);
});

it("separates generated text from direct, confirmed and failed delivery and preserves authorized instruction provenance", async () => {
  const detail = async (id: string) =>
    inspectionRequestDetailSchema.parse(
      (await get("/requests/" + id, "composer")).json().data,
    );
  const sent = await detail("compose-delivered");
  expect(sent.result.text).toBe(longText.replaceAll(secret, "[REDACTED]"));
  expect(sent.trace).toContainEqual(
    expect.objectContaining({
      informationId: "compose-delivered-receipt",
      status: "delivered",
    }),
  );
  expect(sent.trace).toContainEqual(
    expect.objectContaining({
      informationId: "compose-delivered-turn-terminal",
      status: "completed",
    }),
  );
  const failed = await detail("compose-failed-delivery");
  expect(failed.request.status).toBe("completed");
  expect(failed.trace).toContainEqual(
    expect.objectContaining({
      informationId: "compose-failed-delivery-receipt",
      status: "failed",
    }),
  );
  expect(failed.trace.some((item) => item.status === "delivered")).toBe(false);
  for (const id of ["compose-confirmed", "compose-authorized"]) {
    const authorized = await detail(id);
    expect(authorized.request.triggerKind).toBe("authorization");
    expect(authorized.inputs).toEqual([
      expect.objectContaining({
        informationId: id + "-authorization",
        sender: "授权发送要求",
        text: "向目标会话发送这条批准指令",
      }),
    ]);
    expect(authorized.contextAvailable).toBe(true);
  }
  const confirmed = await detail("compose-confirmed");
  expect(confirmed.trace).toContainEqual(
    expect.objectContaining({
      informationId: "compose-confirmed-receipt",
      status: "delivered",
    }),
  );
  const modelOnly = await detail("compose-model-only");
  expect(modelOnly.request.outcomeText).toBe("模型已返回，尚未记录最终消息");
  expect(modelOnly.result.reason).toContain("尚无对应的最终消息");
  expect(modelOnly.trace.some((item) => item.status === "delivered")).toBe(
    false,
  );
});

it("rejects mismatched model terminal metadata and unrelated planner edges in a shared runtime context", async () => {
  const request = await database.information.get("plan-message");
  await append(
    "zz-wrong-terminal",
    "core.model.task.completed",
    {
      ...request!.payload,
      sourceInformationId: "plan-wait-source",
      output: { action: "silent" },
    },
    [
      context,
      ref("core:status-of", "plan-message"),
      ref("core:caused-by", "plan-message"),
    ],
  );
  await append(
    "zz-wrong-plan",
    "agent.turn.plan.completed",
    { gateInformationId: "plan-message-source", action: { action: "silent" } },
    [
      context,
      ref("core:uses-context", "plan-message-terminal"),
      ref("core:caused-by", "plan-wait-source"),
      ref("core:status-of", "plan-wait-claim"),
    ],
  );
  const detail = inspectionRequestDetailSchema.parse(
    (await get("/requests/plan-message")).json().data,
  );
  expect(detail.result.action).toBe("message");
  expect(detail.trace.map((item) => item.informationId)).not.toContain(
    "zz-wrong-plan",
  );
  expect(detail.trace.map((item) => item.informationId)).not.toContain(
    "zz-wrong-terminal",
  );
});

it("follows the exact Planner message intent through Composer and delivery without replacing the adopted action", async () => {
  const seeded = await seedRequest("plan-downstream");
  const turn = seeded.turn;
  await append(
    "downstream-intent",
    "agent.message.intent.requested",
    { turn, target },
    [
      context,
      ref("core:caused-by", "plan-downstream-source"),
      ref("core:uses-context", turn.contextInformationId),
    ],
  );
  const metadata = {
    taskId: composer.taskId,
    version: "1",
    activation: {
      definitionId: modules[1]!.definitionId,
      instanceId: "old-instance",
    },
    sourceInformationId: "downstream-intent",
    contextInformationId: "runtime-context",
  };
  await append(
    "downstream-request",
    "core.model.task.requested",
    { ...metadata, prompt: { text: "下游自己的 Prompt" } },
    [context, ref("core:caused-by", "downstream-intent")],
  );
  await append(
    "downstream-terminal",
    "core.model.task.completed",
    { ...metadata, output: "下游正文" },
    [
      context,
      ref("core:caused-by", "downstream-request"),
      ref("core:status-of", "downstream-request"),
    ],
  );
  await append(
    "downstream-assistant",
    "core.message.assistant.text",
    {
      text: "下游正文",
      source: target,
      originatingModuleInstanceId: "old-instance",
      turn,
    },
    [context, ref("core:caused-by", "downstream-terminal")],
  );
  await append(
    "downstream-delivery",
    "core.delivery.requested",
    { ...target, turn, message: { kind: "text", text: "下游正文" } },
    [context, ref("core:caused-by", "downstream-assistant")],
  );
  await append(
    "downstream-receipt",
    "core.delivery.delivered",
    {
      adapterId: target.adapterId,
      platform: target.platform,
      target: target.destination,
      ok: true,
    },
    [
      context,
      ref("core:caused-by", "downstream-delivery"),
      ref("core:status-of", "downstream-delivery"),
    ],
  );
  await append(
    "downstream-turn-terminal",
    "agent.turn.completed",
    { ...turn, deliveryTerminalInformationId: "downstream-receipt" },
    [
      context,
      ref("core:caused-by", "downstream-receipt"),
      ref("core:status-of", turn.candidateInformationId),
      ref("agent:turn-claim", turn.claimInformationId),
    ],
  );
  const detail = inspectionRequestDetailSchema.parse(
    (await get("/requests/plan-downstream")).json().data,
  );
  expect(detail.result.action).toBe("message");
  expect(detail.prompt.text).toContain("Prompt 最后一行");
  expect(detail.prompt.text).not.toBe("下游自己的 Prompt");
  expect(detail.trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ informationId: "downstream-request" }),
      expect.objectContaining({
        informationId: "downstream-receipt",
        status: "delivered",
      }),
      expect.objectContaining({
        informationId: "downstream-turn-terminal",
        status: "completed",
      }),
    ]),
  );
  await append("plan-no-prompt", "core.model.task.requested", seeded.metadata, [
    context,
    ref("core:caused-by", "plan-downstream-source"),
  ]);
  expect(
    inspectionRequestDetailSchema.parse(
      (await get("/requests/plan-no-prompt")).json().data,
    ).prompt,
  ).toEqual({ available: false });
});

it("continues an empty bounded scan without skipping its next matching request", async () => {
  const rows = Array.from({ length: 502 }, (_, index) =>
    freezeInformationAtom({
      informationId: `scan-${String(999 - index).padStart(3, "0")}`,
      kind: "core.model.task.requested",
      occurredAt: time,
      source: "runtime:model-task",
      payload: {
        taskId: index < 501 ? "another-task" : planner.taskId,
        activation: { definitionId: modules[0]!.definitionId },
      },
      references: [],
    }),
  );
  let scanned = 0;
  const ledger = {
    get: async () => undefined,
    inspectPage: async (
      query: Parameters<typeof database.information.inspectPage>[0],
    ) => {
      if (query.referencedId) return [];
      expect(query.limit).toBeLessThanOrEqual(501);
      expect(query.payloadIn).toEqual({
        path: ["activation", "definitionId"],
        values: [modules[0]!.definitionId],
      });
      scanned++;
      return rows
        .filter(
          (row) =>
            !query.cursor || row.informationId < query.cursor.informationId,
        )
        .slice(0, query.limit);
    },
  };
  const first = await requestPage(
    ledger,
    modules[0]!.definitionId,
    planner,
    20,
  );
  expect(first.items).toEqual([]);
  expect(first.cursor?.informationId).toBe(rows[500]!.informationId);
  const second = await requestPage(
    ledger,
    modules[0]!.definitionId,
    planner,
    20,
    first.cursor!,
  );
  expect(second.items.map((item) => item.requestId)).toEqual([
    rows[501]!.informationId,
  ]);
  expect(second.cursor).toBeNull();
  expect(scanned).toBe(2);
});

it("does not borrow delivery or a completed turn from another request of the same intent", async () => {
  const current = await database.information.get("compose-delivered");
  await append(
    "compose-same-intent-pending",
    "core.model.task.requested",
    { ...current!.payload, prompt: { text: "同意图的不同冻结 Prompt" } },
    [context, ref("core:caused-by", "compose-delivered-source")],
  );
  const detail = inspectionRequestDetailSchema.parse(
    (await get("/requests/compose-same-intent-pending", "composer")).json()
      .data,
  );
  expect(detail.request.status).toBe("pending");
  expect(
    detail.trace.some(
      (item) =>
        item.kind === "core.delivery.delivered" ||
        item.kind === "agent.turn.completed",
    ),
  ).toBe(false);
  expect(detail.trace.map((item) => item.informationId)).not.toContain(
    "compose-delivered-terminal",
  );
});

it("reports bounded input truncation while preserving the latest triggering content", async () => {
  const ids = {
    candidateInformationId: "plan-message-candidate",
    claimInformationId: "plan-message-claim",
  };
  await append(
    "large-turn",
    "agent.turn.context.completed",
    {
      ...ids,
      inputs: Array.from({ length: 101 }, (_, i) => ({
        informationId: `large-input-${i}`,
        text: `冻结输入 ${i}`,
        occurredAt: time,
      })),
    },
    [context],
  );
  await append(
    "large-gate",
    "agent.attention.arousal.completed",
    { ...ids, turnContextInformationId: "large-turn" },
    [
      context,
      ref("core:caused-by", "large-turn"),
      ref("core:uses-context", "large-turn"),
    ],
  );
  const template = await database.information.get("plan-message");
  await append(
    "large-request",
    "core.model.task.requested",
    { ...template!.payload, sourceInformationId: "large-gate" },
    [context, ref("core:caused-by", "large-gate")],
  );
  const detail = inspectionRequestDetailSchema.parse(
    (await get("/requests/large-request")).json().data,
  );
  expect(detail.truncated).toBe(true);
  expect(detail.inputs).toHaveLength(100);
  expect(detail.request.inputCount).toBe(101);
  expect(detail.request.triggerText).toBe("冻结输入 100");
  expect(detail.inputs.at(-1)!.informationId).toBe("large-input-100");
});
