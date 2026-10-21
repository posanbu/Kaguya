/** Validate model proposals before the transactional publication boundary. */
/** Validate model proposals before the transactional publication boundary. */
import { createHash } from "node:crypto";
import type { NativeMemoryAccess, NativeMemorySnapshot } from "@kaguya/memory";
import { z } from "@kaguya/schema";
import { formationOutputSchema, nativeMemoryRequested } from "./facts.js";
type FormationInput = Omit<
  z.infer<typeof nativeMemoryRequested.payloadSchema>,
  "existing"
> & { existing: NativeMemorySnapshot };
export function stableId(batch: string, key: string) {
  const hash = createHash("sha256").update(`${batch}:${key}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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
    const parsed = formationOutputSchema.safeParse(result.output);
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
            },
          },
        };
      });
      const ids = new Map(
        parsed.data.nodes.map((n, i) => [n.key, nodes[i]!.node.id]),
      );
      const edges = parsed.data.edges.map((e) => ({
        ...e,
        sourceId: ids.get(e.sourceId) ?? e.sourceId,
        targetId: ids.get(e.targetId) ?? e.targetId,
      }));
      const allowedNodes = new Set([
        ...existing.keys(),
        ...nodes.map((n) => n.node.id),
      ]);
      const valid =
        edges.every(
          (e) => allowedNodes.has(e.sourceId) && allowedNodes.has(e.targetId),
        ) &&
        nodes.every(
          ({ node: n }) =>
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
        try {
          const published = await memory.publish({
            operationId: p.batchId,
            actor: "automatic",
            nodes,
            expectedVersions: Object.fromEntries(
              [...existing.values()].map((n) => [n.id, n.metadata.revision]),
            ),
            edges,
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
