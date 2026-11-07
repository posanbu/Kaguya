/**
 * 功能概述：在持久 admission 提交后调用原生/provider 工具，保持动作与模型生成分离。
 * 主要职责：execute 验版本、环境和 claim 后调用一次；cancel 先落盘再向 provider 请求确认；
 * reconcile 只查询原 attempt，readReceipt 经宿主权限重读事实。超时/关闭保存 unknown，迟到旧 claim 不写结果。
 * 代码库关系：宿主注入 PostgresActionStore、provider 和环境 broker 校验；SDK capability 供 Heavy/MCP 使用。
 * 输入输出与副作用：provider I/O 始终在 SQL 事务外；未知结果不重发，异常正文不进入持久错误。
 */
import { type PostgresActionStore, type ActionClaim } from "@kaguya/database";
import {
  actionOutcomeSchema,
  type ActionAccess,
  type ActionProvider,
  type ActionExecution,
  type ActionOutcome,
  type ActionIntent,
  type ActionIntervention,
  type ActionView,
  type actionEnvironmentSchema,
} from "@kaguya/sdk";
import type { InformationCore } from "@kaguya/engine";
import type { z } from "@kaguya/schema";

const unknown = (reason: string): ActionOutcome => ({
  status: "unknown",
  evidence: "unconfirmed",
  result: { reason },
  artifacts: [],
  truncated: false,
});
const rejected = (reason: string): ActionOutcome => ({
  status: "rejected",
  evidence: "not-executed",
  result: { reason },
  artifacts: [],
  truncated: false,
});
export interface ActionExecutorOptions {
  store: PostgresActionStore;
  providers: readonly ActionProvider[];
  core?: InformationCore;
  leaseMs?: number;
  onRecoveryError?: () => void;
  resolveLeaseCredential?: (
    execution: ActionExecution,
    mode: "execute" | "reconcile" | "cancel",
  ) => Promise<{ token: string }>;
  validateEnvironment?: (
    execution: ActionExecution,
    mode: "execute" | "reconcile" | "result",
  ) => Promise<boolean>;
}
export class ActionExecutor implements ActionAccess {
  private readonly providers = new Map<string, ActionProvider>();
  private readonly active = new Map<
    string,
    {
      claim: ActionClaim;
      input: ActionExecution;
      provider: ActionProvider;
      controller: AbortController;
    }
  >();
  private closed = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryWork?: Promise<void>;
  startRecovery() {
    const schedule = () => {
      if (this.closed) return;
      this.recoveryTimer = setTimeout(() => {
        this.recoveryWork = this.options.store
          .recoverExpired()
          .catch(() => {
            this.options.onRecoveryError?.();
          })
          .finally(schedule);
      }, 1000);
      this.recoveryTimer.unref?.();
    };
    if (!this.recoveryTimer && !this.closed) schedule();
  }
  constructor(private readonly options: ActionExecutorOptions) {
    for (const provider of options.providers) {
      if (this.providers.has(provider.id))
        throw new Error("duplicate-action-provider");
      if (
        (provider.capabilities.reconciliation && !provider.reconcile) ||
        (provider.capabilities.cancellation === "request-confirm" &&
          !provider.cancel)
      )
        throw new Error("incomplete-action-provider");
      this.providers.set(provider.id, provider);
    }
  }
  register(input: ActionIntent) {
    return this.options.store.register(
      input,
      this.options.core?.executionClaim,
    );
  }
  read(id: string, scope: string) {
    return this.options.store.read(id, scope);
  }
  readReceipt(id: string, scope: string, authorizationId: string) {
    return this.options.store.readReceipt(id, scope, authorizationId);
  }
  async execute(id: string, scope: string): Promise<ActionView> {
    if (this.closed) throw new Error("action-executor-closed");
    const original = await this.read(id, scope);
    const provider = this.providers.get(original.intent.providerId);
    if (!provider || provider.version !== original.intent.providerVersion)
      throw new Error("action-provider-unavailable");
    const admitted = await this.options.store.admit(
      id,
      scope,
      this.options.leaseMs ?? 30000,
      this.options.core?.executionClaim,
    );
    if (!admitted.claim) return admitted.view;
    return this.invoke(admitted.view, admitted.claim, provider, false);
  }
  private async invoke(
    view: ActionView,
    claim: ActionClaim,
    provider: ActionProvider,
    reconcile: boolean,
    environment?: z.infer<typeof actionEnvironmentSchema>,
    controlAuthorizationId?: string,
  ) {
    const controller = new AbortController();
    const input: ActionExecution = {
      intentId: view.intentId,
      attemptId: claim.attemptId,
      operationId: view.intent.operationId,
      digest: view.digest,
      intent: view.intent,
      signal: controller.signal,
      ...(environment ? { reconciliationEnvironment: environment } : {}),
      ...(controlAuthorizationId ? { controlAuthorizationId } : {}),
    };
    const parent = this.options.core?.executionSignal;
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) controller.abort();
    this.active.set(view.intentId, { claim, input, provider, controller });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let returned: ActionOutcome | undefined;
    const interruptedOutcome = (reason: string) =>
      returned
        ? { ...returned, environmentValidation: "unconfirmed" as const }
        : unknown(reason);
    try {
      const timeout = Math.max(
        1,
        Math.min(
          (this.options.leaseMs ?? 30000) - 1000,
          reconcile
            ? (this.options.leaseMs ?? 30000)
            : Date.parse(view.intent.deadline) - Date.now(),
        ),
      );
      const interrupted = new Promise<ActionOutcome>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => resolve(interruptedOutcome("execution-interrupted")),
          { once: true },
        );
        timer = setTimeout(() => {
          resolve(interruptedOutcome("execution-deadline"));
          controller.abort();
        }, timeout);
      });
      const operation = (async (): Promise<ActionOutcome> => {
        if (controller.signal.aborted || this.closed)
          return unknown("execution-interrupted");
        if (view.intent.environment && this.options.resolveLeaseCredential)
          input.leaseCredential = await this.options.resolveLeaseCredential(
            input,
            reconcile ? "reconcile" : "execute",
          );
        if (controller.signal.aborted || this.closed)
          return unknown("execution-interrupted");
        if (
          view.intent.environment &&
          (!input.leaseCredential ||
            !this.options.validateEnvironment ||
            provider.capabilities.fencing !== "environment" ||
            !(await this.options.validateEnvironment(
              input,
              reconcile ? "reconcile" : "execute",
            )))
        )
          return reconcile
            ? unknown("environment-unavailable")
            : rejected("environment-denied");
        if (controller.signal.aborted || this.closed)
          return unknown("execution-interrupted");
        if (
          !reconcile &&
          !(await this.options.store.canInvoke(claim, view.intent.scope))
        )
          return {
            ...rejected("stopped-before-invocation"),
            status: "cancelled",
          };
        if (controller.signal.aborted || this.closed)
          return unknown("execution-interrupted");
        // Broker 必须在实际入口再次验证租约、generation 和取消 tombstone。
        returned = this.acceptOutcome(
          await (reconcile
            ? provider.reconcile!(input)
            : provider.execute(input)),
          input,
          provider,
        );
        if (controller.signal.aborted)
          return interruptedOutcome("execution-interrupted");
        if (view.intent.environment && this.options.validateEnvironment) {
          const current = await this.options.validateEnvironment(
            input,
            reconcile ? "reconcile" : "result",
          );
          return {
            ...returned,
            environmentValidation: current ? "current" : "fenced",
          };
        }
        return returned;
      })().catch(() => interruptedOutcome("provider-result-unconfirmed"));
      const outcome = await Promise.race([operation, interrupted]);
      // 持久化/fencing 错误保持基础设施错误，不能冒充 provider 失败。
      const result = await this.options.store.finish(
        claim,
        view.intent.scope,
        outcome,
        reconcile,
        this.options.core?.executionClaim,
      );
      await this.options.store.acknowledge(view.intentId, view.intent.scope);
      return result;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
      if (this.active.get(view.intentId)?.claim.token === claim.token)
        this.active.delete(view.intentId);
      await this.options.store.release(claim, view.intent.scope);
    }
  }
  private acceptOutcome(
    raw: unknown,
    input: ActionExecution,
    provider: ActionProvider,
  ): ActionOutcome {
    if (
      input.leaseCredential &&
      JSON.stringify(raw).includes(
        JSON.stringify(input.leaseCredential.token).slice(1, -1),
      )
    )
      return unknown("provider-returned-credential");
    const output = actionOutcomeSchema.parse(raw);
    delete output.environmentValidation;
    for (const artifact of output.artifacts)
      if (
        artifact.scope !== input.intent.scope ||
        artifact.actionId !== input.intentId ||
        artifact.generation !== input.intent.environment?.generation
      )
        throw new Error("action-artifact-mismatch");
    const rank = {
      returned: 0,
      observed: 1,
      "effect-verified": 2,
      "not-executed": -1,
      unconfirmed: -1,
    };
    if (
      output.status === "succeeded" &&
      rank[output.evidence] < rank[provider.capabilities.successEvidence]
    )
      return unknown("success-evidence-insufficient");
    return output;
  }
  cancel(input: ActionIntervention) {
    return this.cancelWithForwarding(input, false);
  }
  /** 宿主持久取消队列使用：转发失败必须可重试；转发成功不表示物理效果已撤回。 */
  cancelForwarded(input: ActionIntervention) {
    return this.cancelWithForwarding(input, true);
  }
  private async cancelWithForwarding(
    input: ActionIntervention,
    requireForwarded: boolean,
  ) {
    const view = await this.options.store.intervene(input);
    const provider = this.providers.get(view.intent.providerId);
    if (
      view.attemptId &&
      ["cancel_requested", "unknown", "partial"].includes(view.state) &&
      provider?.cancel &&
      provider.version === view.intent.providerVersion
    ) {
      const controller = new AbortController();
      const controlInput: ActionExecution = {
        intentId: view.intentId,
        attemptId: view.attemptId,
        operationId: view.intent.operationId,
        digest: view.digest,
        intent: view.intent,
        signal: controller.signal,
        controlAuthorizationId: input.controlAuthorizationId,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forwarded = false;
      try {
        const work = (async () => {
          if (view.intent.environment && this.options.resolveLeaseCredential)
            controlInput.leaseCredential =
              await this.options.resolveLeaseCredential(controlInput, "cancel");
          if (
            controller.signal.aborted ||
            (view.intent.environment && !controlInput.leaseCredential)
          )
            return undefined;
          const result = await provider.cancel!(controlInput);
          forwarded = true;
          return result === undefined
            ? undefined
            : this.acceptOutcome(result, controlInput, provider);
        })().catch((error) => {
          if (requireForwarded) throw error;
          return undefined;
        });
        const receipt = await Promise.race([
          work,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve(undefined);
            }, 10000);
          }),
        ]);
        if (requireForwarded && !forwarded)
          throw new Error("action-cancel-forwarding-unconfirmed");
        // broker 可返回原成功/拒绝回执，说明取消已送达；它不是取消证据。
        // 原 unknown/partial 只由显式 reconciliation 升级，不在取消路径改写。
        if (
          receipt &&
          ["cancelled", "partial", "unknown"].includes(receipt.status)
        )
          return this.options.store.confirmCancellation(
            input,
            view.attemptId,
            receipt,
          );
      } finally {
        clearTimeout(timer);
      }
    }
    if (
      requireForwarded &&
      view.attemptId &&
      ["cancel_requested", "unknown", "partial"].includes(view.state) &&
      (!provider?.cancel || provider.version !== view.intent.providerVersion)
    )
      throw new Error("action-cancel-forwarding-unavailable");
    return view;
  }
  async supersede(input: ActionIntervention & { replacementIntentId: string }) {
    await this.options.store.intervene(input, input.replacementIntentId);
    return this.cancel(input);
  }
  async reconcile(
    id: string,
    scope: string,
    controlAuthorizationId: string,
    environment?: z.infer<typeof actionEnvironmentSchema>,
  ) {
    const view = await this.read(id, scope),
      provider = this.providers.get(view.intent.providerId);
    if (
      !provider?.reconcile ||
      !provider.capabilities.reconciliation ||
      provider.version !== view.intent.providerVersion
    )
      return view;
    if (
      environment &&
      (!view.intent.environment ||
        environment.environmentId !== view.intent.environment.environmentId)
    )
      throw new Error("reconciliation-environment-mismatch");
    const claim = await this.options.store.claimReconciliation(
      id,
      scope,
      this.options.leaseMs ?? 30000,
      controlAuthorizationId,
    );
    return claim
      ? this.invoke(
          view,
          claim,
          provider,
          true,
          environment,
          controlAuthorizationId,
        )
      : view;
  }
  invalidateRun(
    runInformationId: string,
    scope: string,
    causeInformationId: string,
  ) {
    return this.options.store.invalidateRun(
      runInformationId,
      scope,
      causeInformationId,
    );
  }
  async close() {
    this.closed = true;
    clearTimeout(this.recoveryTimer);
    for (const entry of this.active.values()) entry.controller.abort();
    await this.recoveryWork;
  }
}
