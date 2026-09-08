/**
 * 在线 Heartflow 编排器。所有推进都由可重放 Information 事实驱动；模块不保存
 * per-chat 状态，也不依赖订阅安装顺序。
 */
import {
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  type JsonObject,
  z,
} from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationSelector,
  onInformation,
  type InformationKindDefinition,
  type InformationModuleHandlerContext,
  type InformationSelectorLedger,
} from "@kaguya/sdk";
import { MEMORY_RETRIEVAL_STRATEGY_ID } from "@kaguya/memory";

import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
  replyRequestedInformationKind,
  speechDecisionInformationKind,
  turnCandidateInformationKind,
  turnClaimedInformationKind,
  turnCompletedInformationKind,
  turnContextCompletedInformationKind,
  turnDecisionSupersededInformationKind,
  turnFailedInformationKind,
  turnSilentInformationKind,
  turnStartedInformationKind,
  turnSupersededInformationKind,
  turnWaitingInformationKind,
  waitRequestedInformationKind,
  type SpeechDecisionPayload,
} from "./information-kinds.js";

type AnyKind = InformationKindDefinition<string, any>;

export interface CreateHeartflowModuleOptions {
  readonly deliveryDeliveredInformationKind: AnyKind;
  readonly deliveryFailedInformationKind: AnyKind;
  readonly modelTaskFailedInformationKind: AnyKind;
  readonly modelTaskCancelledInformationKind: AnyKind;
  readonly executionExhaustedInformationKind: AnyKind;
}

const TURN_TERMINAL_KINDS = new Set<string>([
  turnCompletedInformationKind.kind,
  turnWaitingInformationKind.kind,
  turnSilentInformationKind.kind,
  turnFailedInformationKind.kind,
  turnSupersededInformationKind.kind,
]);

export const heartflowStateSelector = defineInformationSelector({
  selectorId: "agent.heartflow.state",
  select: async ({ sourceAtom, ledger }) => {
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    const remember = (atoms: readonly DeepReadonly<InformationAtom>[]) => {
      for (const atom of atoms) selected.set(atom.informationId, atom);
      return atoms;
    };
    remember([sourceAtom]);

    let anchors: readonly DeepReadonly<InformationAtom>[] = [];
    if (sourceAtom.kind === turnCandidateInformationKind.kind) {
      anchors = [sourceAtom];
    } else if (sourceAtom.kind === personContextCompletedInformationKind.kind) {
      const inbound = remember(
        await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        }),
      )[0];
      if (inbound !== undefined) {
        anchors = remember(
          await ledger.find({
            kinds: [turnCandidateInformationKind.kind],
            payloadContains: {
              sourceInformationIds: [inbound.informationId],
            },
            order: "asc",
            limit: 1_000,
          }),
        );
      }
    } else if (sourceAtom.kind === turnClaimedInformationKind.kind) {
      anchors = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "agent:turn-candidate",
          "outgoing",
        ),
      );
    } else if (TURN_TERMINAL_KINDS.has(sourceAtom.kind)) {
      anchors = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:status-of",
          "outgoing",
        ),
      ).filter(({ kind }) => kind === turnCandidateInformationKind.kind);
    } else if (sourceAtom.kind === speechDecisionInformationKind.kind) {
      remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:uses-context",
          "outgoing",
        ),
      );
      const claims = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "agent:turn-claim",
          "outgoing",
        ),
      );
      anchors = await candidatesForClaims(ledger, claims, remember);
    } else {
      // Runtime delivery terminals and execution.exhausted are injected kinds.
      const statusTargets = remember(
        await related(
          ledger,
          sourceAtom.informationId,
          "core:status-of",
          "outgoing",
        ),
      );
      const inboundCandidates = (
        await Promise.all(
          statusTargets
            .filter(({ kind }) => kind === inboundTextInformationKind.kind)
            .map((inbound) =>
              ledger.find({
                kinds: [turnCandidateInformationKind.kind],
                payloadContains: {
                  sourceInformationIds: [inbound.informationId],
                },
                order: "asc",
                limit: 1_000,
              }),
            ),
        )
      ).flat();
      remember(inboundCandidates);
      anchors = [
        ...(await traceTurnCandidates(ledger, statusTargets, remember)),
        ...inboundCandidates,
      ];
    }

    const scopes = new Set(
      anchors
        .filter(({ kind }) => kind === turnCandidateInformationKind.kind)
        .map((atom) => (atom.payload as any).scopeKey as string),
    );
    const candidates = [...anchors];
    for (const scopeKey of scopes) {
      candidates.push(
        ...remember(
          await ledger.find({
            kinds: [turnCandidateInformationKind.kind],
            payloadContains: { scopeKey },
            order: "asc",
            limit: 1_000,
          }),
        ),
      );
    }
    for (const candidate of uniqueAtoms(candidates)) {
      if (candidate.kind !== turnCandidateInformationKind.kind) continue;
      await hydrateCandidate(ledger, candidate, remember);
    }
    return [...selected.keys()];
  },
});

export const heartflowMemorySelector = defineInformationSelector({
  selectorId: "agent.heartflow.optional-memory",
  select: async ({ sourceAtom, ledger }) => {
    let candidates: readonly DeepReadonly<InformationAtom>[] = [];
    if (sourceAtom.kind === turnCandidateInformationKind.kind) {
      candidates = [sourceAtom];
    } else if (sourceAtom.kind === personContextCompletedInformationKind.kind) {
      const inbound = (
        await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      if (inbound !== undefined) {
        candidates = await ledger.find({
          kinds: [turnCandidateInformationKind.kind],
          payloadContains: { sourceInformationIds: [inbound.informationId] },
          order: "asc",
          limit: 1_000,
        });
      }
    }
    const memories = new Map<string, DeepReadonly<InformationAtom>>();
    for (const candidate of candidates) {
      const inbounds = (
        await ledger.related({
          from: [candidate.informationId],
          relation: "core:uses-context",
          direction: "outgoing",
          limit: 1_000,
        })
      ).filter(({ kind }) => kind === inboundTextInformationKind.kind);
      const query = inbounds
        .map((atom) => (atom.payload as any).text as string)
        .join("\n")
        .trim();
      if (query.length === 0) continue;
      try {
        const selected = await ledger.retrieve({
          strategyId: MEMORY_RETRIEVAL_STRATEGY_ID,
          input: {
            query,
            occurredBefore: (candidate.payload as any).asOf,
            excludeSourceInformationIds: inbounds.map(
              ({ informationId }) => informationId,
            ),
          },
          limit: 8,
        });
        for (const atom of selected) memories.set(atom.informationId, atom);
      } catch {
        // Optional Memory never blocks the online turn.
      }
    }
    return [...memories.keys()];
  },
});

export function createHeartflowModule(options: CreateHeartflowModuleOptions) {
  const deliveryKinds = [
    options.deliveryDeliveredInformationKind,
    options.deliveryFailedInformationKind,
  ] as const;
  const modelTaskFailureKinds = [
    options.modelTaskFailedInformationKind,
    options.modelTaskCancelledInformationKind,
  ] as const;
  const module = defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "agent.heartflow.online",
      displayName: "Information DAG heartflow",
      settingsSchema: z.object({}).strict(),
      consumes: [
        turnCandidateInformationKind,
        personContextCompletedInformationKind,
        turnClaimedInformationKind,
        speechDecisionInformationKind,
        turnCompletedInformationKind,
        turnWaitingInformationKind,
        turnSilentInformationKind,
        turnFailedInformationKind,
        turnSupersededInformationKind,
        ...deliveryKinds,
        ...modelTaskFailureKinds,
        options.executionExhaustedInformationKind,
      ],
      produces: [
        turnClaimedInformationKind,
        turnStartedInformationKind,
        turnDecisionSupersededInformationKind,
        turnContextCompletedInformationKind,
        replyRequestedInformationKind,
        waitRequestedInformationKind,
        turnCompletedInformationKind,
        turnWaitingInformationKind,
        turnSilentInformationKind,
        turnFailedInformationKind,
        turnSupersededInformationKind,
      ],
      selectors: [heartflowStateSelector, heartflowMemorySelector],
      promptRenderers: [],
      requires: [],
      provides: [],
    },
    create: () => ({
      provisions: [],
      describeStartup: () => ({
        summary: "Information DAG heartflow ready",
        fields: { identityBarrier: "required", plannerRounds: 1 },
      }),
      subscriptions: [
        ...[
          turnCandidateInformationKind,
          personContextCompletedInformationKind,
          turnClaimedInformationKind,
          turnCompletedInformationKind,
          turnWaitingInformationKind,
          turnSilentInformationKind,
          turnFailedInformationKind,
          turnSupersededInformationKind,
        ].map((definition) =>
          onInformation(
            definition as AnyKind,
            {
              subscriptionId: `agent.heartflow.progress.${definition.kind}`,
              delivery: "durable",
            },
            async (_atom, context) => {
              const state = await context.select(heartflowStateSelector);
              const memories = await context.select(heartflowMemorySelector);
              await progressCandidates(state, memories, context);
            },
          ),
        ),
        onInformation(
          speechDecisionInformationKind,
          {
            subscriptionId: "agent.heartflow.dispatch.decision",
            delivery: "durable",
          },
          async (decision, context) => {
            const state = await context.select(heartflowStateSelector);
            await dispatchDecision(decision, state, context);
          },
        ),
        ...deliveryKinds.map((definition) =>
          onInformation(
            definition,
            {
              subscriptionId: `agent.heartflow.delivery.${definition.kind}`,
              delivery: "durable",
            },
            async (terminal, context) => {
              const state = await context.select(heartflowStateSelector);
              await finishDelivery(
                terminal,
                definition === options.deliveryDeliveredInformationKind,
                state,
                context,
              );
              const memories = await context.select(heartflowMemorySelector);
              await progressCandidates(state, memories, context);
            },
          ),
        ),
        ...modelTaskFailureKinds.map((definition) =>
          onInformation(
            definition,
            {
              subscriptionId: `agent.heartflow.model-task.${definition.kind}`,
              delivery: "durable",
            },
            async (terminal, context) => {
              const state = await context.select(heartflowStateSelector);
              await failOpenTurns(
                terminal,
                definition === options.modelTaskFailedInformationKind
                  ? "model-task-failed"
                  : "model-task-cancelled",
                state,
                context,
              );
            },
          ),
        ),
        onInformation(
          options.executionExhaustedInformationKind,
          {
            subscriptionId: "agent.heartflow.execution-exhausted",
            delivery: "durable",
          },
          async (exhausted, context) => {
            const state = await context.select(heartflowStateSelector);
            await failOpenTurns(
              exhausted,
              "execution-exhausted",
              state,
              context,
            );
          },
        ),
      ],
    }),
  });
  return module;
}

async function progressCandidates(
  atoms: readonly DeepReadonly<InformationAtom>[],
  memories: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const candidates = atoms
    .filter(({ kind }) => kind === turnCandidateInformationKind.kind)
    .sort(compareCandidates);
  for (const candidate of uniqueAtoms(candidates)) {
    await progressCandidate(candidate, atoms, memories, context);
  }
}

async function progressCandidate(
  candidate: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  memories: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const map = new Map(atoms.map((atom) => [atom.informationId, atom]));
  if (turnTerminalFor(candidate.informationId, atoms) !== undefined) return;
  const payload = candidate.payload as any;
  const runtimeContext = referenced(candidate, "core:context", map)[0];
  if (runtimeContext === undefined) return;
  let effectiveSourceInformationIds = [
    ...(payload.sourceInformationIds as string[]),
  ];

  const claims = atoms
    .filter(
      (atom) =>
        atom.kind === turnClaimedInformationKind.kind &&
        (atom.payload as any).scopeKey === payload.scopeKey,
    )
    .sort(compareClaims);
  const latestClaim = claims.at(-1);
  const latestCandidate =
    latestClaim === undefined
      ? undefined
      : referenced(latestClaim, "agent:turn-candidate", map)[0];
  let predecessor =
    latestCandidate === undefined
      ? undefined
      : turnTerminalFor(latestCandidate.informationId, atoms);

  if (
    latestClaim !== undefined &&
    latestCandidate !== undefined &&
    latestCandidate.informationId !== candidate.informationId
  ) {
    if (compareCandidates(candidate, latestCandidate) <= 0) {
      await supersedeCandidate(
        candidate,
        latestClaim,
        latestCandidate.informationId,
        runtimeContext.informationId,
        context,
      );
      return;
    }
    if (predecessor === undefined) {
      const decisionGate = await context.commitTerminal(
        "agent.turn.decision",
        latestClaim.informationId,
        turnDecisionSupersededInformationKind,
        {
          payload: {
            candidateInformationId: latestCandidate.informationId,
            claimInformationId: latestClaim.informationId,
            replacementCandidateInformationId: candidate.informationId,
          },
          references: [
            {
              relation: "core:status-of",
              informationId: latestClaim.informationId,
            },
          ],
          contextInformationId: runtimeContext.informationId,
        },
      );
      if (decisionGate.kind !== turnDecisionSupersededInformationKind.kind)
        return;
      const oldContext = referenced(latestCandidate, "core:context", map)[0];
      predecessor = await context.commitTerminal(
        "agent.turn.terminal",
        latestCandidate.informationId,
        turnSupersededInformationKind,
        {
          payload: {
            candidateInformationId: latestCandidate.informationId,
            claimInformationId: latestClaim.informationId,
            scopeKey: payload.scopeKey,
            replacementCandidateInformationId: candidate.informationId,
          },
          references: terminalReferences(
            latestCandidate.informationId,
            latestClaim.informationId,
          ),
          ...(oldContext === undefined
            ? {}
            : { contextInformationId: oldContext.informationId }),
        },
      );
      effectiveSourceInformationIds = [
        ...new Set([
          ...((latestCandidate.payload as any)
            .sourceInformationIds as string[]),
          ...effectiveSourceInformationIds,
        ]),
      ];
    }
  }

  const predecessorId = predecessor?.informationId;
  const generation =
    latestClaim === undefined
      ? 0
      : ((latestClaim.payload as any).generation ?? 0) + 1;
  const claim = await context.registerOnce(
    "agent.turn.claim",
    `${payload.scopeKey}:${predecessorId ?? "root"}`,
    turnClaimedInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        scopeKey: payload.scopeKey,
        generation,
        predecessorTerminalInformationId: predecessorId ?? null,
      },
      references: [
        {
          relation: "agent:turn-candidate",
          informationId: candidate.informationId,
        },
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );
  if ((claim.payload as any).candidateInformationId !== candidate.informationId)
    return;

  await context.registerOnce(
    "agent.turn.started",
    claim.informationId,
    turnStartedInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        claimInformationId: claim.informationId,
        scopeKey: payload.scopeKey,
        generation: (claim.payload as any).generation,
      },
      references: [
        { relation: "agent:turn-claim", informationId: claim.informationId },
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );

  const inputs = effectiveSourceInformationIds.map((id) => {
    const inbound = map.get(id);
    const identity = identityTerminalFor(id, atoms);
    return inbound === undefined || identity === undefined
      ? undefined
      : { inbound, identity };
  });
  if (inputs.some((input) => input === undefined)) {
    if (
      effectiveSourceInformationIds.some((informationId) =>
        hasExhaustedStatus(informationId, atoms),
      )
    )
      await context.commitTerminal(
        "agent.turn.terminal",
        candidate.informationId,
        turnFailedInformationKind,
        {
          payload: {
            candidateInformationId: candidate.informationId,
            claimInformationId: claim.informationId,
            scopeKey: payload.scopeKey,
            reason: "identity-exhausted",
          },
          references: terminalReferences(
            candidate.informationId,
            claim.informationId,
          ),
          contextInformationId: runtimeContext.informationId,
        },
      );
    return;
  }
  const completeInputs = inputs as {
    inbound: DeepReadonly<InformationAtom>;
    identity: DeepReadonly<InformationAtom>;
  }[];
  const last = completeInputs.at(-1)!;
  const source = (last.inbound.payload as any).source;
  const text = completeInputs
    .map(({ inbound }) => (inbound.payload as any).text as string)
    .join("\n");
  const directness =
    (source.mentions?.length ?? 0) > 0 || source.replyTo !== undefined
      ? 1
      : 0.8;
  const safe = completeInputs.every(
    ({ identity }) => (identity.payload as any).status !== "failed",
  );
  await context.registerOnce(
    "agent.turn.context.completed",
    claim.informationId,
    turnContextCompletedInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        claimInformationId: claim.informationId,
        scopeKey: payload.scopeKey,
        asOf: payload.asOf,
        inputs: completeInputs.map(({ inbound, identity }) => ({
          informationId: inbound.informationId,
          occurredAt: inbound.occurredAt,
          text: (inbound.payload as any).text,
          source: (inbound.payload as any).source,
          identity: {
            terminalInformationId: identity.informationId,
            status: (identity.payload as any).status,
            scopeMode: (identity.payload as any).scopeMode,
            ...copyOptionalIdentity(identity.payload as any),
          },
        })),
        text,
        source,
        directness,
        contentNeed: text.trim().length > 0 ? 1 : 0,
        messageCount: completeInputs.length,
        recentPresencePenalty: 0,
        frequencyMultiplier: 1,
        muted: false,
        safe,
        destinationAvailable: source.destination !== undefined,
        stale: false,
        ...(memories.length === 0
          ? {}
          : { memory: memories.map(({ informationId }) => informationId) }),
        attempt: payload.attempt,
        totalWaitBudget: payload.totalWaitBudget,
      },
      references: [
        { relation: "agent:turn-claim", informationId: claim.informationId },
        ...completeInputs.flatMap(({ inbound, identity }) => [
          {
            relation: "core:uses-context",
            informationId: inbound.informationId,
          },
          {
            relation: "core:uses-context",
            informationId: identity.informationId,
          },
        ]),
        ...memories.map(({ informationId }) => ({
          relation: "core:uses-context" as const,
          informationId,
        })),
      ],
      contextInformationId: runtimeContext.informationId,
    },
  );
}

async function dispatchDecision(
  decision: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const payload = decision.payload as SpeechDecisionPayload;
  const candidate = atoms.find(
    (atom) => atom.informationId === payload.candidateInformationId,
  );
  const claim = atoms.find(
    (atom) => atom.informationId === payload.claimInformationId,
  );
  const turnContext = atoms.find(
    (atom) => atom.informationId === payload.turnContextInformationId,
  );
  if (
    candidate === undefined ||
    claim === undefined ||
    turnContext === undefined
  )
    throw new Error("Speech decision references an incomplete turn");
  assertTurnLink(candidate, claim, turnContext);
  if (turnTerminalFor(candidate.informationId, atoms) !== undefined) return;
  const candidatePayload = candidate.payload as any;
  const terminalInput = {
    candidateInformationId: candidate.informationId,
    claimInformationId: claim.informationId,
    scopeKey: candidatePayload.scopeKey,
  };
  if (payload.action === "speak") {
    await context.registerOnce(
      "agent.heartflow.reply",
      claim.informationId,
      replyRequestedInformationKind,
      {
        payload: {
          text: payload.text,
          source: payload.source,
          turn: {
            candidateInformationId: candidate.informationId,
            claimInformationId: claim.informationId,
            contextInformationId: turnContext.informationId,
          },
        },
        references: [
          {
            relation: "core:uses-context",
            informationId: turnContext.informationId,
          },
          { relation: "agent:turn-claim", informationId: claim.informationId },
          {
            relation: "agent:turn-candidate",
            informationId: candidate.informationId,
          },
        ],
      },
    );
    return;
  }
  if (payload.action === "wait") {
    if (payload.dueAt === undefined || payload.delayMs === undefined)
      throw new Error("Wait decision requires dueAt and delayMs");
    const sourceInformationIds = (turnContext.payload as any).inputs.map(
      (input: any) => input.informationId,
    );
    await context.registerOnce(
      "agent.heartflow.wait",
      claim.informationId,
      waitRequestedInformationKind,
      {
        payload: {
          dueAt: payload.dueAt,
          delayMs: payload.delayMs,
          reason: "score-below-speak-threshold",
          attempt: payload.attempt + 1,
          totalWaitBudget: payload.totalWaitBudget,
          wakePolicy: payload.wakePolicy ?? "recheckAt",
          wakeOnMessage: true,
          source: payload.source,
          sourceInformationIds,
        },
        references: sourceInformationIds.map((informationId: string) => ({
          relation: "core:uses-context",
          informationId,
        })),
      },
    );
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnWaitingInformationKind,
      {
        payload: { ...terminalInput, dueAt: payload.dueAt },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
      },
    );
    return;
  }
  await context.commitTerminal(
    "agent.turn.terminal",
    candidate.informationId,
    turnSilentInformationKind,
    {
      payload: { ...terminalInput, reasonCodes: payload.reasonCodes },
      references: terminalReferences(
        candidate.informationId,
        claim.informationId,
      ),
    },
  );
}

async function finishDelivery(
  terminal: DeepReadonly<InformationAtom>,
  delivered: boolean,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const request = outgoingStatusTarget(terminal, atoms);
  const turn = (request?.payload as any)?.turn;
  if (request === undefined || turn === undefined) return;
  const candidate = atoms.find(
    (atom) => atom.informationId === turn.candidateInformationId,
  );
  const claim = atoms.find(
    (atom) => atom.informationId === turn.claimInformationId,
  );
  if (candidate === undefined || claim === undefined) return;
  if ((claim.payload as any).candidateInformationId !== candidate.informationId)
    throw new Error("Delivery terminal references an inconsistent turn");
  const base = {
    candidateInformationId: candidate.informationId,
    claimInformationId: claim.informationId,
    scopeKey: (candidate.payload as any).scopeKey,
  };
  if (delivered) {
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnCompletedInformationKind,
      {
        payload: {
          ...base,
          deliveryTerminalInformationId: terminal.informationId,
        },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
      },
    );
  } else {
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnFailedInformationKind,
      {
        payload: { ...base, reason: "delivery-failed" },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
      },
    );
  }
}

async function failOpenTurns(
  terminal: DeepReadonly<InformationAtom>,
  reason: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const affectedCandidateIds = traceCandidateIds(terminal, atoms);
  const byId = new Map(atoms.map((atom) => [atom.informationId, atom]));
  const statusTarget = terminal.references
    .filter(({ relation }) => relation === "core:status-of")
    .map(({ informationId }) => byId.get(informationId))
    .find((atom) => atom !== undefined);
  const effectiveReason =
    reason === "execution-exhausted" &&
    statusTarget?.kind === inboundTextInformationKind.kind &&
    String((terminal.payload as any).subscriptionId).includes("identity")
      ? "identity-exhausted"
      : reason;
  const candidates = atoms.filter(
    ({ kind, informationId }) =>
      kind === turnCandidateInformationKind.kind &&
      affectedCandidateIds.has(informationId),
  );
  for (const candidate of candidates) {
    const claim = claimForCandidate(candidate.informationId, atoms);
    if (claim === undefined || turnTerminalFor(candidate.informationId, atoms))
      continue;
    const map = new Map(atoms.map((atom) => [atom.informationId, atom]));
    const runtimeContext = referenced(candidate, "core:context", map)[0];
    if (runtimeContext === undefined) continue;
    await context.commitTerminal(
      "agent.turn.terminal",
      candidate.informationId,
      turnFailedInformationKind,
      {
        payload: {
          candidateInformationId: candidate.informationId,
          claimInformationId: claim.informationId,
          scopeKey: (candidate.payload as any).scopeKey,
          reason: effectiveReason,
        },
        references: terminalReferences(
          candidate.informationId,
          claim.informationId,
        ),
        contextInformationId: runtimeContext.informationId,
      },
    );
  }
}

function traceCandidateIds(
  terminal: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  const byId = new Map(atoms.map((atom) => [atom.informationId, atom]));
  const visited = new Set<string>();
  const candidates = new Set<string>();
  const queue = terminal.references
    .filter(({ relation }) => relation === "core:status-of")
    .map(({ informationId }) => informationId);
  while (queue.length > 0) {
    const informationId = queue.shift()!;
    if (visited.has(informationId)) continue;
    visited.add(informationId);
    const atom = byId.get(informationId);
    if (atom === undefined) continue;
    if (atom.kind === turnCandidateInformationKind.kind) {
      candidates.add(atom.informationId);
      continue;
    }
    for (const reference of atom.references) {
      if (
        reference.relation === "core:caused-by" ||
        reference.relation === "core:status-of" ||
        reference.relation === "agent:turn-claim" ||
        reference.relation === "agent:turn-candidate"
      )
        queue.push(reference.informationId);
    }
  }
  for (const atom of atoms) {
    if (
      atom.kind === turnCandidateInformationKind.kind &&
      ((atom.payload as any).sourceInformationIds as string[]).some((id) =>
        visited.has(id),
      )
    )
      candidates.add(atom.informationId);
  }
  return candidates;
}

async function traceTurnCandidates(
  ledger: InformationSelectorLedger,
  starts: readonly DeepReadonly<InformationAtom>[],
  remember: (
    atoms: readonly DeepReadonly<InformationAtom>[],
  ) => readonly DeepReadonly<InformationAtom>[],
) {
  const visited = new Map<string, DeepReadonly<InformationAtom>>();
  let frontier = [...starts];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const current = frontier.filter(
      ({ informationId }) => !visited.has(informationId),
    );
    if (current.length === 0) break;
    for (const atom of current) visited.set(atom.informationId, atom);
    const next = (
      await Promise.all(
        current.flatMap((atom) =>
          [
            "core:caused-by",
            "core:status-of",
            "agent:turn-claim",
            "agent:turn-candidate",
          ].map((relation) =>
            related(ledger, atom.informationId, relation, "outgoing", 10),
          ),
        ),
      )
    ).flat();
    remember(next);
    frontier = next;
  }
  return [...visited.values()].filter(
    ({ kind }) => kind === turnCandidateInformationKind.kind,
  );
}

async function supersedeCandidate(
  candidate: DeepReadonly<InformationAtom>,
  claim: DeepReadonly<InformationAtom>,
  replacementCandidateInformationId: string,
  contextInformationId: string,
  context: InformationModuleHandlerContext,
) {
  await context.commitTerminal(
    "agent.turn.terminal",
    candidate.informationId,
    turnSupersededInformationKind,
    {
      payload: {
        candidateInformationId: candidate.informationId,
        claimInformationId: claim.informationId,
        scopeKey: (candidate.payload as any).scopeKey,
        replacementCandidateInformationId,
      },
      references: terminalReferences(
        candidate.informationId,
        claim.informationId,
      ),
      contextInformationId,
    },
  );
}

async function hydrateCandidate(
  ledger: InformationSelectorLedger,
  candidate: DeepReadonly<InformationAtom>,
  remember: (
    atoms: readonly DeepReadonly<InformationAtom>[],
  ) => readonly DeepReadonly<InformationAtom>[],
) {
  remember(
    await related(ledger, candidate.informationId, "core:context", "outgoing"),
  );
  const inbounds = remember(
    await related(
      ledger,
      candidate.informationId,
      "core:uses-context",
      "outgoing",
      1_000,
    ),
  ).filter(({ kind }) => kind === inboundTextInformationKind.kind);
  for (const inbound of inbounds) {
    remember(
      await related(
        ledger,
        inbound.informationId,
        "core:status-of",
        "incoming",
        100,
      ),
    );
  }
  const scopeKey = (candidate.payload as any).scopeKey;
  const claims = remember(
    await ledger.find({
      kinds: [turnClaimedInformationKind.kind],
      payloadContains: { scopeKey },
      order: "asc",
      limit: 1_000,
    }),
  );
  for (const claim of claims) {
    const claimCandidates = remember(
      await related(
        ledger,
        claim.informationId,
        "agent:turn-candidate",
        "outgoing",
      ),
    );
    remember(
      await related(
        ledger,
        claim.informationId,
        "core:status-of",
        "incoming",
        10,
      ),
    );
    for (const claimedCandidate of claimCandidates) {
      remember(
        await related(
          ledger,
          claimedCandidate.informationId,
          "core:context",
          "outgoing",
        ),
      );
      remember(
        await related(
          ledger,
          claimedCandidate.informationId,
          "core:status-of",
          "incoming",
          10,
        ),
      );
    }
  }
}

async function candidatesForClaims(
  ledger: InformationSelectorLedger,
  claims: readonly DeepReadonly<InformationAtom>[],
  remember: (
    atoms: readonly DeepReadonly<InformationAtom>[],
  ) => readonly DeepReadonly<InformationAtom>[],
) {
  return remember(
    (
      await Promise.all(
        claims.map((claim) =>
          related(
            ledger,
            claim.informationId,
            "agent:turn-candidate",
            "outgoing",
          ),
        ),
      )
    ).flat(),
  );
}

async function related(
  ledger: InformationSelectorLedger,
  from: string,
  relation: string,
  direction: "outgoing" | "incoming",
  limit = 10,
) {
  return ledger.related({
    from: [from as InformationId],
    relation,
    direction,
    limit,
  });
}

function referenced(
  source: DeepReadonly<InformationAtom>,
  relation: string,
  atoms: ReadonlyMap<string, DeepReadonly<InformationAtom>>,
) {
  return source.references.flatMap((reference) => {
    if (reference.relation !== relation) return [];
    const atom = atoms.get(reference.informationId);
    return atom === undefined ? [] : [atom];
  });
}

function identityTerminalFor(
  inboundInformationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.find(
    (atom) =>
      atom.kind === personContextCompletedInformationKind.kind &&
      atom.references.some(
        (reference) =>
          reference.relation === "core:status-of" &&
          reference.informationId === inboundInformationId,
      ),
  );
}

function hasExhaustedStatus(
  informationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.some(
    (atom) =>
      atom.kind === "execution.exhausted" &&
      atom.references.some(
        (reference) =>
          reference.relation === "core:status-of" &&
          reference.informationId === informationId,
      ),
  );
}

function turnTerminalFor(
  candidateInformationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.find(
    (atom) =>
      TURN_TERMINAL_KINDS.has(atom.kind) &&
      atom.references.some(
        (reference) =>
          reference.relation === "core:status-of" &&
          reference.informationId === candidateInformationId,
      ),
  );
}

function claimForCandidate(
  candidateInformationId: string,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.find(
    (atom) =>
      atom.kind === turnClaimedInformationKind.kind &&
      (atom.payload as any).candidateInformationId === candidateInformationId,
  );
}

function outgoingStatusTarget(
  source: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  const targetId = source.references.find(
    ({ relation }) => relation === "core:status-of",
  )?.informationId;
  return atoms.find(({ informationId }) => informationId === targetId);
}

function terminalReferences(
  candidateInformationId: string,
  claimInformationId: string,
) {
  return [
    { relation: "core:status-of", informationId: candidateInformationId },
    { relation: "agent:turn-claim", informationId: claimInformationId },
  ];
}

function assertTurnLink(
  candidate: DeepReadonly<InformationAtom>,
  claim: DeepReadonly<InformationAtom>,
  turnContext: DeepReadonly<InformationAtom>,
) {
  const claimPayload = claim.payload as any;
  const contextPayload = turnContext.payload as any;
  if (
    claimPayload.candidateInformationId !== candidate.informationId ||
    contextPayload.candidateInformationId !== candidate.informationId ||
    contextPayload.claimInformationId !== claim.informationId
  )
    throw new Error("Speech decision references an inconsistent turn");
}

function compareCandidates(
  left: DeepReadonly<InformationAtom>,
  right: DeepReadonly<InformationAtom>,
) {
  const byTime =
    Date.parse((left.payload as any).asOf) -
    Date.parse((right.payload as any).asOf);
  return byTime || left.informationId.localeCompare(right.informationId);
}

function compareClaims(
  left: DeepReadonly<InformationAtom>,
  right: DeepReadonly<InformationAtom>,
) {
  const byGeneration =
    ((left.payload as any).generation ?? 0) -
    ((right.payload as any).generation ?? 0);
  if (byGeneration !== 0) return byGeneration;
  const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  return byTime || left.informationId.localeCompare(right.informationId);
}

function uniqueAtoms<T extends DeepReadonly<InformationAtom>>(
  atoms: readonly T[],
) {
  return [...new Map(atoms.map((atom) => [atom.informationId, atom])).values()];
}

function copyOptionalIdentity(payload: any): JsonObject {
  return {
    ...(payload.scopeInformationId === undefined
      ? {}
      : { scopeInformationId: payload.scopeInformationId }),
    ...(payload.accountInformationId === undefined
      ? {}
      : { accountInformationId: payload.accountInformationId }),
    ...(payload.personInformationId === undefined
      ? {}
      : { personInformationId: payload.personInformationId }),
  };
}
