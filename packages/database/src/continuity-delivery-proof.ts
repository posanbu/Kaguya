/** 自主投递只能使用真实工具决策、已接受约定及原范围，不由持久文本单独授予发送权。 */
import { createHash } from "node:crypto";
import { memoryScope } from "@kaguya/memory";
import type { ActionDependencies } from "@kaguya/sdk";
import type { SqlTransaction } from "./driver.js";

export const continuityTextHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export interface ContinuityDeliveryInput {
  originIntentId: string;
  completedInformationId: string;
  contextInformationId: string;
  activityId: string;
  scope: string;
  decisionInformationId: string;
  dependencies: ActionDependencies;
  textHash: string;
  address: { platform: string; adapterId: string; destination: any };
}
export async function continuityDeliveryProof(
  tx: SqlTransaction,
  requestId: string,
): Promise<{ input: ContinuityDeliveryInput; valid: boolean } | null> {
  const row = (
    await tx.query<{
      input: ContinuityDeliveryInput;
      value: any;
      policy: any;
      main_activity_id: string | null;
      state: string;
      stopped_id: string | null;
      deadline: string;
      payload: any;
    }>(
      `WITH RECURSIVE chain(id,depth) AS (
    SELECT $1::text,0 UNION ALL SELECT r.target_information_id,c.depth+1 FROM chain c JOIN information_references r ON r.information_id=c.id WHERE r.relation='core:caused-by' AND c.depth<16)
    SELECT p.input,ca.value,ag.policy,ag.main_activity_id,h.state,r.stopped_id,r.spec->>'deadline' deadline,a.payload
    FROM chain c JOIN information_continuity_delivery_plans p ON p.completed_id=c.id
    JOIN information_continuity_activities ca ON ca.id=p.activity_id JOIN information_continuity_agents ag ON ag.agent_id=p.agent_id
    JOIN information_action_heads h ON h.intent_id=p.origin_intent_id
    JOIN information_native_tool_calls nc ON nc.intent_id=h.intent_id JOIN information_native_tool_runs r ON r.run_id=nc.run_id
    JOIN information_atoms a ON a.information_id=$1 AND a.kind='core.delivery.requested' AND a.source='runtime:continuity'
    WHERE p.input IS NOT NULL AND EXISTS(SELECT 1 FROM chain ac JOIN information_atoms assistant ON assistant.information_id=ac.id
      WHERE assistant.kind='core.message.assistant.text' AND assistant.source='runtime:continuity'
      AND assistant.payload->>'originatingModuleInstanceId'='continuity.runtime:'||p.origin_intent_id
      AND assistant.payload->>'text'=a.payload->'message'->>'text') LIMIT 2`,
      [requestId],
    )
  ).rows;
  if (!row.length) return null;
  if (row.length !== 1) throw new Error("ambiguous-continuity-delivery");
  const p = row[0]!,
    a = p.value,
    request = p.payload;
  const target = {
    platform: request.platform,
    adapterId: request.adapterId,
    destination: request.destination,
  };
  return {
    input: p.input,
    valid:
      p.policy.enabled &&
      p.main_activity_id === a.id &&
      a.state === "active" &&
      !a.requestedState &&
      !a.reevaluationRequired &&
      a.kind === "commitment" &&
      a.fulfillment !== "declined" &&
      !p.stopped_id &&
      Date.parse(p.deadline) > Date.now() &&
      p.state === "started" &&
      memoryScope(target) === p.input.scope &&
      memoryScope(p.input.address) === p.input.scope &&
      request.message?.kind === "text" &&
      typeof request.message.text === "string" &&
      continuityTextHash(request.message.text) === p.input.textHash,
  };
}
