/**
 * 功能概述：校验模型提案的归属、证据和经历状态，再调用事务发布。
 * 主要职责：保留稳定节点 ID 和 expectedRevision；将持久策略下的经历操作接到原子发布，派生前驱与归属。
 * 空结果及无变化成功确认来源，冲突保留明确拒绝原因；旧请求仍使用原输出协议。
 * 代码库关系：由 memory-native handler 调用；不直接读取数据库或改写原模型结果。
 */
import { createHash } from "node:crypto";
import type { NativeMemoryAccess, NativeMemorySnapshot } from "@kaguya/memory";
import { z } from "@kaguya/schema";
import {
  experienceFormationOutputSchema,
  formationSchemaFor,
  nativeMemoryRequested,
} from "./facts.js";
export type FormationInput = Omit<
  z.infer<typeof nativeMemoryRequested.payloadSchema>,
  "existing"
> & { existing: NativeMemorySnapshot };
export function stableId(batch: string, key: string) {
  const hash = createHash("sha256").update(`${batch}:${key}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
  return JSON.stringify(normalize(value));
}
export async function publishFormation(
  p: FormationInput,
  result: { status: string; output?: unknown },
  occurredAt: string,
  memory: NativeMemoryAccess,
) {
  let status: "completed" | "rejected" | "failed" = "failed",
    reason = "model-unavailable";
  let nodeIds: string[] = [];
  if (result.status === "completed") {
    const parsed = formationSchemaFor(p.existing, p.formationPolicy).safeParse(
      result.output,
    );
    if (parsed.success) {
      const existing = new Map(
        [...p.existing.fixed, ...p.existing.recalled.map((r) => r.node)].map(
          (n) => [n.id, n],
        ),
      );
      const allowedSources = new Set([
        ...p.sources.map((s) => s.id),
        ...[...existing.values()].flatMap((n) => n.metadata.sourceIds),
      ]);
      const allowedOwners = new Set(p.existing.owners);
      const nodes = parsed.data.nodes.map((n) => {
        const previous = existing.get(n.key);
        const revision = (previous?.metadata.revision ?? 0) + 1;
        const { key: _key, content, ...metadata } = n;
        return {
          expectedRevision: revision - 1,
          node: {
            id: previous?.id ?? stableId(p.batchId, n.key),
            content,
            metadata: {
              ...previous?.metadata,
              ...metadata,
              system: "native-v1" as const,
              occurredAt: occurredAt,
              revision,
              locked: previous?.metadata.locked ?? false,
              ...(p.existing.cutoff && n.kind === "experience"
                ? {
                    experience: {
                      state:
                        ("experience" in n
                          ? (
                              n.experience as
                                { state: "open" | "sealed" } | undefined
                            )?.state
                          : undefined) ??
                        previous?.metadata.experience?.state ??
                        ("open" as const),
                      policyVersion: "experience.v1",
                      ...(previous?.metadata.experience?.proofOwners
                        ? {
                            proofOwners:
                              previous.metadata.experience.proofOwners.flatMap(
                                (p) => {
                                  const sourceIds = p.sourceIds.filter((id) =>
                                    n.sourceIds.includes(id),
                                  );
                                  return sourceIds.length
                                    ? [{ ...p, sourceIds }]
                                    : [];
                                },
                              ),
                          }
                        : {}),
                      predecessors:
                        previous?.metadata.experience?.predecessors ?? [],
                    },
                  }
                : {}),
            },
          },
        };
      });
      const ids = new Map(
        parsed.data.nodes.map((n, i) => [n.key, nodes[i]!.node.id]),
      );
      const proposedOperation =
        "experienceOperation" in parsed.data
          ? experienceFormationOutputSchema.shape.experienceOperation.parse(
              parsed.data.experienceOperation,
            )
          : undefined;
      const experienceOperation = proposedOperation
        ? {
            ...proposedOperation,
            inputIds: proposedOperation.inputIds,
            outputIds: proposedOperation.outputIds.map(
              (id) => ids.get(id) ?? id,
            ),
          }
        : undefined;
      if (experienceOperation) {
        if (
          experienceOperation.inputIds.some((id) => !existing.has(id)) ||
          experienceOperation.outputIds.some(
            (id) => !nodes.some((n) => n.node.id === id),
          )
        )
          return {
            status: "rejected" as const,
            reason: "invalid-experience-reference",
            nodeIds: [],
          };
        if (["merge", "split"].includes(experienceOperation.kind))
          for (const { node } of nodes)
            if (
              experienceOperation.outputIds.includes(node.id) &&
              node.metadata.experience
            )
              node.metadata.experience.predecessors = [
                ...experienceOperation.inputIds,
              ];
      }
      const edges = parsed.data.edges.map((e) => ({
        ...e,
        sourceId: ids.get(e.sourceId) ?? e.sourceId,
        targetId: ids.get(e.targetId) ?? e.targetId,
      }));
      const allowedNodes = new Set([
        ...existing.keys(),
        ...nodes.map((n) => n.node.id),
      ]);
      const validEvidence = (n: (typeof nodes)[number]["node"]) => {
        const evidence = n.metadata.evidence;
        const previous = existing.get(n.id);
        if (
          n.metadata.kind === "experience" &&
          n.metadata.ownerId.startsWith("person:") &&
          !n.metadata.sourceIds.some(
            (id) =>
              p.sources.some(
                (s) =>
                  s.id === id &&
                  s.ownerId === n.metadata.ownerId &&
                  s.sourceType === "inbound",
              ) ||
              previous?.metadata.sourceIds.includes(id) ||
              (experienceOperation &&
                ["merge", "split"].includes(experienceOperation.kind) &&
                experienceOperation.outputIds.includes(n.id) &&
                experienceOperation.inputIds.some((inputId) => {
                  const input = existing.get(inputId);
                  return (
                    input?.metadata.ownerId === n.metadata.ownerId &&
                    input.metadata.sourceIds.includes(id)
                  );
                })),
          )
        )
          return false;
        if (n.metadata.kind !== "person") return !evidence;
        if (evidence) {
          if (Date.parse(evidence.observedAt) > Date.parse(occurredAt))
            return false;
          if (
            evidence.sourceScope !== p.scope &&
            evidence.sourceScope !== previous?.metadata.evidence?.sourceScope
          )
            return false;
          if (
            evidence.supersedes.some(
              (id) =>
                existing.get(id)?.metadata.ownerId !== n.metadata.ownerId ||
                !nodes.some(
                  ({ node }) =>
                    node.id === id && node.metadata.status !== "active",
                ),
            )
          )
            return false;
          // A self-report must be grounded in the speaker's own inbound message.
          if (
            evidence.basis === "self-report" &&
            !n.metadata.sourceIds.some(
              (id) =>
                p.sources.some(
                  (s) =>
                    s.id === id &&
                    s.sourceType === "inbound" &&
                    s.ownerId === n.metadata.ownerId,
                ) ||
                (previous?.metadata.evidence?.basis === "self-report" &&
                  previous.metadata.sourceIds.includes(id)),
            )
          )
            return false;
        }
        if (n.metadata.scope !== "shared") return true;
        // Legacy shared summaries can be revised in place, but new shared claims require explicit group self-report.
        if (previous && n.metadata.status !== "active") return true;
        if (!evidence)
          return (
            previous?.metadata.scope === "shared" &&
            previous.content === n.content &&
            n.metadata.sourceIds.every((id) =>
              previous.metadata.sourceIds.includes(id),
            )
          );
        let group = false;
        try {
          group = JSON.parse(evidence.sourceScope)[2] === "group";
        } catch {
          /* invalid scope */
        }
        return (
          group &&
          evidence.basis === "self-report" &&
          evidence.temporality === "stable"
        );
      };
      const valid =
        edges.every(
          (e) => allowedNodes.has(e.sourceId) && allowedNodes.has(e.targetId),
        ) &&
        nodes.every(
          ({ node: n }) =>
            validEvidence(n) &&
            allowedOwners.has(n.metadata.ownerId) &&
            (!existing.has(n.id) ||
              existing.get(n.id)!.metadata.ownerId === n.metadata.ownerId) &&
            (n.metadata.expressionType !== "qq-resource" ||
              Boolean(existing.get(n.id)?.metadata.qqAssetId)) &&
            (n.metadata.scope === p.scope || n.metadata.scope === "shared") &&
            n.metadata.sourceIds.every((id) => allowedSources.has(id)) &&
            (n.metadata.level !== 0 || Array.from(n.content).length <= 1200),
        );
      if (valid) {
        if (nodes.length === 0 && edges.length === 0)
          return { status: "completed" as const, reason: "empty", nodeIds: [] };
        const same =
          nodes.every(({ node: n }) => {
            const old = existing.get(n.id);
            return (
              old &&
              old.content === n.content &&
              canonical({ ...old.metadata, revision: 0, occurredAt: "" }) ===
                canonical({ ...n.metadata, revision: 0, occurredAt: "" })
            );
          }) && edges.length === 0;
        if (same && !experienceOperation)
          return {
            status: "completed" as const,
            reason: "no-change",
            nodeIds: [],
          };
        try {
          const published = await memory.publish({
            operationId: p.batchId,
            actor: "automatic",
            nodes,
            expectedVersions: Object.fromEntries(
              [...existing.values()].map((n) => [n.id, n.metadata.revision]),
            ),
            edges,
            ...(experienceOperation ? { experienceOperation } : {}),
          });
          nodeIds = published.map((n) => n.id);
          status = "completed";
          reason = "published";
        } catch (error) {
          if (!(error instanceof Error) || !("status" in error)) throw error;
          status = "rejected";
          reason = error.message;
        }
      } else {
        status = "rejected";
        reason = "invalid-scope-or-evidence";
      }
    } else {
      status = "rejected";
      reason = "invalid-output";
    }
  }
  return { status, reason, nodeIds };
}
