/**
 * 功能概述：通过真实 InformationCore/PGlite 验证先观察再冻结上下文、Planner 分派和唯一终态。
 * 主要职责：fixture 安装 Heartflow 与受控模型能力；appendOpportunity/decide 构造通知与观察事实；
 * waitFor/settle 按 8 秒持久化预算等待事实或 durable 队列收敛，否定断言不依赖固定休眠。
 * 代码库关系：配合 planner.test.ts 的纯编译测试及 Server 的真实模型任务协议测试；不访问外部模型。
 * 输入输出与副作用：每项测试使用独立数据库并在结束时关闭 Host/Core/数据库，保留精确输入水位与动作断言。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
  executionExhaustedInformationKind,
} from "@kaguya/engine";
import { z } from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
  defineModuleCapability,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { createHeartflowModule } from "./index.js";
import { focusOpened } from "../attention-focus/facts.js";
import { scopeOf } from "../heartbeat/observation.js";
import {
  attentionArousalCompletedInformationKind,
  attentionArousalStateRecordedInformationKind,
  heartbeatFiredInformationKind,
  heartbeatScheduledInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  personContextCompletedInformationKind,
  turnCandidateInformationKind,
  turnContextCompletedInformationKind,
  turnSilentInformationKind,
  turnWaitingInformationKind,
  waitRequestedInformationKind,
} from "../information-kinds.js";

const runtimeContext = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "test context",
  description: "test context",
  payloadSchema: z.object({ requestId: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});
const terminal = (kind: string, ok: boolean) =>
  defineInformationKind({
    kind,
    displayName: kind,
    description: kind,
    payloadSchema: z.object({ ok: z.literal(ok) }).strict(),
    references: {
      "core:caused-by": { required: true, multiple: false },
      "core:status-of": { required: true, multiple: false },
    },
    log: { enabled: false },
  });
const delivered = terminal("core.delivery.delivered", true);
const deliveryFailed = terminal("core.delivery.failed", false);
const modelFailed = terminal("core.model.task.failed", false);
const modelCancelled = terminal("core.model.task.cancelled", false);
const modelTaskCapability = defineModuleCapability<
  import("../message-composer/index.js").ModelTaskCapability
>("kaguya:model-task", 1);
const resources: Array<{
  host: ModuleHost;
  core: InformationCore;
  database: Awaited<ReturnType<typeof createTestingDatabase>>;
}> = [];

afterEach(async () => {
  for (const item of resources.splice(0).reverse()) {
    await item.host.stop();
    await item.core.close();
    await item.database.close();
  }
});

async function fixture(
  options: {
    action?: any;
    muted?: boolean;
    now?: string;
  } = {},
) {
  const database = await createTestingDatabase();
  await database.prepareSchema();
  const execute = vi.fn(async (request: any) => ({
    status: "completed" as const,
    output: options.action ?? {
      action: "message",
      reason: "respond",
      composition: {
        focusInputIndexes: [0],
        topic: "测试话题",
        replyAct: "回应",
      },
    },
    requestedInformationId: "request",
    terminalInformationId: request.sourceInformationId,
  }));
  const promptTemplates = loadFirstPartyPromptTemplates();
  const module = createHeartflowModule({
    plannerTemplate: promptTemplates.planner,
    plannerBootstrapPolicy: promptTemplates.plannerBootstrapPolicy,
    memoryEnabled: false,
    modelTaskCapability,
    agentIdentity: {
      name: "Kaguya",
      aliases: ["辉夜"],
      persona: "测试身份",
      timeZone: "Asia/Shanghai",
    },
    deliveryDeliveredInformationKind: delivered,
    deliveryFailedInformationKind: deliveryFailed,
    modelTaskFailedInformationKind: modelFailed,
    modelTaskCancelledInformationKind: modelCancelled,
    executionExhaustedInformationKind,
  });
  const catalog = defineInformationModuleCatalog(module);
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContext);
  for (const definition of catalogInformationKinds(catalog)) {
    if (definition === executionExhaustedInformationKind) continue;
    definition.kind.startsWith("core.")
      ? registry.registerBuiltin(definition)
      : registry.register(definition);
  }
  for (const definition of [
    heartbeatScheduledInformationKind,
    heartbeatFiredInformationKind,
    attentionArousalStateRecordedInformationKind,
  ])
    registry.register(definition);
  let sequence = 0;
  const now = () => new Date(options.now ?? "2026-09-22T08:00:10.000Z");
  const core = new InformationCore({
    registry,
    store: database.information,
    now,
    nextInformationId: () => `heartflow-${++sequence}`,
  });
  const host = new ModuleHost({
    core,
    catalog,
    now,
    capabilities: [
      {
        capability: modelTaskCapability,
        value: { execute, cancel: async () => undefined },
      },
    ],
  });
  await core.start();
  await host.start([
    {
      instanceId: "heartflow.test",
      definitionId: module.manifest.definitionId,
      settings: {
        muted: options.muted ?? false,
        focusIdleMs: 120_000,
        staleAfterMs: 120_000,
        plannerInterruptMaxConsecutiveCount: 2,
      },
    },
  ]);
  resources.push({ host, core, database });
  return { core, database, execute };
}

async function appendOpportunity(
  core: InformationCore,
  options: {
    texts: string[];
    signals?: string[];
    group?: boolean;
    identities?: boolean;
    occurredAt?: string[];
    includeLower?: boolean;
  },
) {
  const at = "2026-09-22T08:00:00.000Z";
  const context = await core.register(runtimeContext, {
    occurredAt: at,
    source: "core:test",
    payload: { requestId: `request-${options.texts.join("-")}` },
    references: [],
  });
  const destination = options.group
    ? { kind: "group" as const, groupId: "room" }
    : {
        kind: "web" as const,
        conversationId: "00000000-0000-4000-8000-000000000001",
      };
  const source = {
    platform: options.group ? "qq" : "web",
    adapterId: "adapter",
    destination,
    senderId: "user",
    selfId: "bot",
  };
  const inputs = [];
  const count = options.texts.length + (options.includeLower ? 1 : 0);
  for (let index = 0; index < count; index += 1) {
    const lower = options.includeLower && index === 0;
    const inbound = await core.register(inboundTextInformationKind, {
      occurredAt:
        options.occurredAt?.[index] ??
        new Date(Date.parse(at) + index * 1000).toISOString(),
      source: "adapter:test",
      payload: {
        text: lower
          ? "already observed"
          : options.texts[index - (options.includeLower ? 1 : 0)]!,
        source: {
          ...source,
          platformMessageId: `message-${index}`,
        },
      },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    inputs.push(inbound);
    if (options.identities !== false && !lower)
      await appendIdentity(
        core,
        context.informationId,
        inbound.informationId,
        inbound.occurredAt,
      );
  }
  const heartbeat = await core.register(heartbeatScheduledInformationKind, {
    occurredAt: at,
    source: "module:heartbeat",
    payload: {
      reason: "message",
      dueAt: at,
      policyVersion: "short-heartbeat.v1",
      platform: source.platform,
      adapterId: source.adapterId,
      destination,
      sourceInformationIds: inputs.map((input) => input.informationId),
      wakeOnMessage: true,
      attempt: 0,
      rebuildAttempt: 0,
      totalWaitBudget: 1,
      scopeKey: scopeOf(source),
      asOf: at,
    },
    references: inputs
      .map((input) => ({
        relation: "core:uses-context",
        informationId: input.informationId,
      }))
      .concat([
        { relation: "core:context", informationId: context.informationId },
        { relation: "core:caused-by", informationId: inputs[0]!.informationId },
      ]),
  });
  const requested = await core.register(oneShotRequestedInformationKind, {
    occurredAt: at,
    source: "core:scheduler",
    payload: {
      operationKey: `test:${heartbeat.informationId}`,
      dueAt: at,
      input: {},
      activation: { instanceId: "heartbeat", definitionId: "heartbeat" },
    },
    references: [
      { relation: "core:caused-by", informationId: heartbeat.informationId },
    ],
  });
  const due = await core.register(oneShotDueInformationKind, {
    occurredAt: at,
    source: "core:scheduler",
    payload: {
      scheduleInformationId: requested.informationId,
      dueAt: at,
      deliveredAt: at,
    },
    references: [
      { relation: "core:status-of", informationId: requested.informationId },
    ],
  });
  await core.register(heartbeatFiredInformationKind, {
    occurredAt: at,
    source: "module:heartbeat",
    payload: { firedAt: at },
    references: [
      { relation: "core:caused-by", informationId: due.informationId },
      { relation: "core:status-of", informationId: heartbeat.informationId },
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const lower = options.includeLower ? inputs[0] : undefined;
  const unread = options.includeLower ? inputs.slice(1) : inputs;
  const candidate = await core.register(turnCandidateInformationKind, {
    occurredAt: at,
    source: "module:heartbeat",
    payload: {
      triggerInformationId: due.informationId,
      reason: "message",
      dueAt: at,
      firedAt: at,
      platform: source.platform,
      adapterId: source.adapterId,
      destination,
      ...(lower ? { unreadAfterInformationId: lower.informationId } : {}),
      unreadThroughInformationId: unread.at(-1)!.informationId,
      unreadCount: unread.length,
      signals: options.signals ?? [options.group ? "passive" : "web"],
      scopeKey: String(heartbeat.payload.scopeKey),
      asOf: unread.at(-1)!.occurredAt,
      policyVersion: "attention-opportunity.v1",
      rebuildAttempt: 0,
      attempt: 0,
      totalWaitBudget: 1,
    },
    references: [
      { relation: "core:caused-by", informationId: due.informationId },
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  return { context, inputs, unread, candidate };
}

async function appendIdentity(
  core: InformationCore,
  contextInformationId: string,
  inboundInformationId: string,
  occurredAt: string,
) {
  return core.register(personContextCompletedInformationKind, {
    occurredAt,
    source: "module:identity",
    payload: {
      status: "unresolved",
      scopeMode: "ephemeral",
      platform: "web",
      adapterId: "adapter",
    },
    references: [
      { relation: "core:caused-by", informationId: inboundInformationId },
      { relation: "core:context", informationId: contextInformationId },
      { relation: "core:status-of", informationId: inboundInformationId },
    ],
  });
}

async function decide(
  core: InformationCore,
  candidate: any,
  outcome: "observe" | "defer",
  focus?: any,
) {
  const arousalState = outcome === "observe" ? "awake" : "asleep";
  const state = await core.registerOnce(
    "test.arousal.state",
    candidate.informationId,
    attentionArousalStateRecordedInformationKind,
    {
      occurredAt: "2026-09-22T08:00:10.000Z",
      source: "module:arousal",
      payload: {
        state: arousalState,
        cause: outcome === "observe" ? "signal" : "external",
        scopeKey: candidate.payload.scopeKey,
        candidateInformationId: candidate.informationId,
        lastEvaluatedAt: "2026-09-22T08:00:10.000Z",
        lastInboundInformationId: candidate.payload.unreadThroughInformationId,
        lastActivityAt: "2026-09-22T08:00:10.000Z",
        sleepStartedAt:
          arousalState === "asleep" ? "2026-09-22T08:00:10.000Z" : null,
        lastPeriodicWakeAt: null,
        reasonCodes: outcome === "observe" ? ["test-observe"] : ["test-asleep"],
        policyVersion: "attention-observation.v1",
      },
      references: [
        { relation: "core:caused-by", informationId: candidate.informationId },
        ...candidate.references.filter(
          (reference: any) => reference.relation === "core:context",
        ),
      ],
    },
  );
  const input = {
    occurredAt: "2026-09-22T08:00:10.000Z",
    source: "module:arousal",
    payload: {
      outcome,
      arousalState,
      arousalStateInformationId: state.informationId,
      wakeSignal: outcome === "observe",
      candidateInformationId: candidate.informationId,
      scopeKey: candidate.payload.scopeKey,
      ...(candidate.payload.unreadAfterInformationId
        ? {
            unreadAfterInformationId:
              candidate.payload.unreadAfterInformationId,
          }
        : {}),
      unreadThroughInformationId: candidate.payload.unreadThroughInformationId,
      unreadCount: candidate.payload.unreadCount,
      signals: candidate.payload.signals,
      focusState: focus ? "active" : "inactive",
      ...(focus
        ? {
            focusInformationId: focus.informationId,
            focusExpiresAt: focus.payload.expiresAt,
          }
        : {}),
      reasonCodes:
        outcome === "observe"
          ? [focus ? "focus-active" : candidate.payload.signals[0]]
          : ["arousal-asleep"],
      policyVersion: "attention-observation.v1",
    },
    references: [
      { relation: "core:caused-by", informationId: candidate.informationId },
      { relation: "core:status-of", informationId: candidate.informationId },
      {
        relation: "core:uses-context" as const,
        informationId: state.informationId,
      },
      ...(focus
        ? [
            {
              relation: "core:uses-context" as const,
              informationId: focus.informationId,
            },
          ]
        : []),
      ...candidate.references.filter(
        (reference: any) => reference.relation === "core:context",
      ),
    ],
  };
  return outcome === "defer"
    ? core.commitTerminal(
        "agent.turn.terminal",
        candidate.informationId,
        attentionArousalCompletedInformationKind,
        input,
      )
    : core.register(attentionArousalCompletedInformationKind, input);
}

async function all(database: any) {
  return database.information.find({
    occurredAfter: "2026-09-21T00:00:00.000Z",
    registrationOrder: true,
    order: "asc",
    limit: 1000,
  });
}

const PERSISTENCE_WAIT = { timeout: 8000, interval: 20 } as const;
async function settle(
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
) {
  await vi.waitFor(
    async () =>
      expect((await database.information.reliable.health()).pending).toBe(0),
    PERSISTENCE_WAIT,
  );
}
async function waitFor(database: any, kind: string) {
  return vi.waitFor(async () => {
    const atom = (await all(database)).find((item: any) => item.kind === kind);
    expect(atom).toBeDefined();
    return atom;
  }, PERSISTENCE_WAIT);
}

it("does not read or freeze a turn before observe, and defer leaves it absent", async () => {
  const { core, database, execute } = await fixture();
  const opportunity = await appendOpportunity(core, {
    texts: ["ordinary group message"],
    group: true,
  });
  await settle(database);
  expect(
    (await all(database)).some(
      (atom: any) => atom.kind === turnContextCompletedInformationKind.kind,
    ),
  ).toBe(false);
  expect(opportunity.candidate.payload).not.toHaveProperty("text");
  await decide(core, opportunity.candidate, "defer");
  await settle(database);
  expect(
    (await all(database)).some(
      (atom: any) => atom.kind === turnContextCompletedInformationKind.kind,
    ),
  ).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it("freezes exactly the registration-watermark window after observe", async () => {
  const { core, database } = await fixture({
    action: { action: "silent", reason: "no-response-needed" },
  });
  const opportunity = await appendOpportunity(core, {
    texts: ["first unread", "second unread"],
    includeLower: true,
    occurredAt: [
      "2026-09-22T09:00:00.000Z",
      "2026-09-22T07:00:00.000Z",
      "2026-09-22T06:00:00.000Z",
    ],
  });
  await decide(core, opportunity.candidate, "observe");
  const context = await waitFor(
    database,
    turnContextCompletedInformationKind.kind,
  );
  expect(context.payload.inputs.map((input: any) => input.text)).toEqual([
    "first unread",
    "second unread",
  ]);
  expect(context.payload.observedThroughInformationId).toBe(
    opportunity.unread.at(-1)!.informationId,
  );
  await waitFor(database, turnSilentInformationKind.kind);
});

it("waits for Identity terminal before freezing the observed batch", async () => {
  const { core, database } = await fixture({
    action: { action: "silent", reason: "no-response-needed" },
  });
  const opportunity = await appendOpportunity(core, {
    texts: ["identity pending"],
    identities: false,
  });
  await decide(core, opportunity.candidate, "observe");
  await settle(database);
  expect(
    (await all(database)).some(
      (atom: any) => atom.kind === turnContextCompletedInformationKind.kind,
    ),
  ).toBe(false);
  await appendIdentity(
    core,
    opportunity.context.informationId,
    opportunity.unread[0]!.informationId,
    opportunity.unread[0]!.occurredAt,
  );
  await waitFor(database, turnContextCompletedInformationKind.kind);
});

it("uses the Focus lease frozen by Arousal instead of recomputing it", async () => {
  const { core, database } = await fixture({
    action: { action: "silent", reason: "no-response-needed" },
  });
  const opportunity = await appendOpportunity(core, {
    texts: ["focused group input"],
    group: true,
  });
  const focus = await core.register(focusOpened, {
    occurredAt: "2026-09-22T08:00:05.000Z",
    source: "module:test",
    payload: {
      scopeKey: opportunity.candidate.payload.scopeKey,
      generation: "frozen-focus",
      startedAt: "2026-09-22T08:00:05.000Z",
      expiresAt: "2026-09-22T08:02:05.000Z",
      reason: "delivered",
      sourceInformationId: opportunity.unread[0]!.informationId,
    },
    references: [
      {
        relation: "core:caused-by",
        informationId: opportunity.unread[0]!.informationId,
      },
      {
        relation: "core:uses-context",
        informationId: opportunity.unread[0]!.informationId,
      },
      {
        relation: "core:context",
        informationId: opportunity.context.informationId,
      },
    ],
  });
  await decide(core, opportunity.candidate, "observe", focus);
  const turn = await waitFor(
    database,
    turnContextCompletedInformationKind.kind,
  );
  expect(turn.payload).toMatchObject({
    focusActive: true,
    focusInformationId: focus.informationId,
    focusExpiresAt: focus.payload.expiresAt,
  });
});

it.each([
  [
    {
      action: "message",
      reason: "respond",
      composition: {
        focusInputIndexes: [0],
        topic: "topic",
        replyAct: "reply",
      },
    },
    messageIntentRequestedInformationKind.kind,
  ],
  [
    { action: "wait", reason: "await-more-context", waitSeconds: 30 },
    turnWaitingInformationKind.kind,
  ],
  [
    { action: "silent", reason: "no-response-needed" },
    turnSilentInformationKind.kind,
  ],
] as const)("keeps Planner ownership of %s", async (action, expectedKind) => {
  const { core, database } = await fixture({ action });
  const opportunity = await appendOpportunity(core, {
    texts: ["planner input"],
  });
  await decide(core, opportunity.candidate, "observe");
  await waitFor(database, expectedKind);
  if (action.action === "wait")
    expect(
      (await all(database)).some(
        (atom: any) => atom.kind === waitRequestedInformationKind.kind,
      ),
    ).toBe(true);
});

it("applies mute after observe and opens Focus only from a direct group signal", async () => {
  const muted = await fixture({ muted: true });
  const blocked = await appendOpportunity(muted.core, {
    texts: ["@bot hello"],
    group: true,
    signals: ["mention-self"],
  });
  await decide(muted.core, blocked.candidate, "observe");
  await waitFor(muted.database, turnSilentInformationKind.kind);
  expect(muted.execute).not.toHaveBeenCalled();
  expect(
    (await all(muted.database)).find(
      (atom: any) => atom.kind === "agent.attention.focus.opened",
    )?.payload,
  ).toMatchObject({
    startedAt: "2026-09-22T08:00:10.000Z",
    expiresAt: "2026-09-22T08:02:10.000Z",
  });
});
