/**
 * 碰撞场景回归在第一场景意图尚未投递时打开第二场景，确认独立 claim、意图及无跨场景 supersede。
 * 迟到候选按注册顺序接续已完成回合，事件发生时间只影响语义积压，不倒置候选优先级。
 * 功能概述：通过真实 InformationCore/PGlite 验证先观察再冻结上下文、Light 分派和唯一终态。
 * 主要职责：fixture 安装 Router 与受控模型能力；appendOpportunity/decide 构造通知与观察事实；
 * waitFor/settle 按 8 秒持久化预算等待事实或 durable 队列收敛，否定断言不依赖固定休眠。
 * 代码库关系：配合 planner.test.ts 的纯编译测试及 Server 的真实模型任务协议测试；不访问外部模型。
 * 资源取得后立即登记清理；启动拒绝或 stop 失败时仍顺序释放全部资源并汇总错误。
 * 输入输出与副作用：每项测试使用独立数据库并在结束时关闭 Host/Core/数据库，保留精确输入水位与动作断言。
 * 模型替身入口断言观察成功及持久 claim/run 已存在、行动意图尚未创建；观察能力使用真实数据库实现。
 * 合成输出链验证授权/合成中间节点后的投递终态归属，包括旧式因果链、直接 claim 引用及未知结果。
 */
import { closeTestResources } from "../test-support/cleanup.js";
import {
  observationCapability,
  actionRunValidityCapability,
} from "@kaguya/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
  executionExhaustedInformationKind,
} from "@kaguya/engine";
import { z, type SceneAddress, sceneIdentity } from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
  defineModuleCapability,
} from "@kaguya/sdk";
import {
  OneShotScheduleClient,
  oneShotScheduleCapability,
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { rawContextCapability } from "@kaguya/memory";
import {
  createRouterModule,
  createSituationRuntimeModule,
  routerStateSelector,
} from "./index.js";
import { focusOpened } from "../router/focus-facts.js";
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
    payloadSchema: z
      .object({ ok: z.literal(ok), outcome: z.literal("unknown").optional() })
      .strict() as z.ZodType<{ ok: boolean; outcome?: "unknown" }>,
    references: {
      "core:context": { required: false, multiple: false },
      "core:caused-by": { required: true, multiple: false },
      "core:status-of": { required: true, multiple: false },
    },
    log: { enabled: false },
  });
const delivered = terminal("core.delivery.delivered", true);
const deliveryFailed = terminal("core.delivery.failed", false);
const modelFailed = terminal("core.model.task.failed", false);
const modelCancelled = terminal("core.model.task.cancelled", false);
// 使用中性输出节点隔离 Router 契约；平台编码与真实 TTS schema 由各自模块测试覆盖。
const outputStage = defineInformationKind({
  kind: "test.output.stage",
  displayName: "合成输出阶段",
  description: "保持因果引用的授权与合成替身。",
  payloadSchema: z.object({}).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
  },
  log: { enabled: false },
});
const outputRequest = defineInformationKind({
  kind: "test.output.requested",
  displayName: "合成投递请求",
  description: "仅验证 Router 的回合来源与投递终态契约。",
  payloadSchema: z
    .object({
      turn: z
        .object({
          candidateInformationId: z.string(),
          claimInformationId: z.string(),
          contextInformationId: z.string(),
        })
        .strict(),
      speech: z
        .object({ continuation: z.string().nullable() })
        .strict()
        .optional(),
    })
    .strict() as z.ZodType<{
    turn: {
      candidateInformationId: string;
      claimInformationId: string;
      contextInformationId: string;
    };
    speech?: { continuation: string | null };
  }>,
  references: {
    "core:context": { required: true, multiple: false },
    "core:caused-by": { required: true, multiple: false },
    "agent:turn-claim": { required: false, multiple: false },
    "agent:turn-candidate": { required: false, multiple: false },
  },
  log: { enabled: false },
});
const modelTaskCapability = defineModuleCapability<
  import("../heavy/index.js").ModelTaskCapability
>("kaguya:model-task", 1);
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await closeTestResources(clean);
});

async function fixture(
  options: {
    action?: any;
    muted?: boolean;
    now?: string;
    beforeExecute?: (
      database: Awaited<ReturnType<typeof createTestingDatabase>>,
    ) => Promise<void>;
  } = {},
) {
  const database = await createTestingDatabase();
  clean.push(() => database.close());
  await database.prepareSchema();
  const execute = vi.fn(async (request: any) => {
    await options.beforeExecute?.(database);
    return {
      status: "completed" as const,
      output: options.action ?? {
        action: "message",
        reason: "respond",
      },
      requestedInformationId: "request",
      terminalInformationId: request.sourceInformationId,
    };
  });
  const promptTemplates = loadFirstPartyPromptTemplates();
  const moduleOptions = {
    rawContextCapability,
    lightTemplate: promptTemplates.light,
    lightBootstrapPolicy: promptTemplates.lightBootstrapPolicy,
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
  };
  const module = createRouterModule(moduleOptions);
  const situation = createSituationRuntimeModule(moduleOptions);
  const catalog = defineInformationModuleCatalog(module, situation);
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContext);
  for (const definition of catalogInformationKinds(catalog)) {
    if (
      definition === executionExhaustedInformationKind ||
      definition.kind.startsWith("core.schedule.")
    )
      continue;
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
  registry.register(outputStage);
  registry.register(outputRequest);
  let sequence = 0;
  const now = () => new Date(options.now ?? "2026-09-22T08:00:10.000Z");
  const core = new InformationCore({
    registry,
    store: database.information,
    now,
    nextInformationId: () => `router-${++sequence}`,
  });
  clean.push(() => core.close());
  const host = new ModuleHost({
    core,
    catalog,
    now,
    capabilities: [
      { capability: observationCapability, value: database.observations },
      { capability: actionRunValidityCapability, value: database.actions },
      { capability: rawContextCapability, value: database.rawEvents },
      {
        capability: modelTaskCapability,
        value: { execute, cancel: async () => undefined },
      },
      {
        capability: oneShotScheduleCapability,
        value: new OneShotScheduleClient(core),
      },
    ],
  });
  clean.push(() => host.stop());
  await core.start();
  await host.start(
    [module, situation].map((definition) => ({
      instanceId:
        definition === module ? "router.test" : "router.test.situation",
      definitionId: definition.manifest.definitionId,
      settings: {
        muted: options.muted ?? false,
        focusIdleMs: 120_000,
        staleAfterMs: 120_000,
        lightInterruptMaxConsecutiveCount: 2,
      },
    })),
  );
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
    address?: SceneAddress;
  },
) {
  const at = "2026-09-22T08:00:00.000Z";
  const context = await core.register(runtimeContext, {
    occurredAt: at,
    source: "core:test",
    payload: { requestId: `request-${options.texts.join("-")}` },
    references: [],
  });
  const destination =
    options.address?.destination ??
    (options.group
      ? { kind: "group" as const, groupId: "room" }
      : {
          kind: "web" as const,
          conversationId: "00000000-0000-4000-8000-000000000001",
        });
  const source = {
    platform: options.address?.platform ?? (options.group ? "qq" : "web"),
    adapterId: options.address?.adapterId ?? "adapter",
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
  const turn = await vi.waitFor(async () => {
    const selected = await core.select(
      routerStateSelector,
      candidate.informationId,
    );
    const found = selected.find(
      (a) =>
        a.kind === turnContextCompletedInformationKind.kind &&
        a.payload.candidateInformationId === candidate.informationId,
    );
    expect(found).toBeDefined();
    return found!;
  }, PERSISTENCE_WAIT);
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
      ...(turn
        ? [
            {
              relation: "core:uses-context" as const,
              informationId: turn.informationId,
            },
          ]
        : []),
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
        "agent.router.turn.terminal",
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

// 单次状态等待 8s；双阶段用例 25s，双轮加清空 45s，新屏障用例 30s；不重复计算 decide 已确认的 context。
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

it("persists the observation and run identity before model execution can create an intent", async () => {
  let checked = false;
  const f = await fixture({
    action: { action: "silent", reason: "no-response-needed" },
    beforeExecute: async (database) => {
      const atoms = await all(database);
      const completed = atoms.find(
        (a: any) => a.kind === "agent.observation.completed.v1",
      );
      expect(completed).toBeDefined();
      const page = await database.observations.read(
        String(completed.payload.observationId),
      );
      expect(page?.status).toBe("completed");
      expect(page?.complete).toBe(true);
      expect(page?.manifest?.runInformationId).toBe(
        completed.payload.runInformationId,
      );
      const frozen = atoms.find(
        (a: any) => a.informationId === page?.manifest?.frozenInformationId,
      );
      const turn = atoms.find(
        (a: any) => a.informationId === frozen?.payload.turnInformationId,
      );
      expect(turn?.payload.claimInformationId).toBe(
        page?.manifest?.runInformationId,
      );
      expect(
        atoms.some(
          (a: any) => a.informationId === page?.manifest?.runInformationId,
        ),
      ).toBe(true);
      expect(
        atoms.filter(
          (a: any) => a.kind === messageIntentRequestedInformationKind.kind,
        ),
      ).toHaveLength(0);
      checked = true;
    },
  });
  const opportunity = await appendOpportunity(f.core, {
    texts: ["first input"],
  });
  await decide(f.core, opportunity.candidate, "observe");
  await settle(f.database);
  expect(checked).toBe(true);
}, 25000);

it("freezes before attention and defer does not call Light or advance progress", async () => {
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
  ).toBe(true);
  expect(opportunity.candidate.payload).not.toHaveProperty("text");
  await decide(core, opportunity.candidate, "defer");
  await settle(database);
  expect(
    (await all(database)).some(
      (atom: any) => atom.kind === turnContextCompletedInformationKind.kind,
    ),
  ).toBe(true);
  expect(execute).not.toHaveBeenCalled();
}, 25000);

it("freezes exactly the registration-watermark window before observe", async () => {
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
}, 25000);

it("processes a later registered opportunity with an earlier event time after a completed turn", async () => {
  const { core, database, execute } = await fixture({
    action: { action: "silent", reason: "no-response-needed" },
  });
  const first = await appendOpportunity(core, {
    texts: ["newer event"],
    occurredAt: ["2026-09-22T08:00:00.000Z"],
  });
  await decide(core, first.candidate, "observe");
  await waitFor(database, turnSilentInformationKind.kind);
  await settle(database);
  const late = await appendOpportunity(core, {
    texts: ["late event"],
    occurredAt: ["2026-09-22T07:00:00.000Z"],
  });
  await decide(core, late.candidate, "observe");
  await settle(database);
  const atoms = await all(database);
  const frozen = atoms.filter(
    (atom: any) => atom.kind === turnContextCompletedInformationKind.kind,
  );
  expect(frozen).toHaveLength(2);
  expect(frozen[1].payload.inputs.map((input: any) => input.text)).toEqual([
    "late event",
  ]);
  expect(frozen[1].payload.observedThroughInformationId).toBe(
    late.unread[0]!.informationId,
  );
  expect(
    atoms.filter((atom: any) => atom.kind === turnSilentInformationKind.kind),
  ).toHaveLength(2);
  expect(
    atoms.filter((atom: any) => atom.kind === "agent.router.turn.superseded"),
  ).toHaveLength(0);
  expect(execute).toHaveBeenCalledTimes(2);
}, 45000);

it("waits for Identity terminal before freezing the observed batch", async () => {
  const { core, database } = await fixture({
    action: { action: "silent", reason: "no-response-needed" },
  });
  const opportunity = await appendOpportunity(core, {
    texts: ["identity pending"],
    identities: false,
  });
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
  await decide(core, opportunity.candidate, "observe");
}, 25000);

it("keeps the earlier frozen input unchanged when attention receives a newer Focus lease", async () => {
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
    focusActive: false,
  });
});

it.each([
  [
    {
      action: "message",
      reason: "respond",
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
] as const)(
  "keeps Light ownership of %s",
  async (action, expectedKind) => {
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
  },
  25000,
);

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
      (atom: any) => atom.kind === "agent.router.focus.opened",
    )?.payload,
  ).toMatchObject({
    startedAt: "2026-09-22T08:00:10.000Z",
    expiresAt: "2026-09-22T08:02:10.000Z",
  });
}, 25000);

it.each([false, true])(
  "preserves work on unrelated input and rejects a persistently invalidated late decision (%s)",
  async (invalidate) => {
    let modelEntered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = await fixture({
      beforeExecute: async () => {
        modelEntered = true;
        await gate;
      },
    });
    // closeTestResources 按逆序清理，先释放模型屏障，避免失败污染 Host/Core shutdown。
    clean.push(async () => {
      release();
    });
    const op = await appendOpportunity(f.core, { texts: ["正在处理的任务"] });
    await decide(f.core, op.candidate, "observe");
    try {
      await vi.waitFor(() => expect(modelEntered).toBe(true), PERSISTENCE_WAIT);
      const turn = (
        await f.core.select(routerStateSelector, op.candidate.informationId)
      ).find((a) => a.kind === turnContextCompletedInformationKind.kind)!;
      const incoming = await f.core.register(inboundTextInformationKind, {
        occurredAt: new Date().toISOString(),
        source: "test:interjection",
        payload: {
          text: "无关插话",
          source: {
            ...(op.inputs[0]!.payload.source as any),
            platformMessageId: "later",
          },
        },
        references: [
          { relation: "core:context", informationId: op.context.informationId },
        ],
      });
      if (invalidate) {
        const s = turn.payload.source as any,
          d = s.destination;
        await f.database.actions.invalidateRun(
          String(turn.payload.claimInformationId),
          JSON.stringify([
            s.platform,
            s.adapterId,
            d.kind,
            d.userId ?? d.groupId ?? d.conversationId ?? null,
          ]),
          incoming.informationId,
        );
      }
      release();
      await settle(f.database);
      const all = await f.database.information.find({
        kinds: [messageIntentRequestedInformationKind.kind],
        limit: 100,
      });
      expect(all).toHaveLength(invalidate ? 0 : 1);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  },
  30000, // 初始化、8s 模型入口、8s 持久清空和资源清理共享总预算。
);

it("keeps two colliding legacy scopes on independent claims and model decisions", async () => {
  const f = await fixture();
  const addresses: SceneAddress[] = [
    {
      platform: "a:b",
      adapterId: "c",
      destination: { kind: "group", groupId: "d" },
    },
    {
      platform: "a",
      adapterId: "b:c",
      destination: { kind: "group", groupId: "d" },
    },
  ];
  expect(scopeOf(addresses[0]!)).toBe(scopeOf(addresses[1]!));
  const first = await appendOpportunity(f.core, {
    texts: ["scene A"],
    group: true,
    signals: ["mention-self"],
    address: addresses[0]!,
  });
  await decide(f.core, first.candidate, "observe");
  await vi.waitFor(
    () => expect(f.execute).toHaveBeenCalledTimes(1),
    PERSISTENCE_WAIT,
  );
  await settle(f.database);
  const second = await appendOpportunity(f.core, {
    texts: ["scene B"],
    group: true,
    signals: ["mention-self"],
    address: addresses[1]!,
  });
  await decide(f.core, second.candidate, "observe");
  await vi.waitFor(
    () => expect(f.execute).toHaveBeenCalledTimes(2),
    PERSISTENCE_WAIT,
  );
  await settle(f.database);
  const facts = await all(f.database);
  const claims = facts.filter(
    (a: any) => a.kind === "agent.router.turn.claimed",
  );
  expect(claims).toHaveLength(2);
  expect(
    new Set(claims.map((a: any) => a.payload.candidateInformationId)),
  ).toEqual(
    new Set([first.candidate.informationId, second.candidate.informationId]),
  );
  expect(
    claims.every(
      (a: any) =>
        a.payload.generation === 0 &&
        a.payload.predecessorTerminalInformationId === null,
    ),
  ).toBe(true);
  for (const opportunity of [first, second]) {
    const claim = claims.find(
      (a: any) =>
        a.payload.candidateInformationId ===
        opportunity.candidate.informationId,
    )!;
    expect(
      claim.references
        .filter((r: any) => r.relation === "core:uses-context")
        .map((r: any) => r.informationId),
    ).toEqual(opportunity.inputs.map((a) => a.informationId));
  }
  expect(
    facts.filter((a: any) =>
      [
        "agent.router.turn.superseded",
        "agent.router.turn.decision.superseded",
      ].includes(a.kind),
    ),
  ).toHaveLength(0);
  expect(
    facts.filter(
      (a: any) => a.kind === messageIntentRequestedInformationKind.kind,
    ),
  ).toHaveLength(2);
  const turns = facts.filter(
    (a: any) => a.kind === turnContextCompletedInformationKind.kind,
  );
  expect(
    new Set(turns.map((a: any) => sceneIdentity(a.payload.source))),
  ).toEqual(new Set(addresses.map(sceneIdentity)));
  expect((await f.database.information.reliable.health()).exhausted).toBe(0);
}, 45000); // 设置、两次 8 秒模型入口与 8 秒队列收敛；未交付的原意图仍开放，不用固定 sleep。

it.each([
  { direct: true, outcome: "delivered", continuation: false },
  { direct: true, outcome: "failed", continuation: false },
  { direct: true, outcome: "unknown", continuation: false },
  { direct: false, outcome: "delivered", continuation: false },
  { direct: false, outcome: "unknown", continuation: false },
  { direct: true, outcome: "delivered", continuation: true },
])(
  "resolves the output terminal through intermediate stages: %j",
  async ({ direct, outcome, continuation }) => {
    const { core, database } = await fixture();
    const opportunity = await appendOpportunity(core, {
      texts: ["output chain"],
    });
    await decide(core, opportunity.candidate, "observe");
    const intent = await waitFor(
      database,
      messageIntentRequestedInformationKind.kind,
    );
    const turn = intent.payload.turn;
    const contextRef = {
      relation: "core:context",
      informationId: opportunity.context.informationId,
    };
    let previous = intent;
    // 模拟 assistant、authorization、合成结果；每个节点只向上一阶段提供因果引用。
    for (let index = 0; index < 3; index++) {
      previous = await core.register(outputStage, {
        occurredAt: "2026-09-22T08:00:10.000Z",
        source: "test:output",
        payload: {},
        references: [
          contextRef,
          { relation: "core:caused-by", informationId: previous.informationId },
        ],
      });
    }
    const request = await core.register(outputRequest, {
      occurredAt: "2026-09-22T08:00:10.000Z",
      source: "test:output",
      payload: {
        turn,
        ...(continuation ? { speech: { continuation: "next segment" } } : {}),
      },
      references: [
        contextRef,
        { relation: "core:caused-by", informationId: previous.informationId },
        ...(direct
          ? [
              {
                relation: "agent:turn-claim",
                informationId: turn.claimInformationId,
              },
              {
                relation: "agent:turn-candidate",
                informationId: turn.candidateInformationId,
              },
            ]
          : []),
      ],
    });
    const receipt = await core.register(
      outcome === "delivered" ? delivered : deliveryFailed,
      {
        occurredAt: "2026-09-22T08:00:10.000Z",
        source: "test:transport",
        payload: {
          ok: outcome === "delivered",
          ...(outcome === "unknown" ? { outcome: "unknown" as const } : {}),
        },
        references: [
          contextRef,
          { relation: "core:caused-by", informationId: request.informationId },
          { relation: "core:status-of", informationId: request.informationId },
        ],
      },
    );
    await settle(database);
    expect((await database.information.reliable.health()).exhausted).toBe(0);
    const terminals = (await all(database)).filter(
      (atom: any) =>
        ["agent.router.turn.completed", "agent.router.turn.failed"].includes(
          atom.kind,
        ) &&
        atom.payload.candidateInformationId ===
          opportunity.candidate.informationId,
    );
    expect(terminals).toHaveLength(continuation ? 0 : 1);
    if (!continuation) {
      expect(terminals[0]).toMatchObject({
        kind:
          outcome === "delivered"
            ? "agent.router.turn.completed"
            : "agent.router.turn.failed",
        payload: {
          candidateInformationId: turn.candidateInformationId,
          claimInformationId: turn.claimInformationId,
          deliveryTerminalInformationId: receipt.informationId,
          ...(outcome === "delivered"
            ? {}
            : {
                reason:
                  outcome === "unknown"
                    ? "delivery-unknown"
                    : "delivery-failed",
              }),
        },
      });
    }
  },
  25000,
);
