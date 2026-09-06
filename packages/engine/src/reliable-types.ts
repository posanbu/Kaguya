/**
 * 功能概述：定义可靠 DAG 的持久化执行端口，业务事实仍由 InformationLedger 保存。
 * 主要职责：ReliableInformationLedger 提供唯一槽提交、订阅启停、claim/ack/retry/release、耗尽与健康指标。
 * 代码库关系：Database 实现本端口，Core 与 ReliableInformationRunner 使用它；模块不直接取得执行表。
 * 输入输出与副作用：所有写方法具有事务语义；claim token 是 fencing 凭证，唯一提交返回实际赢家及 created 标记。
 */
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
} from "@kaguya/schema";
import type {
  InformationAppendOptions,
  InformationReferenceExpectation,
} from "./information-core.js";

export interface DurableSubscriptionDefinition {
  readonly subscriptionId: string;
  readonly kind: string;
}
export interface InformationClaim {
  /** 仅本次提交使用的宿主取消信号，不持久化。 */
  readonly signal?: AbortSignal;
  readonly subscriptionId: string;
  readonly informationId: InformationId;
  readonly token: string;
  readonly attempt: number;
  readonly leaseUntil: string;
}
export interface InformationCommitResult {
  readonly atom: DeepReadonly<InformationAtom>;
  readonly created: boolean;
}
export interface InformationExecutionHealth {
  readonly pending: number;
  readonly retry: number;
  readonly exhausted: number;
  readonly oldestPendingAgeMs: number;
}
export interface ReliableInformationLedger {
  configureSubscriptions(
    subscriptions: readonly DurableSubscriptionDefinition[],
  ): Promise<void>;
  claim(
    subscriptionId: string,
    leaseMs: number,
  ): Promise<InformationClaim | undefined>;
  ack(claim: InformationClaim): Promise<boolean>;
  retry(claim: InformationClaim, delayMs: number): Promise<boolean>;
  release(claim: InformationClaim): Promise<boolean>;
  health(): Promise<InformationExecutionHealth>;
  appendOnce(
    operation: string,
    key: string,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
    guard?: InformationClaim,
  ): Promise<InformationCommitResult>;
  appendTerminal(
    group: string,
    subject: InformationId,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
    guard?: InformationClaim,
  ): Promise<InformationCommitResult>;
  exhaust(
    claim: InformationClaim,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
  ): Promise<boolean>;
}
export class InformationClaimLostError extends Error {
  constructor() {
    super("Information claim expired or lost");
    this.name = "InformationClaimLostError";
  }
}
