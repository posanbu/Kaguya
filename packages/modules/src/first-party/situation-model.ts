/**
 * 情境模型的 Kaguya 纯装配边界。输入来自已冻结证据，函数不查询账本或执行副作用。
 * 默认 Router 尚未调用本入口，运行链迁移由持续情境实施任务独立验收。
 */
import {
  CONTRACT_VERSION,
  situationFrameSchema,
  situationContextManifestSchema,
  type ActionRecord,
  type ContextManifest,
  type ContinuityCheckpoint,
  type EvidenceRecord,
  type RecallSnapshot,
  type SituationFrame,
} from "@kaguya/schema";

export function buildSituationFrame(input: {
  id: string;
  agentId: string;
  sceneId: string;
  frozenAt: string;
  evidence: readonly EvidenceRecord[];
  through: number;
  previous: { manifestId: string; through: number } | null;
  recalls?: readonly RecallSnapshot[];
  continuation?: boolean;
}): SituationFrame {
  if (input.previous && input.previous.through > input.through) {
    throw new Error("Situation boundary cannot regress");
  }
  const seen = new Set<string>();
  const sequences = new Set<number>();
  const evidence = [...input.evidence].sort((a, b) => a.sequence - b.sequence);
  for (const event of evidence) {
    if (seen.has(event.id) || sequences.has(event.sequence))
      throw new Error("Duplicate situation evidence");
    if (event.sequence > input.through)
      throw new Error("Evidence exceeds frozen boundary");
    seen.add(event.id);
    sequences.add(event.sequence);
  }
  const changes = evidence.filter(
    (event) => event.sequence > (input.previous?.through ?? 0),
  );
  return situationFrameSchema.parse({
    contractVersion: CONTRACT_VERSION,
    id: input.id,
    agentId: input.agentId,
    frozenAt: input.frozenAt,
    background: {
      through: input.through,
      evidence,
      continuation: input.continuation ?? false,
    },
    current: {
      sceneId: input.sceneId,
      evidence: evidence.filter((event) => event.sceneId === input.sceneId),
    },
    recalls: structuredClone(input.recalls ?? []),
    changes: {
      baseManifestId: input.previous?.manifestId ?? null,
      evidenceIds: changes.map((event) => event.id),
      invalidatedEvidenceIds: [
        ...new Set(changes.flatMap((event) => event.replaces)),
      ],
    },
  });
}

/** 模型中只展开一次证据。行动 basis 独立保留历史时点的必要正文。 */
export function assembleSituationContext(input: {
  id: string;
  sessionEpoch: string;
  stepKey: string;
  rules: string;
  frame: SituationFrame;
  checkpoint: ContinuityCheckpoint;
  actions: readonly ActionRecord[];
  maxBytes: number;
}): ContextManifest {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
    throw new Error("Explicit context budget required");
  const frame = situationFrameSchema.parse(input.frame);
  const evidenceIds = new Set(
    frame.background.evidence.map((event) => event.id),
  );
  for (const event of frame.current.evidence) {
    if (!evidenceIds.has(event.id))
      throw new Error("Current evidence missing from background");
  }
  const rendered = JSON.stringify({
    stableRules: input.rules,
    continuity: input.checkpoint,
    situation: {
      ...frame,
      current: {
        sceneId: frame.current.sceneId,
        evidenceIds: frame.current.evidence.map((event) => event.id),
      },
    },
    trajectory: input.actions,
  });
  if (Buffer.byteLength(rendered, "utf8") > input.maxBytes)
    throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
  return situationContextManifestSchema.parse({
    contractVersion: CONTRACT_VERSION,
    id: input.id,
    agentId: frame.agentId,
    sessionEpoch: input.sessionEpoch,
    stepKey: input.stepKey,
    policyVersion: "situation-context/1",
    budget: { maxBytes: input.maxBytes, reservedBytes: 0 },
    frame,
    checkpoint: input.checkpoint,
    actions: [...input.actions],
    rules: input.rules,
    rendered,
  });
}
