/** 情境—行动契约的运行时校验。JSON Schema 由 scripts/export-situation-contract.ts 导出。 */
import { z } from "zod";

const id = z.string().min(1);
const instant = z.iso.datetime();
export const situationEvidenceInputSchema = z.strictObject({
  id,
  sceneId: id,
  source: z.enum([
    "onebot",
    "composer",
    "clock",
    "recall",
    "tool",
    "delivery",
    "system",
  ]),
  actorId: id,
  occurredAt: instant,
  kind: z.enum([
    "message",
    "correction",
    "clock",
    "recall",
    "tool-result",
    "delivery",
  ]),
  text: z.string(),
  replaces: z.array(id),
});
export const situationEvidenceRecordSchema =
  situationEvidenceInputSchema.extend({
    sequence: z.number().int().positive(),
    receivedAt: instant,
  });
export const situationRecallSchema = z.strictObject({
  sceneId: id,
  revision: id,
  items: z.array(
    z.strictObject({ id, text: z.string(), evidenceIds: z.array(id) }),
  ),
});
export const situationFrameSchema = z.strictObject({
  contractVersion: z.literal("1.0.0"),
  id,
  agentId: id,
  frozenAt: instant,
  background: z.strictObject({
    through: z.number().int().nonnegative(),
    evidence: z.array(situationEvidenceRecordSchema),
    continuation: z.boolean(),
  }),
  current: z.strictObject({
    sceneId: id,
    evidence: z.array(situationEvidenceRecordSchema),
  }),
  recalls: z.array(situationRecallSchema),
  selection: z
    .strictObject({
      backgroundHistoryOmitted: z.boolean(),
      omittedRecalls: z.array(z.strictObject({ sceneId: id, revision: id })),
    })
    .optional(),
  changes: z.strictObject({
    baseManifestId: id.nullable(),
    evidenceIds: z.array(id),
    invalidatedEvidenceIds: z.array(id),
  }),
});
export const situationActionStatusSchema = z.enum([
  "planned",
  "queued",
  "running",
  "waiting",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
  "unknown",
  "silent",
]);
export const situationActionRecordSchema = z.strictObject({
  id,
  sequence: z.number().int().positive(),
  revision: z.number().int().positive(),
  manifestId: id,
  frameId: id,
  sceneId: id,
  kind: z.enum(["message", "tool", "wait", "silent"]),
  text: z.string(),
  basis: z.array(
    z.strictObject({ evidenceId: id, sceneId: id, text: z.string() }),
  ),
  dependencies: z.array(id),
  status: situationActionStatusSchema,
  result: z.string().nullable(),
  receiptId: id.nullable(),
  processed: z.boolean(),
  commitment: z.string().nullable(),
  dueAt: instant.nullable(),
  tool: z
    .strictObject({
      callId: id,
      name: id,
      arguments: z.string(),
      result: z.string().nullable(),
    })
    .nullable(),
});
export const situationCheckpointSchema = z.strictObject({
  id,
  revision: z.number().int().nonnegative(),
  previousId: id.nullable(),
  coveredRanges: z.array(
    z.strictObject({
      from: z.number().int().positive(),
      through: z.number().int().positive(),
    }),
  ),
  outcomes: z.array(
    z.strictObject({
      actionId: id,
      status: situationActionStatusSchema,
      result: z.string().nullable(),
      receiptId: id.nullable(),
    }),
  ),
  openActionIds: z.array(id),
  commitments: z.array(z.strictObject({ actionId: id, text: z.string() })),
  waits: z.array(z.strictObject({ actionId: id, dueAt: instant.nullable() })),
});
export const situationContextManifestSchema = z.strictObject({
  contractVersion: z.literal("1.0.0"),
  id,
  agentId: id,
  sessionEpoch: id,
  stepKey: id,
  policyVersion: id,
  budget: z.strictObject({
    maxBytes: z.number().int().positive(),
    reservedBytes: z.number().int().nonnegative(),
  }),
  frame: situationFrameSchema,
  checkpoint: situationCheckpointSchema,
  actions: z.array(situationActionRecordSchema),
  rules: z.string(),
  rendered: z.string(),
});
export const situationContractSchema = z.strictObject({
  evidence: situationEvidenceInputSchema,
  recall: situationRecallSchema,
  frame: situationFrameSchema,
  action: situationActionRecordSchema,
  checkpoint: situationCheckpointSchema,
  manifest: situationContextManifestSchema,
});
