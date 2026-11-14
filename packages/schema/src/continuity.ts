/** 跨服务端、模块和管理界面共用持续状态、活动与来源协议。 */
import { z } from "zod";
import { nativeMemoryNodeSchema } from "./memory-graph.js";
const id = z.string().min(1).max(1000);
const instant = z.iso.datetime();
export const continuityPolicySchema = z
  .object({
    version: id,
    enabled: z.boolean(),
    timeZone: id.refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    dailyModelCalls: z.number().int().min(0).max(24).default(24),
    subjectiveTtlMs: z.number().int().min(1000).max(86400000).default(1800000),
  })
  .strict();
export type ContinuityPolicy = z.infer<typeof continuityPolicySchema>;
export const subjectiveStateSchema = z
  .object({
    attention: z.array(id).max(8),
    interests: z.array(z.object({ topic: id, reason: id }).strict()).max(8),
    appraisal: z.string().max(2000),
    social: z.enum(["available", "focused", "solitude", "undetermined"]),
  })
  .strict();
export type SubjectiveState = z.infer<typeof subjectiveStateSchema>;
export const currentStateSchema = z
  .object({
    revision: z.number().int().positive(),
    informationId: id,
    policyVersion: id,
    evaluatedAt: instant,
    expiresAt: instant,
    scope: id,
    subjective: subjectiveStateSchema,
    basis: z.array(id).min(1).max(100),
  })
  .strict();
export type CurrentState = z.infer<typeof currentStateSchema>;
export const activitySchema = z
  .object({
    id,
    agentId: id,
    revision: z.number().int().positive(),
    informationId: id,
    scope: id,
    kind: z.enum(["wish", "request", "commitment", "plan"]),
    title: id,
    goal: z.string().min(1).max(4000),
    state: z.enum([
      "candidate",
      "active",
      "waiting",
      "paused",
      "completed",
      "abandoned",
      "failed",
    ]),
    reason: z.string().max(2000),
    createdAt: instant,
    updatedAt: instant,
    nextCheckAt: instant.nullable(),
    nextStep: z.string().max(4000),
    completedSteps: z.array(z.string().max(2000)).max(100),
    checkpointReceiptIds: z.array(id).max(128),
    artifacts: z.array(id).max(100),
    sources: z.array(id).min(1).max(100),
    memoryDependencies: z
      .array(z.object({ id, revision: z.number().int().positive() }).strict())
      .max(100),
    personIds: z.array(id).max(20),
    acceptedBy: id.nullable(),
    acceptedFrom: id.nullable(),
    externalResult: z.enum(["unknown", "partial", "verified", "failed"]),
    deliveryIds: z.array(id).max(100),
    feedbackIds: z.array(id).max(100),
    fulfillment: z.enum(["unknown", "pending", "fulfilled", "declined"]),
    reevaluationRequired: z.boolean(),
    inFlight: id.nullable(),
    requestedState: z.enum(["paused", "waiting", "abandoned"]).nullable(),
    suspension: z.enum(["disabled", "chat"]).nullable(),
    interruptedBy: id.nullable(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.kind === "commitment" && (!a.acceptedBy || !a.acceptedFrom))
      ctx.addIssue({
        code: "custom",
        message: "A commitment requires an acceptance decision and its source",
      });
    if (
      a.fulfillment === "fulfilled" &&
      (!a.deliveryIds.length || !a.feedbackIds.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Fulfillment requires delivery and explicit feedback",
      });
  });
export type Activity = z.infer<typeof activitySchema>;
export const activityChangeSchema = z
  .object({
    state: z
      .enum([
        "candidate",
        "active",
        "waiting",
        "paused",
        "completed",
        "abandoned",
        "failed",
      ])
      .optional(),
    reason: z.string().max(2000).optional(),
    nextCheckAt: instant.nullable().optional(),
    nextStep: z.string().max(4000).optional(),
    completedSteps: z.array(z.string().max(2000)).max(100).optional(),
    artifacts: z.array(id).max(100).optional(),
    externalResult: z
      .enum(["unknown", "partial", "verified", "failed"])
      .optional(),
    deliveryIds: z.array(id).max(100).optional(),
    feedbackIds: z.array(id).max(100).optional(),
    fulfillment: z
      .enum(["unknown", "pending", "fulfilled", "declined"])
      .optional(),
    reevaluationRequired: z.boolean().optional(),
  })
  .strict();
export const environmentResourceSchema = z
  .object({
    id,
    scope: id,
    url: id,
    readAt: instant,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    actionReceiptId: id,
    artifactId: id.nullable(),
    role: z.enum(["source", "note", "verification"]),
    verifies: id.nullable(),
  })
  .strict();
export type EnvironmentResource = z.infer<typeof environmentResourceSchema>;
export const internalSourceSchema = z
  .object({
    agentId: id,
    scope: id,
    ownerId: z.literal("self:kaguya"),
    type: z.enum([
      "persona-seed",
      "internal-choice",
      "experience",
      "capability-evidence",
    ]),
    text: z.string().min(1).max(16000),
    basis: z.array(id).min(1).max(100),
    occurredAt: instant,
    relatedPersonIds: z.array(id).max(20).optional(),
  })
  .strict();
export type InternalSource = z.infer<typeof internalSourceSchema>;
export const continuityChatDecisionSchema = z
  .object({
    kind: z.enum(["none", "defer", "accept", "deliver", "feedback"]),
    activityId: z.string().nullable(),
    requestId: z.string().nullable(),
    title: z.string().max(1000),
    goal: z.string().max(4000),
    nextStep: z.string().max(4000),
    dueAt: z.iso.datetime().nullable(),
    outcome: z.enum(["fulfilled", "declined"]).nullable(),
  })
  .strict();

export const continuityHostSchema = z
  .object({
    version: id,
    tools: z
      .array(
        z
          .object({
            id,
            version: id,
            providerId: id,
            providerVersion: id,
            policyVersion: id,
            readonly: z.boolean(),
            independent: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    environments: z
      .array(
        z
          .object({
            intentId: id,
            environmentId: id,
            generation: z.number().int().nonnegative(),
            workspaceId: id,
            workflowId: id,
            leaseId: id,
            expiresAt: instant,
            validity: z.enum(["unexpired", "expired"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type ContinuityHost = z.infer<typeof continuityHostSchema>;
export const continuityViewSchema = z
  .object({
    agentId: id,
    revision: z.number().int().nonnegative(),
    policy: continuityPolicySchema,
    policyInformationId: id,
    contextInformationId: id,
    state: currentStateSchema.nullable(),
    stateValidity: z.enum(["unevaluated", "current", "expired", "unavailable"]),
    activitiesTruncated: z.boolean().optional(),
    resourcesTruncated: z.boolean().optional(),
    activities: z.array(activitySchema).max(100),
    resources: z.array(environmentResourceSchema).max(100),
    executionOutcomes: z
      .array(
        z
          .object({
            activityId: id,
            receiptId: id,
            intentId: id,
            operationId: id,
            attemptId: id.nullable(),
            toolName: id,
            status: z.enum([
              "succeeded",
              "rejected",
              "cancelled",
              "partial",
              "unknown",
            ]),
            evidence: id,
            resultHash: id,
            jobId: id.nullable(),
            recordedAt: instant,
            readOnly: z.boolean(),
          })
          .strict(),
      )
      .max(64),
    busy: z.boolean(),
    mainActivityId: id.nullable(),
    mainWorkKind: z.enum(["activity", "request"]).nullable(),
    budget: z
      .object({
        day: id,
        timeZone: id,
        used: z.number().int().nonnegative(),
        limit: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
      })
      .strict(),
    host: continuityHostSchema.optional(),
    asOf: instant,
  })
  .strict();
export type ContinuityView = z.infer<typeof continuityViewSchema>;

export const personContinuitySchema = z
  .object({
    ownerId: id,
    scope: id,
    scopes: z.array(id),
    nodes: z.array(nativeMemoryNodeSchema).max(100),
    activities: z.array(activitySchema).max(100),
    truncated: z.boolean(),
    asOf: instant,
  })
  .strict();
export type PersonContinuity = z.infer<typeof personContinuitySchema>;
