/** Memory 修订和身份更正使开放计划等待重评，已经发生的行动和投递保留原历史。 */
import { randomUUID } from "node:crypto";
import { activitySchema, type Activity } from "@kaguya/sdk";
import { freezeInformationAtom, informationAtomSchema } from "@kaguya/schema";
import { appendInformationAtom } from "./information-repository.js";
import type { SqlTransaction } from "./driver.js";

export async function invalidateContinuityDependencies(
  tx: SqlTransaction,
  input: {
    informationId: string;
    nodeIds: string[];
    sourceIds: string[];
    personIds: string[];
    at: string;
    reportingActivityId?: string;
  },
) {
  if (
    !input.nodeIds.length &&
    !input.sourceIds.length &&
    !input.personIds.length
  )
    return;
  // A plan can depend on an internal summary of a withdrawn receipt or feedback.
  // Expand canonical proof roots before comparing the plan's frozen source IDs.
  const sourceIds = input.sourceIds.length
    ? (
        await tx.query<{ id: string }>(
          `WITH RECURSIVE affected(id) AS (
       SELECT unnest($1::text[]) UNION
       SELECT a.payload->>'originalInformationId' FROM affected d JOIN information_atoms a
       ON a.kind='memory.native.source.v1' AND a.payload->>'sourceProofVersion'='1'
       AND a.payload->'sourceDependencies' ? d.id
       WHERE a.information_id='memory-native-source:'||(a.payload->>'originalInformationId')
     ) SELECT id FROM affected`,
          [input.sourceIds],
        )
      ).rows.map((r) => r.id)
    : input.sourceIds;
  const rows = (
    await tx.query<{ value: Activity }>(
      `SELECT value FROM information_continuity_activities WHERE (state=ANY($1::text[]) OR (state='completed' AND value->>'kind'='commitment' AND value->>'fulfillment'=ANY(ARRAY['pending','unknown']))) AND (
    EXISTS(SELECT 1 FROM jsonb_array_elements(value->'memoryDependencies') d WHERE d->>'id'=ANY($2::text[])) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements_text(value->'sources') s WHERE s=ANY($3::text[])) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements_text(value->'personIds') p WHERE p=ANY($4::text[])) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(value->'memoryDependencies') d JOIN memory_nodes n ON n.id::text=d->>'id'
      WHERE n.metadata->'sourceIds' ?| $3::text[] OR n.metadata->>'ownerId'=ANY($4::text[]) OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(n.metadata->'proofOwners','[]'::jsonb)) p WHERE p->>'ownerId'=ANY($4::text[]))))`,
      [
        ["candidate", "active", "waiting", "paused"],
        input.nodeIds,
        sourceIds,
        input.personIds,
      ],
    )
  ).rows;
  for (const { value: old } of rows) {
    // A new checkpoint may update its own experience. Its existing timer handles
    // the next choice. External corrections still invalidate this activity.
    if (old.id === input.reportingActivityId) continue;
    const a = activitySchema.parse({
      ...old,
      informationId: randomUUID(),
      revision: old.revision + 1,
      updatedAt: input.at,
      reevaluationRequired: true,
      state:
        old.inFlight || old.state === "completed"
          ? old.state
          : old.state === "paused"
            ? "paused"
            : "waiting",
      requestedState: old.inFlight ? "waiting" : old.requestedState,
      reason: "依据发生修订，需要重新评价未执行计划",
    });
    await tx.query(
      "INSERT INTO information_kinds(kind) VALUES('agent.continuity.activity.v1') ON CONFLICT DO NOTHING",
    );
    await appendInformationAtom(
      tx,
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: a.informationId,
          kind: "agent.continuity.activity.v1",
          occurredAt: input.at,
          source: "runtime:continuity",
          payload: {
            agentId: a.agentId,
            activity: a,
            dependencyChange: input.informationId,
          },
          references: [old.informationId, input.informationId].map(
            (informationId) => ({
              relation: "core:uses-context",
              informationId,
            }),
          ),
        }),
      ),
      [{ relation: "core:uses-context", required: false, multiple: true }],
    );
    await tx.query(
      "UPDATE information_continuity_activities SET value=$2::jsonb,state=$3 WHERE id=$1",
      [a.id, JSON.stringify(a), a.state],
    );
    await tx.query(
      "UPDATE information_continuity_agents SET revision=revision+1,main_activity_id=CASE WHEN main_activity_id=$2 AND $3<>'active' THEN NULL ELSE main_activity_id END WHERE agent_id=$1",
      [a.agentId, a.id, a.state],
    );
  }
}
