/** Validate the evidence and scope of interpretations separately from recorded activity facts. */
import type { NativeMemoryNode } from "@kaguya/memory";
import type { FormationInput } from "./formation.js";

export function validActivityReview(
  node: NativeMemoryNode,
  existing: ReadonlyMap<string, NativeMemoryNode>,
  p: FormationInput,
  occurredAt: string,
  experienceOperation?: { inputIds: string[]; kind: string },
): boolean {
  if (p.activityReviewIntervalMs === undefined) return true;
  const old = existing.get(node.id);
  const review = node.metadata.activityReview;
  const activities = [...existing.values()].filter(
    (n) => n.metadata.activityReflection,
  );
  const usesActivity = activities.some((n) =>
    node.metadata.sourceIds.includes(n.metadata.sourceIds[0]!),
  );
  if (!review) return !old?.metadata.activityReflection && !usesActivity;
  const experience = existing.get(review.experienceId);
  if (
    !experience?.metadata.activityReflection ||
    experience.metadata.scope !== p.scope ||
    node.metadata.scope !== p.scope ||
    !node.metadata.sourceIds.includes(experience.metadata.sourceIds[0]!)
  )
    return false;
  const fresh = p.sources.filter(
    (s) =>
      s.scope === p.scope &&
      s.sourceType === "inbound" &&
      node.metadata.sourceIds.includes(s.id) &&
      !old?.metadata.sourceIds.includes(s.id),
  );
  if (
    !fresh.length ||
    !review.counterexampleIds.every(
      (id) =>
        node.metadata.sourceIds.includes(id) &&
        (p.sources.some((s) => s.id === id && s.sourceType === "inbound") ||
          old?.metadata.activityReview?.counterexampleIds.includes(id)),
    )
  )
    return false;
  if (review.perspective === "activity-appraisal")
    return (
      node.id === experience.id &&
      node.metadata.kind === "experience" &&
      node.metadata.ownerId === "self:kaguya" &&
      experienceOperation !== undefined &&
      experienceOperation.inputIds.includes(node.id) &&
      ["correct", "reopen", "seal"].includes(experienceOperation.kind)
    );
  if (old && !old.metadata.activityReview) return false;
  if (node.metadata.level !== 0 && node.metadata.level !== 1) return false;
  const prior = [...existing.values()].filter(
    (n) =>
      n.metadata.activityReview?.perspective === review.perspective &&
      n.metadata.scope === p.scope &&
      n.metadata.ownerId === node.metadata.ownerId,
  );
  const since = Math.max(
    Date.parse(experience.metadata.occurredAt),
    ...prior.map((n) => Date.parse(n.metadata.occurredAt)),
  );
  const latestObservation = Math.max(
    ...fresh.map((s) => Date.parse(s.occurredAt)),
  );
  if (
    !Number.isFinite(latestObservation) ||
    latestObservation > Date.parse(occurredAt) ||
    (latestObservation - since < p.activityReviewIntervalMs &&
      !(
        old?.metadata.activityReview &&
        fresh.some((s) => review.counterexampleIds.includes(s.id))
      ))
  )
    return false;
  // One evaluation plus its summary is still a single observation.
  const independentIds = new Set([
    ...fresh.map((s) => s.id),
    ...(experience.metadata.activityReview?.counterexampleIds ?? []).filter(
      (id) => node.metadata.sourceIds.includes(id),
    ),
  ]);
  if (!old && independentIds.size < 2) return false;
  if (review.perspective === "self-observation")
    return (
      node.metadata.kind === "self" && node.metadata.ownerId === "self:kaguya"
    );
  return (
    node.metadata.kind === "person" &&
    node.metadata.evidence?.basis === "inference" &&
    Array.isArray(experience.metadata.relatedPersonIds) &&
    experience.metadata.relatedPersonIds.includes(node.metadata.ownerId) &&
    fresh.some((s) => s.ownerId === node.metadata.ownerId)
  );
}
