import { createTestingDatabase } from "@kaguya/database/testing";
import {
  executionExhaustedInformationKind,
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import { z } from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHeartflowModule } from "./index.js";
import {
  heartbeatFiredInformationKind,
  heartbeatScheduledInformationKind,
  inboundTextInformationKind,
  personContextCompletedInformationKind,
  attentionArousalCompletedInformationKind,
  replyRequestedInformationKind,
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
  for (const { host, core, database } of resources.splice(0).reverse()) {
    await host.stop();
    await core.close();
    await database.close();
  }
});

async function fixture() {
  const database = await createTestingDatabase();
  await database.migrate();
  const module = createHeartflowModule({
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
  const host = new ModuleHost({ core, catalog });
  await core.start();
  await host.start([
    {
      instanceId: "heartflow.test",
      definitionId: module.manifest.definitionId,
      settings: {},
    },
  ]);
  resources.push({ host, core, database });
  return { core, database };
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
    destination: { kind: "web" as const },
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
      reason: "message",
      dueAt: input.occurredAt,
      policyVersion: "short-heartbeat.v1",
      platform: "web",
      adapterId: "adapter",
      destination: { kind: "web" },
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
      reason: "message",
      dueAt: input.occurredAt,
      firedAt: input.occurredAt,
      platform: "web",
      adapterId: "adapter",
      destination: { kind: "web" },
      sourceInformationIds: [inbound.informationId],
      scopeKey: input.scopeKey ?? "web:adapter:web:",
      asOf: input.occurredAt,
      policyVersion: "short-heartbeat.v1",
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
    "agent.turn.decision",
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

      await waitForKind(database, terminal);
      const all = await atoms(database);
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

  it("dispatches a replayed speak decision to exactly one reply request", async () => {
    const { core, database } = await fixture();
    const { candidate } = await appendCandidate(core, {
      requestId: "attend",
      text: "attend",
      occurredAt: "2026-09-08T00:00:01.000Z",
    });
    await waitForKind(database, turnContextCompletedInformationKind.kind);

    const first = await submitDecision(core, database, "attend");
    const replay = await submitDecision(core, database, "attend");
    expect(replay.informationId).toBe(first.informationId);

    const reply = await waitForKind(
      database,
      replyRequestedInformationKind.kind,
    );
    expect((reply.payload as any).turn).toMatchObject({
      candidateInformationId: candidate.informationId,
    });
    expect(
      (await atoms(database)).filter(
        ({ kind }) => kind === replyRequestedInformationKind.kind,
      ),
    ).toHaveLength(1);
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
    await waitForKind(database, replyRequestedInformationKind.kind);
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
    const reply = await waitForKind(
      database,
      replyRequestedInformationKind.kind,
    );
    expect(reply.payload).toMatchObject({
      text: "second",
      source: { platformMessageId: "second" },
    });
  });
});
