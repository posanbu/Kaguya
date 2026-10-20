import { z } from "zod";
import { situationFrameSchema } from "./situation-contract.js";

export const situationStepViewSchema = z.object({
  id: z.string(),
  frameId: z.string().nullable(),
  sceneId: z.string(),
  at: z.string(),
  tier: z.enum(["light", "heavy"]),
  phase: z.enum(["requested", "completed", "failed", "cancelled", "blocked"]),
  action: z.string().nullable(),
  text: z.string(),
  status: z.string(),
  reasoning: z.string().nullable(),
  nativeAvailable: z.boolean(),
  receipt: z.string().nullable(),
});
export const situationViewSchema = z.object({
  version: z.literal(1),
  frames: z.array(situationFrameSchema),
  steps: z.array(situationStepViewSchema),
  truncated: z.boolean(),
});
export type SituationView = z.infer<typeof situationViewSchema>;
export type SituationStepView = z.infer<typeof situationStepViewSchema>;
