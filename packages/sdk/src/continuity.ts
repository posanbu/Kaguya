/**
 * 持续状态与活动的公共边界。Memory 保存认识，本端口保存执行和预算事实。
 * 所有写入使用操作 ID 和预期版本。主观评价不具有宿主授权能力。
 */
import {
  z,
  type NativeMemorySnapshot,
  type InformationAtom,
} from "@kaguya/schema";
import {
  continuityPolicySchema,
  subjectiveStateSchema,
  currentStateSchema,
  activitySchema,
  environmentResourceSchema,
  internalSourceSchema,
  continuityViewSchema,
  type ContinuityPolicy,
  type SubjectiveState,
  type CurrentState,
  type Activity,
  type EnvironmentResource,
  type InternalSource,
  type ContinuityView,
} from "@kaguya/schema";
export {
  continuityPolicySchema,
  subjectiveStateSchema,
  currentStateSchema,
  activitySchema,
  environmentResourceSchema,
  internalSourceSchema,
  continuityViewSchema,
  type ContinuityPolicy,
  type SubjectiveState,
  type CurrentState,
  type Activity,
  type EnvironmentResource,
  type InternalSource,
  type ContinuityView,
} from "@kaguya/schema";
import { defineModuleCapability } from "./modules.js";
import { defineInformationKind } from "./information-kind.js";
import type { ActionReceipt } from "./action.js";

const fact = (kind: string, displayName: string) =>
  defineInformationKind({
    kind,
    displayName,
    description: "保存版本化事实和原始依据，投影可从账本重建。",
    payloadSchema: z.record(z.string(), z.json()),
    references: {
      "core:uses-context": { required: false, multiple: true },
      "core:context": { required: false, multiple: false },
    },
    log: { enabled: false },
  });
export const continuityPolicyKind = fact(
  "agent.continuity.policy.v1",
  "自主活动策略",
);
export const continuityStateKind = fact(
  "agent.continuity.state.v1",
  "主观状态评价",
);
export const continuityActivityKind = fact(
  "agent.continuity.activity.v1",
  "活动版本",
);
export const continuityBudgetKind = fact(
  "agent.continuity.budget.v1",
  "自主模型调用预算",
);
export const continuityResourceKind = fact(
  "agent.continuity.resource.v1",
  "环境资源观察",
);
export const continuityInternalKind = fact(
  "agent.continuity.internal-source.v1",
  "可核验的内部来源",
);
export const continuityFrozenKind = fact(
  "agent.continuity.frozen.v1",
  "持续活动冻结输入",
);
export const continuityExecutionFrozenKind = fact(
  "agent.continuity.execution.frozen.v1",
  "自主执行冻结输入",
);
export const continuityDeliveryPlanKind = fact(
  "agent.continuity.delivery-plan.v1",
  "约定的投递计划",
);
export const continuityCoordinationKind = fact(
  "agent.continuity.coordination.v1",
  "主行动协调",
);
export const continuityKinds = [
  continuityPolicyKind,
  continuityStateKind,
  continuityActivityKind,
  continuityBudgetKind,
  continuityResourceKind,
  continuityInternalKind,
  continuityFrozenKind,
  continuityExecutionFrozenKind,
  continuityDeliveryPlanKind,
  continuityCoordinationKind,
] as const;

export interface ContinuityOperation {
  agentId: string;
  operationId: string;
  expectedRevision: number;
}

export interface ActivityCreate {
  id: string;
  scope: string;
  kind: Activity["kind"];
  title: string;
  goal: string;
  sources: string[];
  memoryDependencies?: Activity["memoryDependencies"];
  personIds?: string[];
  acceptedBy?: string;
  acceptedFrom?: string;
  nextStep?: string;
  nextCheckAt?: string | null;
}
export interface ActivityChange {
  state?: Activity["state"];
  reason?: string;
  nextCheckAt?: string | null;
  nextStep?: string;
  completedSteps?: string[];
  artifacts?: string[];
  externalResult?: Activity["externalResult"];
  deliveryIds?: string[];
  feedbackIds?: string[];
  fulfillment?: Activity["fulfillment"];
  reevaluationRequired?: boolean;
}
export interface ContinuityAccess {
  read(
    agentId: string,
    scope: string,
    at?: string,
  ): Promise<ContinuityView | null>;
  configure(
    input: ContinuityOperation & { policy: ContinuityPolicy; basis: string[] },
  ): Promise<number>;
  evaluate(
    input: ContinuityOperation & {
      scope: string;
      subjective: SubjectiveState;
      basis: string[];
    },
  ): Promise<CurrentState>;
  create(
    input: ContinuityOperation & { activity: ActivityCreate },
  ): Promise<Activity>;
  change(
    input: ContinuityOperation & {
      activityId: string;
      change: ActivityChange;
      basis: string[];
    },
  ): Promise<Activity>;
  charge(input: {
    agentId: string;
    operationId: string;
    purpose: "appraisal" | "choice" | "execution" | "retry";
    basis: string[];
  }): Promise<{ allowed: boolean; informationId: string; remaining: number }>;
  internalSource(input: {
    operationId: string;
    source: InternalSource;
  }): Promise<{ informationId: string; source: InternalSource }>;
  resource(input: {
    agentId: string;
    operationId: string;
    resource: EnvironmentResource;
  }): Promise<string>;
  planDelivery(input: {
    agentId: string;
    operationId: string;
    activityId: string;
    scope: string;
    completedInformationId: string;
  }): Promise<string>;
  observeDelivery(input: {
    agentId: string;
    deliveryInformationId: string;
  }): Promise<void>;
  feedback(input: {
    agentId: string;
    activityId: string;
    feedbackInformationId: string;
    completedInformationId: string;
    outcome: "fulfilled" | "declined";
  }): Promise<Activity>;
  frozen(
    agentId: string,
    operationId: string,
    scope: string,
  ): Promise<{
    informationId: string;
    view: ContinuityView;
    atom: InformationAtom;
  } | null>;
  receipts(
    agentId: string,
    scope: string,
    runInformationId: string,
  ): Promise<ActionReceipt[]>;
  freeze(input: {
    agentId: string;
    operationId: string;
    scope: string;
    basis: string[];
    activityId?: string;
    memory?: NativeMemorySnapshot;
  }): Promise<{
    informationId: string;
    view: ContinuityView;
    atom: InformationAtom;
  }>;
}
export const continuityCapability = defineModuleCapability<ContinuityAccess>(
  "agent:continuity",
  1,
);
