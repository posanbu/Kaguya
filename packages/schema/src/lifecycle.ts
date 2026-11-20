import { z } from "zod";

export const activitySpanSchema = z
  .object({
    activity: z.enum(["idle", "observing", "working", "sleeping"]),
    scopeKey: z.string().nullable(),
    startedAt: z.string(),
    through: z.string(),
    reason: z.string(),
    transition: z.string().nullable(),
  })
  .strict();
export const lifecycleSnapshotSchema = z
  .object({
    state: z.enum(["awake", "asleep"]),
    at: z.string(),
    lastActivityAt: z.string(),
    scopeActivityAt: z.record(z.string(), z.string()),
    timeline: z.array(activitySpanSchema),
  })
  .strict();
export type ActivitySpan = z.infer<typeof activitySpanSchema>;
export type LifecycleSnapshot = z.infer<typeof lifecycleSnapshotSchema>;

export const lifecycleInspectionSchema = z.object({
  version: z.literal(1),
  readAt: z.string(),
  latest: z
    .object({
      informationId: z.string(),
      source: z.string(),
      occurredAt: z.string(),
      snapshot: lifecycleSnapshotSchema.nullable(),
    })
    .nullable(),
});
