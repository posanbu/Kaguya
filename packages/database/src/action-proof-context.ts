/**
 * 功能概述：从持久输出的因果链重建实际送入模型的补充 Memory 证据。
 * 主要职责：沿 caused-by/status-of 找到模型请求，核对 memory_recall 变量与原召回事实；
 * 返回固定快照及登记上界，供宿主签发授权和 admission 同锁复验共用。
 * 代码库关系：不重新检索 Memory，不调用模型；W4 工具决策和消息桥接复用同一入口。
 */
import { nativeMemorySnapshotSchema, z } from "@kaguya/schema";
type NativeMemorySnapshot = z.infer<typeof nativeMemorySnapshotSchema>;
import { memoryScope } from "@kaguya/memory";
import { nativeToolStepSchema, type ObservationManifest } from "@kaguya/sdk";
import { actionDigest } from "./action-store.js";
import type { SqlTransaction } from "./driver.js";

type ProofSnapshot = {
  snapshot: NativeMemorySnapshot;
  boundary: string;
  step?: string;
};
type NativeProof = {
  snapshots: ProofSnapshot[];
  receipts: Map<string, string>;
};
/** 工具快照只接受持久 step、原请求、调用配对与保留原文的可信 Memory provider 回执。 */
async function nativeStepProof(
  tx: SqlTransaction,
  requestId: string,
  request: any,
  manifest: ObservationManifest,
): Promise<NativeProof> {
  const variable = request.prompt?.variables?.find(
    (v: any) => v.name === "native_tool_step",
  );
  if (!variable || variable.informationIds?.length !== 1)
    throw new Error("action-native-step-unproved");
  let id: string | null = variable.informationIds[0];
  const entries: ProofSnapshot[] = [];
  const receipts = new Map<string, string>();
  let expected = request.nativeStep.stepIndex;
  while (id) {
    if (expected < 0 || expected > 31)
      throw new Error("action-native-step-chain");
    const row = (
      await tx.query<{
        payload: any;
        spec: any;
        position: string;
        request_id: string;
      }>(
        `SELECT a.payload,r.spec,l.position::text,s.request_id FROM information_native_tool_steps s
      JOIN information_native_tool_runs r USING(run_id) JOIN information_atoms a ON a.information_id=s.frozen_id JOIN information_lifecycle l ON l.information_id=a.information_id
      WHERE s.frozen_id=$1 AND s.run_id=$2 AND s.step_index=$3 AND l.position<(SELECT position FROM information_lifecycle WHERE information_id=$4)`,
        [id, request.nativeStep.runInformationId, expected, requestId],
      )
    ).rows[0];
    if (!row) throw new Error("action-native-step-unproved");
    const step = nativeToolStepSchema.parse(row.payload);
    const observation = (
      await tx.query<{ manifest: any; contract: any }>(
        "SELECT o.manifest,p.contract FROM information_observations o JOIN information_observation_progress p USING(stream_id) WHERE o.observation_id=$1 AND o.complete AND o.replacement_observation_id IS NULL",
        [row.spec.observationId],
      )
    ).rows[0];
    const base = nativeMemorySnapshotSchema.safeParse(manifest.content.memory);
    if (
      !observation ||
      step.observationId !== row.spec.observationId ||
      row.spec.actionRunInformationId !== manifest.runInformationId ||
      actionDigest(observation.manifest) !== actionDigest(manifest) ||
      row.spec.scope !== memoryScope(observation.contract.address) ||
      actionDigest(row.spec.memory) !==
        actionDigest(base.success ? base.data : null)
    )
      throw new Error("action-native-observation-mismatch");
    if (
      expected === request.nativeStep.stepIndex &&
      (row.request_id !== requestId ||
        actionDigest(JSON.parse(variable.content)) !== actionDigest(step))
    )
      throw new Error("action-native-step-request-mismatch");
    const calls = (
      await tx.query<{
        call: any;
        call_id: string;
        completed_id: string;
        intent_id: string;
        payload: any;
        receipt: any;
        intent: any;
      }>(
        `SELECT c.call,c.call_id,c.completed_id,c.intent_id,a.payload,receipt.payload receipt,h.input intent FROM information_native_tool_calls c
      JOIN information_atoms a ON a.information_id=c.result_id LEFT JOIN information_action_receipts ar ON ar.receipt_id=a.payload->>'receiptId'
      LEFT JOIN information_atoms receipt ON receipt.information_id=ar.receipt_id LEFT JOIN information_action_heads h ON h.intent_id=c.intent_id
      WHERE c.run_id=$1 AND c.step_index=$2 ORDER BY c.call_index`,
        [request.nativeStep.runInformationId, expected - 1],
      )
    ).rows;
    const receiptIds = calls.flatMap((c) =>
      c.payload.receiptId ? [c.payload.receiptId] : [],
    );
    if (
      actionDigest(receiptIds) !== actionDigest(step.receiptIds) ||
      (expected === 0 &&
        (step.previousStepInformationId ||
          step.modelCompletedInformationId ||
          step.supplements.length)) ||
      (expected > 0 &&
        (!calls.length ||
          calls.some(
            (c) =>
              c.completed_id !== step.modelCompletedInformationId ||
              c.payload.modelCompletedInformationId !== c.completed_id ||
              c.payload.toolCallId !== c.call_id ||
              c.payload.intentId !== c.intent_id,
          )))
    )
      throw new Error("action-native-step-pair-mismatch");
    for (const c of calls)
      if (
        c.payload.receiptId &&
        (!c.receipt ||
          c.receipt.intentId !== c.intent_id ||
          c.receipt.intent.toolCallId !== c.call_id ||
          actionDigest(c.receipt.intent) !== actionDigest(c.intent) ||
          c.receipt.resultHash !==
            actionDigest({
              result: c.receipt.outcome.result,
              artifacts: c.receipt.outcome.artifacts,
            }) ||
          actionDigest(c.payload.value) !==
            actionDigest({
              ...c.receipt.outcome,
              receiptId: c.payload.receiptId,
              resultHash: c.receipt.resultHash,
            }))
      )
        throw new Error("action-native-receipt-unproved");
    const supplements = calls
      .filter((c) => c.intent?.providerId === "core.native-memory")
      .flatMap((c) => {
        const r = c.receipt?.outcome?.result;
        return [
          ...(r?.memorySnapshot
            ? [nativeMemorySnapshotSchema.parse(r.memorySnapshot)]
            : []),
          ...(r?.memorySnapshots
            ? z.array(nativeMemorySnapshotSchema).parse(r.memorySnapshots)
            : []),
        ];
      });
    if (actionDigest(supplements) !== actionDigest(step.supplements))
      throw new Error("action-native-memory-unproved");
    const previous = step.previousStepInformationId
      ? (
          await tx.query<{ payload: any }>(
            "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='agent.heavy.tool.step.frozen.v1'",
            [step.previousStepInformationId],
          )
        ).rows[0]?.payload
      : null;
    const priorMemory = expected === 0 ? row.spec.memory : previous?.memory;
    const latest = supplements.at(-1);
    const nextMemory =
      latest &&
      (!priorMemory ||
        BigInt(latest.cutoff?.publicationPosition ?? "0") >=
          BigInt(priorMemory.cutoff?.publicationPosition ?? "0"))
        ? latest
        : priorMemory;
    if (actionDigest(step.memory) !== actionDigest(nextMemory))
      throw new Error("action-native-memory-mismatch");
    for (const receiptId of receiptIds) receipts.set(receiptId, id);
    if (step.memory)
      entries.unshift({ snapshot: step.memory, boundary: id, step: id });
    for (const snapshot of supplements)
      entries.unshift({ snapshot, boundary: id, step: id });
    id = step.previousStepInformationId;
    expected--;
  }
  if (expected !== -1) throw new Error("action-native-step-chain");
  return { snapshots: entries, receipts };
}

export async function actionProofSnapshots(
  tx: SqlTransaction,
  manifest: ObservationManifest,
  evidenceId?: string,
): Promise<NativeProof> {
  if (!evidenceId) return { snapshots: [], receipts: new Map() };
  const rows = (
    await tx.query<{
      information_id: string;
      kind: string;
      payload: any;
      depth: number;
    }>(
      `
    WITH RECURSIVE chain(information_id,depth,path) AS (
      SELECT $1::text,0,ARRAY[$1::text]
      UNION ALL
      SELECT r.target_information_id,c.depth+1,c.path||r.target_information_id
      FROM chain c JOIN information_atoms a USING(information_id)
      JOIN information_references r USING(information_id)
      WHERE c.depth<32 AND a.kind<>'core.model.task.requested'
        AND (r.relation IN ('core:caused-by','core:status-of') OR (c.depth=0 AND r.relation='core:uses-context'))
        AND NOT r.target_information_id=ANY(c.path)
    ) SELECT DISTINCT a.information_id,a.kind,a.payload,c.depth FROM chain c JOIN information_atoms a USING(information_id) LIMIT 4097`,
      [evidenceId],
    )
  ).rows;
  if (!rows.length || rows.length > 4096 || rows.some((r) => r.depth === 32))
    throw new Error("action-proof-chain-invalid");
  const snapshots: ProofSnapshot[] = [];
  const receipts = new Map<string, string>();
  for (const row of rows.filter(
    (r) => r.kind === "core.model.task.requested",
  )) {
    if (row.payload.nativeStep) {
      const proof = await nativeStepProof(
        tx,
        row.information_id,
        row.payload,
        manifest,
      );
      snapshots.push(...proof.snapshots);
      for (const [id, boundary] of proof.receipts) receipts.set(id, boundary);
    }
    for (const variable of row.payload.prompt?.variables ?? []) {
      if (variable.name === "native_memory")
        snapshots.push({
          snapshot: nativeMemorySnapshotSchema.parse(
            JSON.parse(variable.content),
          ),
          boundary: row.information_id,
        });
      if (variable.name !== "memory_recall") continue;
      const results = JSON.parse(variable.content).results;
      if (
        !Array.isArray(results) ||
        !Array.isArray(variable.informationIds) ||
        results.length !== variable.informationIds.length
      )
        throw new Error("action-recall-proof-invalid");
      for (let i = 0; i < results.length; i++) {
        const saved = (
          await tx.query<{ payload: any }>(
            `SELECT a.payload FROM information_atoms a JOIN information_lifecycle l USING(information_id)
          WHERE a.information_id=$1 AND a.kind='agent.heavy.recall.completed'
          AND l.position<(SELECT position FROM information_lifecycle WHERE information_id=$2)
          AND a.payload->'snapshot'=$3::jsonb AND a.payload->>'status'=$4`,
            [
              variable.informationIds[i],
              row.information_id,
              JSON.stringify(results[i].snapshot),
              results[i].status,
            ],
          )
        ).rows[0];
        if (!saved) throw new Error("action-recall-proof-invalid");
        if (results[i].snapshot)
          snapshots.push({
            snapshot: nativeMemorySnapshotSchema.parse(results[i].snapshot),
            boundary: row.information_id,
          });
      }
    }
  }
  return { snapshots, receipts };
}

export async function loadActionProofContext(
  tx: SqlTransaction,
  manifest: import("@kaguya/sdk").ObservationManifest,
  evidenceId?: string,
) {
  const base = nativeMemorySnapshotSchema.safeParse(manifest.content.memory);
  const nativeProof = await actionProofSnapshots(tx, manifest, evidenceId);
  const extra = nativeProof.snapshots;
  const snapshots = [
    ...(base.success ? [base.data] : []),
    ...extra.map((e) => e.snapshot),
  ];
  for (const { snapshot } of extra)
    if (
      (!extra.find((e) => e.snapshot === snapshot)?.step &&
        snapshot.cutoff?.publicationPosition !==
          manifest.knowledgeCutoff.memoryPublicationPosition) ||
      (base.success && snapshot.scope !== base.data.scope)
    )
      throw new Error("action-supplement-boundary-mismatch");
  const revisions = new Map(
    manifest.knowledgeCutoff.memoryRevisions.map((r) => [r.id, r.revision]),
  );
  const nodes = snapshots.flatMap((s) => [
    ...s.fixed,
    ...s.recalled.map((r) => r.node),
    ...(s.personCandidates ?? []).map((p) => p.summary),
  ]);
  for (const node of nodes) {
    if (
      revisions.has(node.id) &&
      revisions.get(node.id) !== node.metadata.revision
    )
      if (
        !extra.some(
          (e) =>
            e.step &&
            [
              ...e.snapshot.fixed,
              ...e.snapshot.recalled.map((r) => r.node),
            ].some(
              (n) =>
                n.id === node.id &&
                n.metadata.revision === node.metadata.revision,
            ),
        )
      )
        throw new Error("action-supplement-revision-conflict");
    revisions.set(
      node.id,
      Math.max(revisions.get(node.id) ?? 0, node.metadata.revision),
    );
  }
  const boundaries = new Map(
    manifest.sourceInformationIds.map((id) => [
      id,
      manifest.frozenInformationId,
    ]),
  );
  for (const { snapshot, boundary } of [
    ...(base.success
      ? [{ snapshot: base.data, boundary: manifest.frozenInformationId }]
      : []),
    ...extra,
  ])
    for (const e of snapshot.pendingEvidence ?? [])
      if (!boundaries.has(e.informationId))
        boundaries.set(e.informationId, boundary);
  const receipts = nativeProof.receipts;
  for (const [id, boundary] of receipts) boundaries.set(id, boundary);
  return {
    snapshotEntries: [
      ...(base.success
        ? [{ snapshot: base.data, boundary: manifest.frozenInformationId }]
        : []),
      ...extra,
    ],
    receipts,
    snapshots,
    nodes,
    boundaries,
    memoryRevisions: [...revisions].map(([id, revision]) => ({ id, revision })),
    sourceInformationIds: [...boundaries.keys()],
  };
}
