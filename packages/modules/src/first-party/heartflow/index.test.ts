/**
 * 功能概述：通过真实 InformationCore、ModuleHost 与测试数据库验证 Heartflow 持久化编排。
 * fixture/appendCandidate 构造身份屏障及候选链，submitDecision 注入注意力终态；
 * atoms/waitForKind 等待异步订阅输出。Planner 测试验证严格输出、故障静默与 supersession fencing。覆盖意图去重、冻结上下文、路由、等待和失败终态，
 * 保证 composer 只收到目标与完整 turn 来源；afterEach 关闭宿主、Core 和数据库。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  executionExhaustedInformationKind,
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import {
  freezeInformationAtom,
  informationIdSchema,
  type PlatformDestination,
  z,
} from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineModuleCapability,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture as messageFixture } from "../message-composer/test-fixtures.js";
import { createHeartflowModule, heartflowSettingsSchema } from "./index.js";
import {
  heartbeatFiredInformationKind,
  heartbeatScheduledInformationKind,
  inboundTextInformationKind,
  personContextCompletedInformationKind,
  attentionArousalCompletedInformationKind,
  messageIntentRequestedInformationKind,
  turnCandidateInformationKind,
  turnClaimedInformationKind,
  turnCompletedInformationKind,
  turnContextCompletedInformationKind,
  turnDecisionSupersededInformationKind,
  turnFailedInformationKind,
  turnSilentInformationKind,
  turnSupersededInformationKind,
  turnWaitingInformationKind,
  waitRequestedInformationKind,
} from "../information-kinds.js";

const modelTaskCapability = defineModuleCapability<
  import("../message-composer/index.js").ModelTaskCapability
>("kaguya:model-task", 1);
const agentIdentity = {
  name: "Kaguya",
  aliases: ["辉夜"],
  persona: "测试身份",
};
const execute = vi.fn(async () => ({
  status: "completed",
  output: { action: "message", reason: "respond" },
  requestedInformationId: "request",
  terminalInformationId: "terminal",
}));
const runtimeContextInformationKind = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "Core Runtime Context",
  description: "Information carried by the core.runtime.context kind.",
  payloadSchema: z.object({ requestId: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const deliveryDeliveredInformationKind = defineInformationKind({
  kind: "core.delivery.delivered",
  displayName: "Core Delivery Delivered",
  description: "Information carried by the core.delivery.delivered kind.",
  payloadSchema: z.object({ ok: z.literal(true) }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
  },
  log: { enabled: false },
});

const deliveryFailedInformationKind = defineInformationKind({
  kind: "core.delivery.failed",
  displayName: "Core Delivery Failed",
  description: "Information carried by the core.delivery.failed kind.",
  payloadSchema: z.object({ ok: z.literal(false) }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
  },
  log: { enabled: false },
});

const modelTaskFailedInformationKind = defineInformationKind({
  kind: "core.model.task.failed",
  displayName: "Core Model Task Failed",
  description: "Information carried by the core.model.task.failed kind.",
  payloadSchema: z.object({ failed: z.literal(true) }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
  },
  log: { enabled: false },
});

const modelTaskCancelledInformationKind = defineInformationKind({
  kind: "core.model.task.cancelled",
  displayName: "Core Model Task Cancelled",
  description: "Information carried by the core.model.task.cancelled kind.",
  payloadSchema: z.object({ cancelled: z.literal(true) }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
  },
  log: { enabled: false },
});

const resources: Array<{
  host: ModuleHost;
  core: InformationCore;
  database: Awaited<ReturnType<typeof createTestingDatabase>>;
}> = [];

afterEach(async () => {
  execute.mockReset();
  execute.mockResolvedValue({
    status: "completed",
    output: { action: "message", reason: "respond" },
    requestedInformationId: "request",
    terminalInformationId: "terminal",
  });
  for (const { host, core, database } of resources.splice(0).reverse()) {
    await host.stop();
    await core.close();
    await database.close();
  }
});

async function fixture() {
  execute.mockClear();
  const database = await createTestingDatabase();
  await database.prepareSchema();
  const module = createHeartflowModule({
    modelTaskCapability,
    agentIdentity,
    deliveryDeliveredInformationKind,
    deliveryFailedInformationKind,
    modelTaskFailedInformationKind,
    modelTaskCancelledInformationKind,
    executionExhaustedInformationKind,
  });
  const catalog = defineInformationModuleCatalog(module);
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContextInformationKind);
  registry.registerBuiltin(inboundTextInformationKind);
  for (const definition of catalogInformationKinds(catalog)) {
    if (definition === executionExhaustedInformationKind) continue;
    if (definition.kind.startsWith("core."))
      registry.registerBuiltin(definition);
    else registry.register(definition);
  }
  for (const definition of [
    heartbeatScheduledInformationKind,
    heartbeatFiredInformationKind,
  ]) {
    registry.register(definition);
  }
  let sequence = 0;
  const core = new InformationCore({
    registry,
    store: database.information,
    nextInformationId: () => `heartflow-${++sequence}`,
    now: () => new Date("2026-09-08T00:00:10.000Z"),
  });
  const host = new ModuleHost({
    core,
    catalog,
    capabilities: [
      {
        capability: modelTaskCapability,
        value: {
          execute: async (request: any) => ({
            ...(await execute()),
            terminalInformationId: request.sourceInformationId,
          }),
        },
      },
    ],
  });
  await core.start();
  await host.start([
    {
      instanceId: "heartflow.test",
      definitionId: module.manifest.definitionId,
      settings: {
        botNames: ["Kaguya", "辉夜"],
        groupFrequency: 1,
        privateFrequency: 1,
        muted: false,
        staleAfterMs: 120_000,
      },
    },
  ]);
  resources.push({ host, core, database });
  return { core, database, module };
}

async function appendCandidate(
  core: InformationCore,
  input: {
    requestId: string;
    text: string;
    occurredAt: string;
    scopeKey?: string;
    identityBeforeCandidate?: boolean;
    appendIdentity?: boolean;
    destination?: PlatformDestination;
  },
) {
  const context = await core.register(runtimeContextInformationKind, {
    occurredAt: input.occurredAt,
    source: "core:test",
    payload: { requestId: input.requestId },
    references: [],
  });
  const source = {
    adapterId: "adapter",
    platform: "web",
    platformMessageId: input.requestId,
    destination: input.destination ?? { kind: "web" as const },
    senderId: "web",
  };
  const inbound = await core.register(inboundTextInformationKind, {
    occurredAt: input.occurredAt,
    source: "adapter:test",
    payload: { text: input.text, source },
    references: [
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const appendIdentity = () =>
    core.register(personContextCompletedInformationKind, {
      occurredAt: input.occurredAt,
      source: "module:identity",
      payload: {
        status: "unresolved" as const,
        scopeMode: "ephemeral" as const,
        platform: "web",
        adapterId: "adapter",
      },
      references: [
        { relation: "core:caused-by", informationId: inbound.informationId },
        { relation: "core:context", informationId: context.informationId },
        { relation: "core:status-of", informationId: inbound.informationId },
      ],
    });
  if (input.appendIdentity !== false && input.identityBeforeCandidate !== false)
    await appendIdentity();
  const heartbeat = await core.register(heartbeatScheduledInformationKind, {
    occurredAt: input.occurredAt,
    source: "module:heartbeat",
    payload: {
      reason: "message" as const,
      dueAt: input.occurredAt,
      policyVersion: "short-heartbeat.v1" as const,
      platform: "web",
      adapterId: "adapter",
      destination: source.destination,
      sourceInformationIds: [inbound.informationId],
      wakeOnMessage: true,
      attempt: 0,
      totalWaitBudget: 1,
      scopeKey: input.scopeKey ?? "web:adapter:web:",
      asOf: input.occurredAt,
    },
    references: [
      { relation: "core:caused-by", informationId: inbound.informationId },
      { relation: "core:context", informationId: context.informationId },
      { relation: "core:uses-context", informationId: inbound.informationId },
    ],
  });
  const requested = await core.register(oneShotRequestedInformationKind, {
    occurredAt: input.occurredAt,
    source: "core:test",
    payload: {
      operationKey: `test:${heartbeat.informationId}`,
      dueAt: input.occurredAt,
      input: {},
      activation: {
        instanceId: "heartflow.test",
        definitionId: "agent.heartbeat.short",
      },
    },
    references: [
      { relation: "core:caused-by", informationId: heartbeat.informationId },
    ],
  });
  const due = await core.register(oneShotDueInformationKind, {
    occurredAt: input.occurredAt,
    source: "core:test",
    payload: {
      scheduleInformationId: requested.informationId,
      dueAt: input.occurredAt,
      deliveredAt: input.occurredAt,
    },
    references: [
      { relation: "core:status-of", informationId: requested.informationId },
    ],
  });
  const fired = await core.register(heartbeatFiredInformationKind, {
    occurredAt: input.occurredAt,
    source: "module:heartbeat",
    payload: { firedAt: input.occurredAt },
    references: [
      { relation: "core:caused-by", informationId: due.informationId },
      { relation: "core:status-of", informationId: heartbeat.informationId },
    ],
  });
  const candidate = await core.register(turnCandidateInformationKind, {
    occurredAt: input.occurredAt,
    source: "module:heartbeat",
    payload: {
      heartbeatInformationId: heartbeat.informationId,
      reason: "message" as const,
      dueAt: input.occurredAt,
      firedAt: input.occurredAt,
      platform: "web",
      adapterId: "adapter",
      destination: source.destination,
      sourceInformationIds: [inbound.informationId],
      scopeKey: input.scopeKey ?? "web:adapter:web:",
      asOf: input.occurredAt,
      policyVersion: "short-heartbeat.v1" as const,
      attempt: 0,
      totalWaitBudget: 1,
    },
    references: [
      { relation: "core:caused-by", informationId: due.informationId },
      { relation: "agent:heartbeat-fired", informationId: fired.informationId },
      { relation: "core:context", informationId: context.informationId },
      { relation: "core:uses-context", informationId: inbound.informationId },
    ],
  });
  if (input.appendIdentity !== false && input.identityBeforeCandidate === false)
    await appendIdentity();
  return { context, inbound, candidate };
}

async function atoms(
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
) {
  return database.information.find({
    occurredAfter: "2026-09-07T00:00:00.000Z",
    limit: 1_000,
  });
}

async function waitForKind(
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
  kind: string,
) {
  return vi.waitFor(async () => {
    const found = (await atoms(database)).find((atom) => atom.kind === kind);
    expect(found).toBeDefined();
    return found!;
  });
}

async function submitDecision(
  core: InformationCore,
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
  outcome: "attend" | "defer" | "ignore",
  candidateInformationId?: string,
) {
  const state = await atoms(database);
  const claim = state.find(
    (atom) =>
      atom.kind === turnClaimedInformationKind.kind &&
      (candidateInformationId === undefined ||
        (atom.payload as any).candidateInformationId ===
          candidateInformationId),
  )!;
  const turnContext = state.find(
    (atom) =>
      atom.kind === turnContextCompletedInformationKind.kind &&
      (candidateInformationId === undefined ||
        (atom.payload as any).candidateInformationId ===
          candidateInformationId),
  )!;
  const payload = turnContext.payload as any;
  return core.commitTerminal(
    outcome === "attend" ? "agent.turn.attention" : "agent.turn.decision",
    claim.informationId,
    attentionArousalCompletedInformationKind,
    {
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "module:speech",
      payload: {
        outcome,
        text: payload.text,
        source: payload.source,
        candidateInformationId: payload.candidateInformationId,
        claimInformationId: claim.informationId,
        turnContextInformationId: turnContext.informationId,
        score: outcome === "attend" ? 80 : outcome === "defer" ? 50 : 0,
        threshold: 80,
        components: {
          relevance: 0,
          content: 0,
          pressure: 0,
          recentPresencePenalty: 0,
          frequencyFactor: 1,
          preFrequencyScore: 0,
        },
        reasonCodes: outcome === "ignore" ? ["muted"] : [],
        missingInputs: ["memory", "association"],
        policyDigest: "test-policy",
        settingsDigest: "test-settings",
        ...(outcome === "defer"
          ? {
              dueAt: "2026-09-08T00:01:00.000Z",
              delayMs: 50_000,
              wakePolicy: "recheckAt" as const,
            }
          : {}),
        attempt: 0,
        totalWaitBudget: 1,
      },
      references: [
        {
          relation: "core:caused-by",
          informationId: turnContext.informationId,
        },
        {
          relation: "core:context",
          informationId: turnContext.references.find(
            ({ relation }) => relation === "core:context",
          )!.informationId,
        },
        {
          relation: "core:uses-context",
          informationId: turnContext.informationId,
        },
        { relation: "agent:turn-claim", informationId: claim.informationId },
        { relation: "core:status-of", informationId: claim.informationId },
      ],
    },
  );
}

async function dispatchSubscription(
  module: ReturnType<typeof createHeartflowModule>,
) {
  const instance = await module.create(
    {
      instanceId: "heartflow.test",
      settings: heartflowSettingsSchema.parse({
        botNames: [],
        groupFrequency: 1,
        privateFrequency: 1,
        muted: false,
        staleAfterMs: 120_000,
      }),
      activation: {
        instanceId: "heartflow.test",
        definitionId: module.manifest.definitionId,
      },
    },
    {} as never,
  );
  return instance.subscriptions.find(
    ({ subscriptionId }) =>
      subscriptionId === "agent.heartflow.dispatch.decision",
  )!;
}

describe("heartflow", () => {
  it("joins identity whether it arrives before or after the candidate", async () => {
    const { core, database } = await fixture();
    await appendCandidate(core, {
      requestId: "late-identity",
      text: "moon",
      occurredAt: "2026-09-08T00:00:01.000Z",
      identityBeforeCandidate: false,
    });

    const context = await waitForKind(
      database,
      turnContextCompletedInformationKind.kind,
    );
    expect((context.payload as any).inputs).toHaveLength(1);
  });

  it.each([
    [
      "defer",
      waitRequestedInformationKind.kind,
      turnWaitingInformationKind.kind,
    ],
    ["ignore", undefined, turnSilentInformationKind.kind],
  ] as const)(
    "dispatches %s as a first-class terminal",
    async (action, effect, terminal) => {
      const { core, database } = await fixture();
      await appendCandidate(core, {
        requestId: action,
        text: action,
        occurredAt: "2026-09-08T00:00:01.000Z",
      });
      await waitForKind(database, turnContextCompletedInformationKind.kind);
      await submitDecision(core, database, action);
      expect(execute).not.toHaveBeenCalled();

      await waitForKind(database, terminal);
      const all = await atoms(database);
      expect(
        all.some(
          ({ kind }) => kind === messageIntentRequestedInformationKind.kind,
        ),
      ).toBe(false);
      if (effect === undefined) {
        expect(
          all.some(({ kind }) => kind === waitRequestedInformationKind.kind),
        ).toBe(false);
      } else {
        const wait = all.find(({ kind }) => kind === effect)!;
        expect((wait.payload as any).attempt).toBe(1);
      }
    },
  );

  it.each([
    { kind: "private", userId: "recipient" },
    { kind: "group", groupId: "room" },
  ] satisfies PlatformDestination[])(
    "dispatches a replayed attend decision to one intent for %j",
    async (destination) => {
      const { core, database, module } = await fixture();
      const { candidate } = await appendCandidate(core, {
        destination,
        requestId: "attend",
        text: "attend",
        occurredAt: "2026-09-08T00:00:01.000Z",
      });
      await waitForKind(database, turnContextCompletedInformationKind.kind);

      const first = await submitDecision(core, database, "attend");
      const replay = await submitDecision(core, database, "attend");
      expect(replay.informationId).toBe(first.informationId);

      const intent = await waitForKind(
        database,
        messageIntentRequestedInformationKind.kind,
      );
      const frozenContext = (await atoms(database)).find(
        ({ kind }) => kind === turnContextCompletedInformationKind.kind,
      )!;
      const claimId = (frozenContext.payload as any).claimInformationId;
      expect(intent.payload).toEqual({
        target: { adapterId: "adapter", platform: "web", destination },
        turn: {
          candidateInformationId: candidate.informationId,
          claimInformationId: claimId,
          contextInformationId: frozenContext.informationId,
        },
        memoryInformationIds: [],
      });
      expect(intent.references).toEqual(
        expect.arrayContaining([
          { relation: "core:caused-by", informationId: first.informationId },
          {
            relation: "core:uses-context",
            informationId: frozenContext.informationId,
          },
          { relation: "agent:turn-claim", informationId: claimId },
          {
            relation: "agent:turn-candidate",
            informationId: candidate.informationId,
          },
        ]),
      );
      const dispatch = await dispatchSubscription(module);
      const registerOnce = vi.fn(async (operation, key, definition, input) =>
        core.registerOnce(operation, key, definition, {
          ...input,
          source: "module:heartflow.test",
          occurredAt: first.occurredAt,
          references: [
            ...input.references,
            { relation: "core:caused-by", informationId: first.informationId },
            ...first.references.filter(
              ({ relation }) => relation === "core:context",
            ),
          ],
        }),
      );
      const replayContext = {
        select: async () => atoms(database),
        registerOnce,
        use: () => ({ execute }),
        commitTerminal: async () =>
          (await atoms(database)).find(
            (atom) => atom.kind === "agent.turn.plan.completed",
          ),
      };
      await dispatch.handle(first, replayContext as never);
      await dispatch.handle(first, replayContext as never);
      expect(registerOnce).toHaveBeenCalledTimes(2);
      expect(await registerOnce.mock.results[0]!.value).toMatchObject({
        informationId: intent.informationId,
      });
      expect(await registerOnce.mock.results[1]!.value).toMatchObject({
        informationId: intent.informationId,
      });
      expect(
        (await atoms(database)).filter(
          ({ kind }) => kind === messageIntentRequestedInformationKind.kind,
        ),
      ).toHaveLength(1);
    },
  );

  it("routes only from the latest frozen input and carries memory IDs without copying content", async () => {
    const module = createHeartflowModule({
      modelTaskCapability,
      agentIdentity,
      deliveryDeliveredInformationKind,
      deliveryFailedInformationKind,
      modelTaskFailedInformationKind,
      modelTaskCancelledInformationKind,
      executionExhaustedInformationKind,
    });
    const dispatch = await dispatchSubscription(module);
    const atom = (id: string, kind: string, payload: any) =>
      freezeInformationAtom({
        informationId: informationIdSchema.parse(id),
        kind,
        payload,
        source: "module:test",
        occurredAt: "2026-09-08T00:00:01.000Z",
        references: [
          {
            relation: "core:context",
            informationId: informationIdSchema.parse("runtime-context"),
          },
        ],
      });
    const oldSource = {
      senderId: "old-sender",
      platformMessageId: "old-message",
      adapterId: "old",
      platform: "qq",
      destination: { kind: "private", userId: "old-user" },
    };
    const latestSource = {
      adapterId: "latest",
      platform: "qq",
      destination: { kind: "group", groupId: "room" },
      platformMessageId: "incoming-id",
      senderId: "sender",
      replyTo: { platformMessageId: "quoted" },
    };
    const candidate = atom("candidate", turnCandidateInformationKind.kind, {
      scopeKey: "scope",
    });
    const claim = atom("claim", turnClaimedInformationKind.kind, {
      candidateInformationId: "candidate",
    });
    const frozenContext = atom(
      "context",
      turnContextCompletedInformationKind.kind,
      {
        ...messageFixture().atoms.find(
          (atom) => atom.kind === turnContextCompletedInformationKind.kind,
        )!.payload,
        candidateInformationId: "candidate",
        claimInformationId: "claim",
        source: oldSource,
        asOf: "2026-09-08T00:00:01.000Z",
        attempt: 0,
        totalWaitBudget: 3,
        text: "full frozen body",
        memory: ["memory-1", "memory-2"],
        inputs: [
          {
            ...(
              messageFixture().atoms.find(
                (atom) =>
                  atom.kind === turnContextCompletedInformationKind.kind,
              )!.payload as any
            ).inputs[0],
            informationId: "old",
            text: "first body",
            source: { ...latestSource, ...oldSource },
          },
          {
            ...(
              messageFixture().atoms.find(
                (atom) =>
                  atom.kind === turnContextCompletedInformationKind.kind,
              )!.payload as any
            ).inputs[1],
            informationId: "latest",
            text: "last body",
            source: latestSource,
          },
        ],
      },
    );
    const decision = atom(
      "decision",
      attentionArousalCompletedInformationKind.kind,
      {
        outcome: "attend",
        candidateInformationId: "candidate",
        claimInformationId: "claim",
        turnContextInformationId: "context",
        source: oldSource,
        attempt: 0,
        totalWaitBudget: 3,
      },
    );
    const laterInbound = atom("later", inboundTextInformationKind.kind, {
      text: "not frozen",
      source: oldSource,
    });
    const registerOnce = vi.fn(async () => decision);
    await dispatch.handle(decision, {
      select: async () => [candidate, claim, frozenContext, laterInbound],
      registerOnce,
      use: () => ({ execute }),
      commitTerminal: async (
        _operation: string,
        _key: string,
        definition: any,
        input: any,
      ) => atom("plan", definition.kind, input.payload),
    } as never);
    expect(registerOnce).toHaveBeenCalledExactlyOnceWith(
      "agent.heartflow.message-intent",
      "claim",
      messageIntentRequestedInformationKind,
      {
        payload: {
          target: {
            adapterId: "latest",
            platform: "qq",
            destination: { kind: "group", groupId: "room" },
          },
          turn: {
            candidateInformationId: "candidate",
            claimInformationId: "claim",
            contextInformationId: "context",
          },
          memoryInformationIds: ["memory-1", "memory-2"],
        },
        references: [
          { relation: "core:uses-context", informationId: "context" },
          { relation: "agent:turn-claim", informationId: "claim" },
          { relation: "agent:turn-candidate", informationId: "candidate" },
        ],
      },
    );
  });

  it("turns an exhausted online stage into one failed terminal", async () => {
    const { core, database } = await fixture();
    const { candidate } = await appendCandidate(core, {
      requestId: "exhausted",
      text: "exhausted",
      occurredAt: "2026-09-08T00:00:01.000Z",
    });
    const turnContext = await waitForKind(
      database,
      turnContextCompletedInformationKind.kind,
    );

    await core.register(executionExhaustedInformationKind, {
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "core:reliable-dag",
      payload: { subscriptionId: "core.speech.turn-context", attempts: 3 },
      references: [
        {
          relation: "core:caused-by",
          informationId: turnContext.informationId,
        },
        {
          relation: "core:status-of",
          informationId: turnContext.informationId,
        },
      ],
    });

    const failed = await waitForKind(database, turnFailedInformationKind.kind);
    expect(failed.payload as any).toMatchObject({
      candidateInformationId: candidate.informationId,
      reason: "execution-exhausted",
    });
    expect(
      (await atoms(database)).filter(
        (atom) =>
          atom.kind === turnFailedInformationKind.kind &&
          atom.references.some(
            (reference) =>
              reference.relation === "core:status-of" &&
              reference.informationId === candidate.informationId,
          ),
      ),
    ).toHaveLength(1);
  });

  it("fails the identity barrier when its inbound delivery is exhausted", async () => {
    const { core, database } = await fixture();
    const { inbound, candidate } = await appendCandidate(core, {
      requestId: "identity-exhausted",
      text: "identity exhausted",
      occurredAt: "2026-09-08T00:00:01.000Z",
      appendIdentity: false,
    });

    await core.register(executionExhaustedInformationKind, {
      occurredAt: "2026-09-08T00:00:10.000Z",
      source: "core:reliable-dag",
      payload: { subscriptionId: "core.identity.inbound", attempts: 3 },
      references: [
        { relation: "core:caused-by", informationId: inbound.informationId },
        { relation: "core:status-of", informationId: inbound.informationId },
      ],
    });

    const failed = await waitForKind(database, turnFailedInformationKind.kind);
    expect(failed.payload).toMatchObject({
      candidateInformationId: candidate.informationId,
      reason: "identity-exhausted",
    });
    expect(
      (await atoms(database)).some(
        ({ kind }) => kind === turnContextCompletedInformationKind.kind,
      ),
    ).toBe(false);
  });

  it("queues a post-decision candidate until the active turn terminates", async () => {
    const { core, database } = await fixture();
    const first = await appendCandidate(core, {
      requestId: "active-first",
      text: "first",
      occurredAt: "2026-09-08T00:00:01.000Z",
    });
    await waitForKind(database, turnContextCompletedInformationKind.kind);
    const decision = await submitDecision(core, database, "attend");
    await waitForKind(database, messageIntentRequestedInformationKind.kind);
    const second = await appendCandidate(core, {
      requestId: "queued-second",
      text: "second",
      occurredAt: "2026-09-08T00:00:02.000Z",
    });

    await vi.waitFor(async () => {
      expect(
        (await atoms(database)).filter(
          ({ kind }) => kind === turnClaimedInformationKind.kind,
        ),
      ).toHaveLength(1);
    });
    const claim = (await atoms(database)).find(
      ({ kind }) => kind === turnClaimedInformationKind.kind,
    )!;
    const completed = await core.commitTerminal(
      "agent.turn.terminal",
      first.candidate.informationId,
      turnCompletedInformationKind,
      {
        occurredAt: "2026-09-08T00:00:10.000Z",
        source: "runtime:test-delivery",
        payload: {
          candidateInformationId: first.candidate.informationId,
          claimInformationId: claim.informationId,
          scopeKey: "web:adapter:web:",
          deliveryTerminalInformationId: "simulated-delivery-terminal",
        },
        references: [
          { relation: "core:caused-by", informationId: decision.informationId },
          {
            relation: "core:context",
            informationId: first.context.informationId,
          },
          {
            relation: "core:status-of",
            informationId: first.candidate.informationId,
          },
          { relation: "agent:turn-claim", informationId: claim.informationId },
        ],
      },
    );

    const claims = await vi.waitFor(async () => {
      const current = (await atoms(database)).filter(
        ({ kind }) => kind === turnClaimedInformationKind.kind,
      );
      expect(current).toHaveLength(2);
      return current;
    });
    expect(
      claims.find(
        (atom) =>
          (atom.payload as any).candidateInformationId ===
          second.candidate.informationId,
      )?.payload,
    ).toMatchObject({
      generation: 1,
      predecessorTerminalInformationId: completed.informationId,
    });
    expect(
      (await atoms(database)).some(
        ({ kind }) => kind === turnSupersededInformationKind.kind,
      ),
    ).toBe(false);
  });

  it("supersedes an undecided turn and carries its frozen inputs forward", async () => {
    const { core, database } = await fixture();
    const first = await appendCandidate(core, {
      requestId: "first",
      text: "first",
      occurredAt: "2026-09-08T00:00:01.000Z",
    });
    await waitForKind(database, turnContextCompletedInformationKind.kind);
    const second = await appendCandidate(core, {
      requestId: "second",
      text: "second",
      occurredAt: "2026-09-08T00:00:02.000Z",
    });

    await waitForKind(database, turnDecisionSupersededInformationKind.kind);
    const all = await vi.waitFor(async () => {
      const current = await atoms(database);
      expect(
        current.some(
          (atom) =>
            atom.kind === turnSupersededInformationKind.kind &&
            atom.references.some(
              (reference) =>
                reference.relation === "core:status-of" &&
                reference.informationId === first.candidate.informationId,
            ),
        ),
      ).toBe(true);
      expect(
        current.filter(({ kind }) => kind === turnClaimedInformationKind.kind),
      ).toHaveLength(2);
      return current;
    });
    const latestContext = all
      .filter(({ kind }) => kind === turnContextCompletedInformationKind.kind)
      .find(
        (atom) =>
          (atom.payload as any).candidateInformationId ===
          second.candidate.informationId,
      )!;
    expect(
      (latestContext.payload as any).inputs.map(
        (input: any) => input.informationId,
      ),
    ).toEqual([first.inbound.informationId, second.inbound.informationId]);

    await submitDecision(
      core,
      database,
      "attend",
      second.candidate.informationId,
    );
    const intent = await waitForKind(
      database,
      messageIntentRequestedInformationKind.kind,
    );
    expect(intent.payload).toEqual({
      target: {
        adapterId: "adapter",
        platform: "web",
        destination: { kind: "web" },
      },
      turn: {
        candidateInformationId: second.candidate.informationId,
        contextInformationId: latestContext.informationId,
        claimInformationId: (latestContext.payload as any).claimInformationId,
      },
      memoryInformationIds: [],
    });
  });
});

describe("Planner durable dispatch", () => {
  it.each([
    [
      "message",
      { action: "message", reason: "respond" },
      "agent.message.intent.requested",
    ],
    [
      "wait",
      { action: "wait", reason: "await-more-context", waitSeconds: 7 },
      "agent.turn.waiting",
    ],
    [
      "silent",
      { action: "silent", reason: "no-response-needed" },
      "agent.turn.silent",
    ],
    [
      "extra destination",
      { action: "message", reason: "respond", destination: "forbidden" },
      "agent.turn.silent",
    ],
    ["invalid JSON", "not JSON", "agent.turn.silent"],
    [
      "invalid wait",
      { action: "wait", reason: "await-more-context", waitSeconds: 121 },
      "agent.turn.silent",
    ],
  ])("dispatches %s with one fenced action", async (_name, output, kind) => {
    execute.mockResolvedValue({
      status: "completed",
      output,
      requestedInformationId: "request",
      terminalInformationId: "terminal",
    } as never);
    const { core, database } = await fixture();
    await appendCandidate(core, {
      requestId: "planner",
      text: "hello",
      occurredAt: "2026-09-08T00:00:01.000Z",
    });
    await waitForKind(database, turnContextCompletedInformationKind.kind);
    await submitDecision(core, database, "attend");
    await waitForKind(database, String(kind));
    const all = await atoms(database);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      all.filter((atom) => atom.kind === "agent.turn.plan.completed"),
    ).toHaveLength(1);
    expect(all.some((atom) => atom.kind === "agent.turn.failed")).toBe(false);
    if (kind !== "agent.message.intent.requested")
      expect(
        all.some((atom) => atom.kind === "agent.message.intent.requested"),
      ).toBe(false);
    if (kind === "agent.turn.waiting")
      expect(
        all.find((atom) => atom.kind === "agent.wait.requested")?.payload,
      ).toMatchObject({ attempt: 1, delayMs: 7000, wakeOnMessage: true });
    if (
      ["extra destination", "invalid JSON", "invalid wait"].includes(
        String(_name),
      )
    )
      expect(
        all.find((atom) => atom.kind === "agent.turn.silent")?.payload
          .reasonCodes,
      ).toEqual(["planner-unavailable"]);
  });
  it.each(["failed", "cancelled"])(
    "closes %s Planner normally",
    async (status) => {
      execute.mockResolvedValue({
        status,
        requestedInformationId: "request",
        terminalInformationId: "terminal",
      } as never);
      const { core, database } = await fixture();
      await appendCandidate(core, {
        requestId: status,
        text: "hello",
        occurredAt: "2026-09-08T00:00:01.000Z",
      });
      await waitForKind(database, turnContextCompletedInformationKind.kind);
      await submitDecision(core, database, "attend");
      expect(
        (await waitForKind(database, "agent.turn.silent")).payload.reasonCodes,
      ).toEqual(["planner-unavailable"]);
      expect(
        (await atoms(database)).some((atom) =>
          ["agent.turn.failed", "agent.message.intent.requested"].includes(
            atom.kind,
          ),
        ),
      ).toBe(false);
    },
  );
  it("discards a late Planner completion after supersession", async () => {
    let release!: (value: any) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { core, database } = await fixture();
    await appendCandidate(core, {
      requestId: "old-plan",
      text: "first",
      occurredAt: "2026-09-08T00:00:01.000Z",
    });
    await waitForKind(database, turnContextCompletedInformationKind.kind);
    await submitDecision(core, database, "attend");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await appendCandidate(core, {
      requestId: "new-plan",
      text: "second",
      occurredAt: "2026-09-08T00:00:02.000Z",
    });
    await waitForKind(database, turnSupersededInformationKind.kind);
    release({
      status: "completed",
      output: { action: "message", reason: "respond" },
      requestedInformationId: "request",
      terminalInformationId: "terminal",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await atoms(database)).some(
        (atom) => atom.kind === messageIntentRequestedInformationKind.kind,
      ),
    ).toBe(false);
  });
});
