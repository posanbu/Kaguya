/**
 * 功能概述：将 W1 原冻结观察和独立消费者进度投影成只读目录/详情，不调用 discover 或 finish。
 * observations 按不可变 observation ID 分页；observation 保留 manifest 与尝试记录；progress
 * 分开显示发现、分配、连续成功范围及失败缺口。source 引用逐条核对 scope，缺失不会变成成功。
 * 代码库关系：inspection-domain 路由调用；database/inspection-reader 在同一只读快照提供原表。
 */
import {
  inspectionObservationPageSchema,
  inspectionObservationDetailSchema,
  inspectionProgressPageSchema,
} from "@kaguya/schema";
import type { InspectionRow } from "@kaguya/database";
import {
  DomainReader,
  denied,
  reference,
  list,
  serialMap,
} from "./inspection-domain-common.js";

export const observationSummary = (o: InspectionRow) => ({
  observationId: o.observation_id,
  sceneId: o.scene_id,
  consumerId: o.consumer_id,
  policyVersion: o.policy_version,
  recordedAt: o.recorded_at,
  status: o.status,
  complete: o.complete,
  afterPosition: o.after_position,
  throughPosition: o.through_position,
  receivedThroughPosition: o.received_through ?? o.through_position,
  hasMore: o.has_more,
  resultInformationId: o.result_information_id,
  errorCode: o.error_code,
  deferredUntil: o.deferred_until,
  replacementObservationId: o.replacement_observation_id,
});
export function observationInspection(d: DomainReader) {
  return {
    observations: (input: unknown) =>
      d.read(input, "observations", async (r, q, meta, before, cursor) => {
        const rows = await r.observations(
            q.scope,
            q.consumerId ?? null,
            before,
            q.limit + 1,
          ),
          page = rows.slice(0, q.limit);
        return inspectionObservationPageSchema.parse({
          ...meta,
          items: page.map(observationSummary),
          nextCursor:
            rows.length > q.limit ? cursor(page.at(-1)!.observation_id) : null,
          truncated: rows.length > q.limit,
        });
      }),
    observation: (id: string, input: unknown) =>
      d.read(input, `observation:${id}`, async (r, q, meta) => {
        const o = (await r.observations(q.scope, null, null, 1, id))[0];
        if (!o) throw denied();
        const ids = [
          ...new Set<string>([
            ...list(o.source_ids),
            ...list(o.context_ids),
            ...list(o.manifest?.sourceInformationIds),
          ]),
        ];
        const attempts = await r.attempts(id);
        const links = await r.rows(
          `SELECT a.information_id id,
          CASE a.kind WHEN 'agent.heavy.tool.run.v1' THEN 'run' WHEN 'core.action.intent.v1' THEN 'action' ELSE 'gui-task' END domain
          FROM information_atoms a JOIN information_lifecycle l USING(information_id)
          WHERE l.position<=$3::bigint AND (
            (a.kind='agent.heavy.tool.run.v1' AND a.payload->'spec'->>'scope'=$1 AND a.payload->'spec'->>'observationId'=$2) OR
            (a.kind='core.action.intent.v1' AND a.payload->>'scope'=$1 AND a.payload->'dependencies'->>'observationId'=$2) OR
            (a.kind='agent.gui.task.requested.v1' AND a.payload->>'scope'=$1 AND a.payload->>'observationId'=$2))
          ORDER BY l.position LIMIT 101`,
          [q.scope, id, r.boundary.position],
        );
        const refs = [
          ...ids.map((id) => ({
            id,
            domain: "atom" as const,
            relation: "frozen-source",
          })),
          ...links.map((link) => ({
            id: link.id,
            domain: link.domain,
            relation: "observed-by",
          })),
        ];
        return inspectionObservationDetailSchema.parse({
          ...meta,
          observation: observationSummary(o),
          manifest: o.manifest ? d.safe(o.manifest) : null,
          references: await serialMap(refs.slice(0, 100), (ref) =>
            reference(r, q.scope, ref.id, ref.relation, ref.domain),
          ),
          referencesTruncated: refs.length > 100,
          attempts: attempts.slice(0, 100).map((a) => ({
            ordinal: a.ordinal,
            event: a.event,
            detail: d.safe(a.detail),
            recordedAt: a.recorded_at,
          })),
          attemptsTruncated: attempts.length > 100,
        });
      }),
    progress: (input: unknown) =>
      d.read(input, "progress", async (r, q, meta, before, cursor) => {
        const rows = await r.progress(
            q.scope,
            q.consumerId ?? null,
            before,
            q.limit + 1,
          ),
          page = rows.slice(0, q.limit);
        const items = await serialMap(page, async (p) => {
          const holes = await r.holes(p.stream_id);
          return {
            streamId: p.stream_id,
            sceneId: p.scene_id,
            consumerId: p.consumer_id,
            policyVersion: p.policy_version,
            revision: p.revision,
            successfulThrough: p.through_position,
            discoveredThrough: p.discovered_through,
            allocatedThrough: p.allocated_through,
            latestObservationId: p.latest_observation_id,
            openCount: p.open_count,
            backlog: {
              afterPosition: p.allocated_through,
              throughPosition: p.discovered_through,
            },
            holes: holes.slice(0, 100).map((h) => ({
              observationId: h.observation_id,
              afterPosition: h.after_position,
              throughPosition: h.through_position,
              status: h.status,
              errorCode: h.error_code,
              complete: h.complete,
              deferredUntil: h.deferred_until,
            })),
            holesTruncated: holes.length > 100,
          };
        });
        return inspectionProgressPageSchema.parse({
          ...meta,
          items,
          nextCursor:
            rows.length > q.limit ? cursor(page.at(-1)!.stream_id) : null,
          truncated: rows.length > q.limit,
        });
      }),
  };
}
