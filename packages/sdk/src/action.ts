/**
 * 功能概述：声明持久行动、执行证据及环境租约的公共契约，区分派发资格与外部效果。
 * 主要职责：schema 固定 intent/attempt/receipt 身份；ActionAccess 只提供受授权的行动操作，
 * MemoryDependencyCheck 是诊断结果，最终 admission 必须在仓储事务中重新校验。
 * 代码库关系：database 实现原子状态与证据，runtime 调用 provider，Heavy/MCP/环境通过 capability 接入。
 * 输入输出与副作用：声明本身无 I/O；取消请求不表示停止，unknown 可以由追加核对事实澄清。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "./information-kind.js";
import { defineModuleCapability } from "./modules.js";

const id = z.string().min(1).max(1000);
export const actionDecisionSchema = z
  .object({
    observationId: id,
    domain: z.enum(["tool", "message"]),
    reason: id,
    policyVersion: id,
  })
  .strict();
export const actionDecisionInformationKind = defineInformationKind({
  kind: "agent.action.decision.v1",
  displayName: "行动决策",
  description: "固定行动所用观察、领域和决策策略。",
  payloadSchema: actionDecisionSchema,
  references: { "core:uses-context": { required: true, multiple: true } },
  log: { enabled: false },
});
export const actionDependenciesSchema = z
  .object({
    observationId: id,
    evidenceInformationId: id.optional(),
    memoryRevisions: z
      .array(z.object({ id, revision: z.number().int().positive() }).strict())
      .max(1000),
    sourceInformationIds: z.array(id).max(1000),
  })
  .strict();
export type ActionDependencies = z.infer<typeof actionDependenciesSchema>;
export interface MemoryDependencyCheck {
  valid: boolean;
  reasons: { id: string; reason: string }[];
  checkedPublicationPosition: string;
}
export const actionEnvironmentSchema = z
  .object({
    environmentId: id,
    generation: z.number().int().nonnegative(),
    workspaceId: id,
    resourceIds: z.array(id),
    workflowId: id,
    leaseId: id,
    fencing: z.string().regex(/^\d+$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ActionEnvironment = z.infer<typeof actionEnvironmentSchema>;
export const actionIntentSchema = z
  .object({
    operationId: id,
    runInformationId: id,
    decisionInformationId: id,
    scope: id,
    sceneId: id,
    authorizationId: id,
    authorizationVersion: z.number().int().positive(),
    domain: z.enum(["tool", "message"]),
    providerId: id,
    providerVersion: id,
    executor: id,
    toolName: id,
    toolCallId: id.optional(),
    target: z.record(z.string(), z.json()),
    arguments: z.record(z.string(), z.json()),
    dependencies: actionDependenciesSchema,
    dependsOn: z.array(id).max(100),
    environment: actionEnvironmentSchema.optional(),
    deadline: z.iso.datetime(),
  })
  .strict();
export type ActionIntent = z.infer<typeof actionIntentSchema>;
export const actionOutcomeSchema = z
  .object({
    status: z.enum([
      "succeeded",
      "rejected",
      "cancelled",
      "partial",
      "unknown",
    ]),
    evidence: z.enum([
      "returned",
      "observed",
      "effect-verified",
      "not-executed",
      "unconfirmed",
    ]),
    result: z.json(),
    artifacts: z
      .array(
        z
          .object({
            id,
            hash: id,
            mime: id,
            size: z.number().int().nonnegative(),
            scope: id,
            actionId: id,
            generation: z.number().int().nonnegative().optional(),
            observedAt: z.iso.datetime(),
            source: id,
            retention: id,
          })
          .strict(),
      )
      .default([]),
    truncated: z.boolean().default(false),
    providerReceiptId: id.optional(),
    /** 宿主对结果接纳时环境的校验；不改变原 attempt 已发生的效果。 */
    environmentValidation: z
      .enum(["current", "fenced", "unconfirmed"])
      .optional(),
  })
  .strict();
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
export interface ActionView {
  intentId: string;
  intent: ActionIntent;
  digest: string;
  state:
    | "queued"
    | "started"
    | "cancel_requested"
    | "succeeded"
    | "rejected"
    | "cancelled"
    | "superseded"
    | "partial"
    | "unknown";
  attemptId: string | null;
  startedInformationId: string | null;
  receiptId: string | null;
  cancellationId: string | null;
}
export interface ActionReceipt {
  receiptId: string;
  intentId: string;
  intent: ActionIntent;
  attemptId: string | null;
  startedInformationId: string | null;
  reconcilesReceiptId: string | null;
  outcome: ActionOutcome;
  resultHash: string;
  registeredPosition: string;
  recordedAt: string;
}
export interface ActionIntervention {
  intentId: string;
  scope: string;
  causeInformationId: string;
  controlAuthorizationId: string;
}
export interface ActionAccess {
  register(input: ActionIntent): Promise<ActionView>;
  execute(intentId: string, scope: string): Promise<ActionView>;
  cancel(input: ActionIntervention): Promise<ActionView>;
  supersede(
    input: ActionIntervention & { replacementIntentId: string },
  ): Promise<ActionView>;
  reconcile(
    intentId: string,
    scope: string,
    controlAuthorizationId: string,
    environment?: z.infer<typeof actionEnvironmentSchema>,
  ): Promise<ActionView>;
  read(intentId: string, scope: string): Promise<ActionView>;
  readReceipt(
    receiptId: string,
    scope: string,
    authorizationId: string,
  ): Promise<ActionReceipt>;
}
export const actionCapability = defineModuleCapability<ActionAccess>(
  "agent:action",
  1,
);
export interface ActionRunValidity {
  runValidity(
    runInformationId: string,
    scope: string,
  ): Promise<{ valid: boolean; causeInformationId: string | null }>;
}
export const actionRunValidityCapability =
  defineModuleCapability<ActionRunValidity>("agent:action-validity", 1);

export interface ActionProvider {
  id: string;
  version: string;
  capabilities: {
    cancellation: "none" | "request-confirm";
    idempotency: "none" | "operation";
    reconciliation: boolean;
    successEvidence: "returned" | "observed" | "effect-verified";
    fencing: "none" | "environment";
  };
  execute(input: ActionExecution): Promise<ActionOutcome>;
  cancel?(input: ActionExecution): Promise<ActionOutcome | undefined>;
  reconcile?(input: ActionExecution): Promise<ActionOutcome>;
}
export interface ActionExecution {
  intentId: string;
  attemptId: string;
  operationId: string;
  digest: string;
  intent: ActionIntent;
  signal: AbortSignal;
  /** 宿主即时解析，仅传执行器，不写入 Information/receipt/模型。 */
  leaseCredential?: { token: string };
  controlAuthorizationId?: string;
  /** 核对可以使用新租约，原 intent 中的执行 generation 始终保留。 */
  reconciliationEnvironment?: z.infer<typeof actionEnvironmentSchema>;
}
