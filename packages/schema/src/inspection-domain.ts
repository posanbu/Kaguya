/**
 * 功能概述：跨领域只读检视的版本化 wire DTO，保留输入边界、证据强度和独立完成状态。
 * 各 domain schema 分别约束观察、消费进度、原生循环、行动、Memory 历史与 GUI 管理任务；
 * page 标注固定目录上界及当前状态读取时间，safeContent 显式报告内容省略，不冒充完整原始记录。
 * 代码库关系：server/inspection-domain 使用本文件校验响应，W10 可直接消费；无 I/O 或写入能力。
 */
import { z } from "zod";
import { jsonValueSchema } from "./information.js";

const id = z.string();
const position = z.string().regex(/^\d+$/);
export const inspectionSafeContentSchema = z.object({
  value: jsonValueSchema,
  omitted: z.array(z.string()),
  truncated: z.boolean(),
});
export const inspectionDomainReferenceSchema = z.object({
  domain: z.enum([
    "atom",
    "observation",
    "run",
    "action",
    "memory",
    "gui-task",
    "environment",
  ]),
  id,
  relation: id,
  availability: z.enum([
    "available",
    "missing-or-denied",
    "unrecorded",
    "invalid",
  ]),
});
export const inspectionReadBoundarySchema = z.object({
  position,
  recordedAt: id,
});
const metadata = {
  version: z.literal(1),
  scope: id,
  boundary: inspectionReadBoundarySchema,
  stateReadAt: id,
};
const safe = inspectionSafeContentSchema;
const ref = inspectionDomainReferenceSchema;
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    ...metadata,
    directory: z
      .object({ limit: z.number().int(), truncated: z.boolean() })
      .optional(),
    items: z.array(item),
    nextCursor: id.nullable(),
    truncated: z.boolean(),
  });
export const inspectionObservationSummarySchema = z.object({
  observationId: id,
  sceneId: id,
  consumerId: id,
  policyVersion: id,
  recordedAt: id,
  status: z.enum(["frozen", "completed", "failed"]),
  complete: z.boolean(),
  afterPosition: position,
  throughPosition: position,
  receivedThroughPosition: position,
  hasMore: z.boolean(),
  resultInformationId: id.nullable(),
  errorCode: id.nullable(),
  deferredUntil: id.nullable(),
  replacementObservationId: id.nullable(),
});
export const inspectionObservationPageSchema = page(
  inspectionObservationSummarySchema,
);
export const inspectionObservationDetailSchema = z.object({
  ...metadata,
  observation: inspectionObservationSummarySchema,
  manifest: safe.nullable(),
  references: z.array(ref),
  referencesTruncated: z.boolean(),
  attempts: z.array(
    z.object({ ordinal: position, event: id, detail: safe, recordedAt: id }),
  ),
  attemptsTruncated: z.boolean(),
});
export const inspectionProgressPageSchema = page(
  z.object({
    sceneId: id,
    consumerId: id,
    policyVersion: id,
    streamId: id,
    revision: z.number(),
    successfulThrough: position,
    discoveredThrough: position,
    allocatedThrough: position,
    latestObservationId: id.nullable(),
    openCount: position,
    backlog: z.object({ afterPosition: position, throughPosition: position }),
    holes: z.array(
      z.object({
        observationId: id,
        afterPosition: position,
        throughPosition: position,
        status: id,
        errorCode: id.nullable(),
        complete: z.boolean(),
        deferredUntil: id.nullable(),
      }),
    ),
    holesTruncated: z.boolean(),
  }),
);
export const inspectionRunSummarySchema = z.object({
  runInformationId: id,
  actionRunInformationId: id,
  observationId: id,
  sceneId: id,
  at: id,
  deadline: id,
  terminalReason: id.nullable(),
});
export const inspectionRunPageSchema = page(inspectionRunSummarySchema);
export const inspectionModelStepSchema = z.object({
  stepIndex: z.number().int(),
  frozenInformationId: id,
  requestInformationId: id.nullable(),
  dispatchInformationId: id.nullable(),
  terminalInformationId: id.nullable(),
  phase: id,
  reasonCode: id.nullable(),
  generationKind: id.nullable(),
  contextTrimming: z
    .object({
      measurement: id,
      omittedSegments: z.number(),
      truncated: z.boolean(),
      originalBytes: z.number(),
      retainedBytes: z.number(),
      budgetBytes: z.number(),
    })
    .nullable(),
  frozen: safe.nullable(),
});
export const inspectionRunDetailSchema = z.object({
  ...metadata,
  run: inspectionRunSummarySchema,
  budget: safe,
  usage: z.object({
    admittedSteps: z.number(),
    registeredCalls: z.number(),
    projectedOutputBytes: z.number(),
  }),
  cancellation: z
    .object({
      state: z.enum(["pending", "forwarded"]),
      requestedInformationId: id,
      forwardedInformationId: id.nullable(),
    })
    .nullable(),
  steps: z.array(inspectionModelStepSchema),
  stepsTruncated: z.boolean(),
  calls: z.array(
    z.object({
      stepIndex: z.number(),
      callIndex: z.number(),
      toolCallId: id,
      toolId: id.nullable(),
      toolVersion: id.nullable(),
      wireName: id,
      validation: id,
      arguments: safe,
      modelCompletedInformationId: id,
      intent: ref.nullable(),
      resultInformationId: id.nullable(),
      receipt: ref.nullable(),
      result: safe.nullable(),
      outputBytes: z.number().nullable(),
      pairing: z.enum(["verified", "pending", "invalid"]),
    }),
  ),
  callsTruncated: z.boolean(),
  references: z.array(ref),
});
export const inspectionActionSummarySchema = z.object({
  intentId: id,
  at: id,
  state: id,
  runInformationId: id,
  decisionInformationId: id,
  observationId: id,
  toolName: id,
  attemptId: id.nullable(),
  receiptId: id.nullable(),
  cancellationId: id.nullable(),
});
export const inspectionActionPageSchema = page(inspectionActionSummarySchema);
export const inspectionActionDetailSchema = z.object({
  ...metadata,
  action: inspectionActionSummarySchema,
  intent: safe,
  receipts: z.array(
    z.object({
      informationId: id,
      at: id,
      attemptId: id.nullable(),
      reconcilesReceiptId: id.nullable(),
      status: id,
      evidence: id,
      providerReceiptId: id.nullable(),
      environmentValidation: id.nullable(),
      resultHash: id,
      truncated: z.boolean(),
      content: safe,
    }),
  ),
  receiptsTruncated: z.boolean(),
  lateEvidence: z.array(
    z.object({
      informationId: id,
      at: id,
      responseDigest: id,
      source: safe,
      requests: safe,
      value: safe,
    }),
  ),
  lateEvidenceTruncated: z.boolean(),
  rejectedEvidenceCount: z.number(),
  references: z.array(ref),
});
export const inspectionMemoryHistorySchema = page(
  z.object({
    nodeId: id,
    revision: z.number(),
    publicationInformationId: id,
    publicationPosition: position,
    status: id,
    availability: z.enum(["available", "unavailable"]),
    reasons: z.array(
      z.enum([
        "source-proof-missing",
        "source-withdrawal",
        "identity-split",
        "inactive",
        "dependency-invalid",
      ]),
    ),
    historical: safe.nullable(),
    references: z.array(ref),
    referencesTruncated: z.boolean(),
  }),
).extend({
  observationId: id,
  stepInformationId: id.nullable(),
  knowledgeCutoff: position,
  excludedCount: z.number(),
  exclusionReason: z.literal("missing-or-denied").nullable(),
});
export const inspectionGuiTaskPageSchema = page(
  z.object({
    taskRequestId: id,
    environmentId: id,
    requestedInformationId: id,
    observationId: id,
    actionRunInformationId: id,
    generation: z.number(),
    routeId: id,
    at: id,
  }),
);
export const inspectionGuiTaskDetailSchema = z.object({
  ...metadata,
  task: inspectionGuiTaskPageSchema.shape.items.element,
  run: ref.nullable(),
  status: id,
  terminal: safe.nullable(),
  terminalSource: z.enum(["gui-task", "native-run", "execution", "unrecorded"]),
  cancellation: inspectionRunDetailSchema.shape.cancellation,
  references: z.array(ref),
});
export const inspectionEnvironmentSchema = z.object({
  version: z.literal(1),
  scope: id,
  stateReadAt: id,
  control: z.object({
    environmentId: id,
    scope: id,
    generation: z.number(),
    state: z.enum([
      "preparing",
      "ready",
      "human",
      "draining",
      "quarantined",
      "isolation_failed",
    ]),
    human: z.object({ sessionId: id, expiresAt: id }).optional(),
    pendingControl: z
      .object({ mode: z.enum(["human", "automation"]), generation: z.number() })
      .optional(),
  }),
});
export const inspectionHumanOperationSchema = z.object({
  version: z.literal(1),
  scope: id,
  stateReadAt: id,
  environmentId: id,
  operationId: id,
  attemptId: id,
  outcome: safe,
});

export const inspectionSourceSchema = z.object({
  ...metadata,
  informationId: id,
  kind: id,
  occurredAt: id,
  availability: z.enum(["available", "unavailable"]),
  reason: z
    .enum([
      "source-proof-missing",
      "source-withdrawal",
      "identity-split",
      "domain-detail-required",
    ])
    .nullable(),
  content: safe.nullable(),
  references: z.array(ref),
  referencesTruncated: z.boolean(),
});
