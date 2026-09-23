/** 为正式注意力观察 Surface 提供不含正文的隔离预览账本。 */
import {
  attentionArousalCompletedInformationKind,
  attentionArousalModule,
  attentionArousalStateRecordedInformationKind,
  turnCandidateInformationKind,
} from "@kaguya/modules";
import {
  freezeInformationAtom,
  inspectionModuleSchema,
  type InformationAtom,
  type JsonObject,
} from "@kaguya/schema";
import type { KaguyaDatabase } from "@kaguya/database";

export const arousalPreviewModule = inspectionModuleSchema.parse({
  ...attentionArousalModule.manifest,
  settingsSchemaFingerprint: "preview",
  selectors: [],
  promptRenderers: [],
  diagnostics: [],
  requires: [],
  provides: [],
  bindings: [],
});

const scenarios = [
  {
    id: "direct-notification",
    outcome: "observe",
    signals: ["mention-self"],
    reasonCodes: ["mention-self"],
    unreadCount: 4,
    focusState: "inactive",
    wakeSignal: true,
  },
  {
    id: "focus-active",
    outcome: "observe",
    signals: ["passive"],
    reasonCodes: ["focus-active"],
    unreadCount: 7,
    focusState: "active",
    wakeSignal: true,
  },
  {
    id: "passive-awake",
    outcome: "observe",
    signals: ["passive"],
    reasonCodes: ["arousal-awake"],
    unreadCount: 2,
    focusState: "inactive",
    wakeSignal: false,
  },
  {
    id: "ordinary-defer",
    outcome: "defer",
    signals: ["passive"],
    reasonCodes: ["arousal-asleep"],
    unreadCount: 5,
    focusState: "inactive",
    wakeSignal: false,
  },
  {
    id: "periodic-recheck",
    outcome: "observe",
    signals: ["passive", "recheck"],
    reasonCodes: ["periodic-recheck"],
    unreadCount: 11,
    focusState: "inactive",
    wakeSignal: true,
  },
  {
    id: "web-conversation",
    outcome: "observe",
    signals: ["web"],
    reasonCodes: ["web"],
    unreadCount: 1,
    focusState: "inactive",
    wakeSignal: true,
  },
  {
    id: "focus-state-missing",
    outcome: "observe",
    signals: ["passive"],
    reasonCodes: ["arousal-awake"],
    unreadCount: 3,
    focusState: "unavailable",
    wakeSignal: false,
  },
  {
    id: "secret-redaction",
    outcome: "observe",
    signals: ["passive"],
    reasonCodes: ["arousal-known-secret"],
    unreadCount: 1,
    focusState: "inactive",
    wakeSignal: false,
  },
] as const;

export async function seedArousalPreview(database: KaguyaDatabase) {
  await database.information.synchronizeKinds([
    turnCandidateInformationKind.kind,
    attentionArousalStateRecordedInformationKind.kind,
    attentionArousalCompletedInformationKind.kind,
    "agent.attention.focus.opened",
  ]);
  const append = async (
    informationId: string,
    kind: string,
    payload: JsonObject,
    occurredAt: string,
    references: InformationAtom["references"] = [],
  ) =>
    database.information.append(
      freezeInformationAtom({
        informationId,
        kind,
        occurredAt,
        source: "preview:arousal",
        payload,
        references,
      }),
      [...new Set(references.map((reference) => reference.relation))].map(
        (relation) => ({ relation, required: false, multiple: true }),
      ),
    );

  for (const [index, scenario] of scenarios.entries()) {
    const id = `demo-arousal-${scenario.id}`;
    const occurredAt = new Date(
      Date.parse("2026-09-22T08:42:00.000Z") - index * 120_000,
    ).toISOString();
    const candidateId = `${id}-candidate`;
    const lowerId = `${id}-lower`;
    const upperId = `${id}-upper`;
    const scopeKey =
      scenario.id === "web-conversation"
        ? "web:demo:web:00000000-0000-4000-8000-000000000217"
        : "qq:demo:group:demo-research";
    const destination =
      scenario.id === "web-conversation"
        ? {
            kind: "web" as const,
            conversationId: "00000000-0000-4000-8000-000000000217",
          }
        : { kind: "group" as const, groupId: "demo-research" };
    const candidate = turnCandidateInformationKind.payloadSchema.parse({
      triggerInformationId: `${id}-notification`,
      reason: (scenario.signals as readonly string[]).includes("recheck")
        ? "recheck"
        : "message",
      dueAt: occurredAt,
      firedAt: occurredAt,
      platform: scenario.id === "web-conversation" ? "web" : "qq",
      adapterId: "demo",
      destination,
      unreadAfterInformationId: lowerId,
      unreadThroughInformationId: upperId,
      unreadCount: scenario.unreadCount,
      signals: [...scenario.signals],
      scopeKey,
      asOf: occurredAt,
      policyVersion: "attention-opportunity.v1",
      rebuildAttempt: 0,
      attempt: 0,
      totalWaitBudget: 3,
    });
    await append(
      candidateId,
      turnCandidateInformationKind.kind,
      candidate,
      occurredAt,
    );

    const stateInformationId = `${id}-state`;
    const arousalState = scenario.outcome === "defer" ? "asleep" : "awake";
    const state =
      attentionArousalStateRecordedInformationKind.payloadSchema.parse({
        state: arousalState,
        cause:
          arousalState === "asleep"
            ? "external"
            : scenario.wakeSignal
              ? "signal"
              : "default",
        scopeKey,
        candidateInformationId: candidateId,
        lastEvaluatedAt: occurredAt,
        lastInboundInformationId: upperId,
        lastActivityAt: occurredAt,
        sleepStartedAt: arousalState === "asleep" ? occurredAt : null,
        lastPeriodicWakeAt: null,
        reasonCodes: scenario.wakeSignal
          ? [...scenario.reasonCodes]
          : ["default-awake"],
        policyVersion: "attention-observation.v1",
      });
    await append(
      stateInformationId,
      attentionArousalStateRecordedInformationKind.kind,
      state,
      occurredAt,
      [{ relation: "core:caused-by", informationId: candidateId }],
    );

    let focusInformationId: string | undefined;
    let focusExpiresAt: string | undefined;
    if (scenario.focusState === "active") {
      focusInformationId = `${id}-focus`;
      focusExpiresAt = new Date(Date.parse(occurredAt) + 90_000).toISOString();
      await append(
        focusInformationId,
        "agent.attention.focus.opened",
        {
          scopeKey,
          generation: id,
          startedAt: occurredAt,
          expiresAt: focusExpiresAt,
          reason: "delivered",
          sourceInformationId: `${id}-turn`,
        },
        occurredAt,
      );
    }

    const result = attentionArousalCompletedInformationKind.payloadSchema.parse(
      {
        outcome: scenario.outcome,
        arousalState,
        arousalStateInformationId: stateInformationId,
        wakeSignal: scenario.wakeSignal,
        candidateInformationId: candidateId,
        scopeKey,
        unreadAfterInformationId: lowerId,
        unreadThroughInformationId: upperId,
        unreadCount: scenario.unreadCount,
        signals: [...scenario.signals],
        focusState: scenario.focusState,
        ...(focusInformationId ? { focusInformationId, focusExpiresAt } : {}),
        reasonCodes: [...scenario.reasonCodes],
        policyVersion: "attention-observation.v1",
      },
    );
    await append(
      id,
      attentionArousalCompletedInformationKind.kind,
      result,
      occurredAt,
      [
        { relation: "core:caused-by", informationId: candidateId },
        { relation: "core:status-of", informationId: candidateId },
        {
          relation: "core:uses-context",
          informationId: stateInformationId,
        },
        ...(focusInformationId
          ? [
              {
                relation: "core:uses-context" as const,
                informationId: focusInformationId,
              },
            ]
          : []),
      ],
    );
  }
}
