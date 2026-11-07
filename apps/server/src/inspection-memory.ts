/**
 * 功能概述：按 observation 或其真实 successor 的 publication 边界读取精确 Memory 历史。
 * history 逐条验证 scope、历史来源归属和当前撤回/拆分；缺证明不暴露正文，也不补今天身份。
 * 已发布节点不改写，历史内容与当前不可用原因分列；拒绝项仍推进位置游标，不泄露其他范围版本。
 * 代码库关系：复用数据库 native history/proof，inspection-domain 注册只读入口，不调用 freeze/publish。
 */
import {
  z,
  nativeMemorySnapshotSchema,
  nativeMemoryNodeSchema,
  inspectionMemoryHistorySchema,
} from "@kaguya/schema";
import {
  readMemoryView,
  readMemoryInvalidations,
  persistedSourceProofOwners,
} from "@kaguya/database";
import {
  DomainReader,
  denied,
  parse,
  querySchema,
  identifier,
  list,
  reference,
  InspectionDomainError,
  serialMap,
} from "./inspection-domain-common.js";

const query = querySchema
  .extend({
    observationId: identifier,
    stepInformationId: identifier.optional(),
  })
  .strict();
export function memoryInspection(d: DomainReader) {
  return {
    memoryHistory: (id: string, input: unknown) => {
      const { observationId, stepInformationId, ...base } = parse(query, input);
      return d.read(
        base,
        `memory:${id}:${observationId}:${stepInformationId ?? ""}`,
        async (r, q, meta, before, cursor) => {
          const o = (
            await r.observations(q.scope, null, null, 1, observationId)
          )[0];
          if (!o) throw denied();
          let snapshot = nativeMemorySnapshotSchema.safeParse(
            o.manifest?.content?.memory,
          ).data;
          if (stepInformationId) {
            const step = await r.fact(stepInformationId);
            const run = step
              ? await r.run(step.payload.runInformationId, q.scope)
              : undefined;
            const indexed = run
              ? (await r.steps(run.run_id)).some(
                  (s) => s.frozen_id === stepInformationId,
                )
              : false;
            if (
              step?.kind !== "agent.heavy.tool.step.frozen.v1" ||
              step.payload.observationId !== observationId ||
              !run ||
              run.spec.observationId !== observationId ||
              !indexed
            )
              throw denied();
            snapshot = nativeMemorySnapshotSchema.safeParse(
              step.payload.memory,
            ).data;
          }
          if (!snapshot?.cutoff || snapshot.scope !== q.scope)
            throw new InspectionDomainError(
              409,
              "inspection_knowledge_boundary_unrecorded",
            );
          const upper = snapshot.cutoff.publicationPosition;
          const rows = await r.revisions(id, upper, before, q.limit + 1),
            page = rows.slice(0, q.limit),
            items = [];
          let excludedCount = 0;
          for (const row of page) {
            const parsed = nativeMemoryNodeSchema.safeParse(row.node);
            if (!parsed.success) {
              excludedCount++;
              continue;
            }
            const node = parsed.data,
              m = node.metadata;
            if (
              Date.parse(m.occurredAt) > Date.parse(snapshot.frozenAt) ||
              !(
                m.scope === q.scope ||
                (m.scope === "shared" &&
                  snapshot.owners.includes(m.ownerId) &&
                  ["person", "self", "expression"].includes(m.kind))
              )
            ) {
              excludedCount++;
              continue;
            }
            const view = await readMemoryView(r.tx, row.position, {
              ids: [id],
              maxNodes: 256,
            });
            const nodes = [...view.nodes.values()],
              sources = [
                ...new Set(nodes.flatMap((n) => n.metadata.sourceIds)),
              ];
            const persisted = await persistedSourceProofOwners(
              r.tx,
              sources,
              row.position,
            );
            const owners = new Set(nodes.map((n) => n.metadata.ownerId));
            let unproved = false;
            for (const n of nodes) {
              const proofs = [
                ...list(n.metadata.proofOwners),
                ...list(n.metadata.experience?.proofOwners),
              ];
              for (const p of proofs)
                if (
                  p.sourceIds.some((s: string) =>
                    n.metadata.sourceIds.includes(s),
                  )
                )
                  owners.add(p.ownerId);
              for (const [owner, ids] of persisted)
                if (n.metadata.sourceIds.some((s) => ids.has(s)))
                  owners.add(owner);
              if (
                n.metadata.sourceIds.some(
                  (s) =>
                    !list(n.metadata.proofOwners).some((p) =>
                      p.sourceIds.includes(s),
                    ) && ![...persisted.values()].some((ids) => ids.has(s)),
                )
              )
                unproved = true;
            }
            const effects = await readMemoryInvalidations(
              r.tx,
              undefined,
              [...owners],
              sources,
            );
            const reasons: string[] = [];
            if (unproved) reasons.push("source-proof-missing");
            if (effects.withdrawn.size) reasons.push("source-withdrawal");
            if (effects.identities.size) reasons.push("identity-split");
            if (m.status !== "active") reasons.push("inactive");
            if (view.invalid.has(id) && !reasons.length)
              reasons.push("dependency-invalid");
            items.push({
              nodeId: id,
              revision: m.revision,
              publicationInformationId: row.information_id,
              publicationPosition: row.position,
              status: m.status,
              availability: reasons.length ? "unavailable" : "available",
              reasons,
              historical: reasons.length ? null : d.safeProvedMemory(node),
              references: reasons.length
                ? []
                : await serialMap(m.sourceIds.slice(0, 100), (source) =>
                    reference(
                      r,
                      q.scope,
                      `memory-native-source:${source}`,
                      "canonical-source",
                    ),
                  ),
              referencesTruncated: m.sourceIds.length > 100,
            });
          }
          return inspectionMemoryHistorySchema.parse({
            ...meta,
            observationId,
            stepInformationId: stepInformationId ?? null,
            knowledgeCutoff: upper,
            items,
            nextCursor:
              rows.length > q.limit ? cursor(page.at(-1)!.position) : null,
            truncated: rows.length > q.limit,
            excludedCount,
            exclusionReason: excludedCount ? "missing-or-denied" : null,
          });
        },
      );
    },
  };
}
