/** 持续活动的窄宿主工具。投递沿用 Runtime 的持久消息桥接和最终出站校验。 */
import { randomUUID } from "node:crypto";
import {
  actionDigest,
  actionBasisDigest,
  actionExecutionDigest,
} from "@kaguya/database";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "@kaguya/schema";
import type { KaguyaDatabase } from "@kaguya/database";
import type { InformationCore } from "@kaguya/engine";
import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
} from "@kaguya/modules";
import type {
  ActionAccess,
  ActionExecution,
  ActionOutcome,
  ActionProvider,
} from "@kaguya/sdk";
import {
  nativeToolBinding,
  type NativeToolRegistration,
} from "./native-tool-loop.js";

const deliverSchema = z
  .object({
    activityId: z.string().min(1),
    text: z.string().trim().min(1).max(16000),
    resourceIds: z.array(z.string().min(1)).max(100),
  })
  .strict();
const inspectSchema = z
  .object({ activityId: z.string().min(1), receiptId: z.string().min(1) })
  .strict();
const result = (
  status: ActionOutcome["status"],
  evidence: ActionOutcome["evidence"],
  value: ActionOutcome["result"],
): ActionOutcome => ({
  status,
  evidence,
  result: value,
  artifacts: [],
  truncated: false,
});
export function createContinuityTools(
  db: KaguyaDatabase,
  core: InformationCore,
  host: {
    actions(): ActionAccess;
    registration(id: string): NativeToolRegistration | undefined;
  },
): { registrations: NativeToolRegistration[]; provider: ActionProvider } {
  const read = async (execution: ActionExecution) => {
    const scope = execution.intent.scope;
    const view = await db.continuity.read("kaguya", scope);
    const activityId = String(execution.intent.arguments.activityId ?? "");
    const activity = view?.activities.find(
      (a) => a.id === activityId && a.scope === scope,
    );
    if (!activity) throw new Error("activity-tool-scope-denied");
    return activity;
  };
  const deliveryResult = async (
    requestId: string,
    execution: ActionExecution,
  ) => {
    const terminal = (
      await db.information.inspectPage({
        referencedId: requestId,
        relation: "core:status-of",
        kinds: ["core.delivery.delivered", "core.delivery.failed"],
        limit: 2,
      })
    )[0];
    if (!terminal) return undefined;
    return result(
      terminal.kind === "core.delivery.delivered"
        ? "succeeded"
        : terminal.payload.outcome === "unknown"
          ? "unknown"
          : "rejected",
      terminal.kind === "core.delivery.delivered"
        ? "observed"
        : terminal.payload.outcome === "unknown"
          ? "unconfirmed"
          : "not-executed",
      {
        activityId: String(execution.intent.arguments.activityId),
        deliveryRequestId: requestId,
        deliveryInformationId: terminal.informationId,
      },
    );
  };
  return {
    registrations: [
      {
        id: "activity.deliver",
        inputSchema: deliverSchema,
        description:
          "履行当前已接受约定，发送正文到原请求范围。目标由宿主固定。投递不等于对方确认履约。",
        readonly: false,
        independent: false,
      },
      {
        id: "activity.reconcile",
        inputSchema: inspectSchema,
        description:
          "仅核对本活动未知回执的原操作，不重新执行。宿主重新检查原工具权限和环境。",
        readonly: true,
        independent: false,
      },
      {
        id: "activity.inspect",
        inputSchema: inspectSchema,
        description:
          "读取本活动原工具回执及操作身份。结果未知时先读取并核对原操作，不重新执行写入。",
        readonly: true,
        independent: true,
      },
    ].map((tool) => ({
      ...tool,
      version: "1",
      providerId: "core.continuity",
      providerVersion: "1",
      executor: "host:continuity",
      policyVersion: "continuity.v1",
      bind: async ({ arguments: args, scope }) => ({
        target: { scope, activityId: String(args.activityId) },
      }),
      authorize: async ({ intent }) =>
        intent.providerId === "core.continuity" &&
        intent.executor === "host:continuity" &&
        intent.target.scope === intent.scope &&
        intent.target.activityId === intent.arguments.activityId,
    })),
    provider: {
      id: "core.continuity",
      version: "1",
      capabilities: {
        cancellation: "none",
        idempotency: "operation",
        reconciliation: true,
        successEvidence: "observed",
        fencing: "none",
      },
      execute: async (execution) => {
        await read(execution);
        if (
          ["activity.inspect", "activity.reconcile"].includes(
            execution.intent.toolName,
          )
        ) {
          const activityId = String(execution.intent.arguments.activityId),
            receiptId = String(execution.intent.arguments.receiptId);
          const ids = await db.sql.query<{
            receipt_id: string;
            original_run: string;
            completed_id: string;
            bindings: Record<string, string>;
          }>(
            `SELECT h.receipt_id,h.input->>'runInformationId' original_run,c.completed_id,r.spec->'bindings' bindings FROM information_native_tool_calls c
            JOIN information_native_tool_runs r ON r.run_id=c.run_id JOIN information_action_heads h ON h.intent_id=c.intent_id
            JOIN information_action_receipts original ON original.intent_id=h.intent_id WHERE original.receipt_id=$1 AND r.spec->'continuity'->>'activityId'=$2 AND h.input->>'scope'=$3 LIMIT 1`,
            [receiptId, activityId, execution.intent.scope],
          );
          const id = ids.rows[0];
          if (!id)
            return result("rejected", "not-executed", {
              reason: "receipt-not-in-activity",
            });
          const receipts = await db.continuity.receipts(
            "kaguya",
            execution.intent.scope,
            id.original_run,
          );
          const receipt = receipts.find((r) => r.receiptId === id.receipt_id);
          if (!receipt)
            return result("rejected", "not-executed", {
              reason: "receipt-changed-read-again",
            });
          if (execution.intent.toolName === "activity.reconcile") {
            const original = receipt.intent;
            const registration = host.registration(original.toolName);
            if (
              !registration ||
              original.toolName === "activity.reconcile" ||
              registration.providerId !== original.providerId ||
              registration.providerVersion !== original.providerVersion ||
              nativeToolBinding(registration) !==
                id.bindings[original.toolName] ||
              !(await registration.authorize({
                intent: original,
                mode: "read",
              }))
            )
              return result("rejected", "not-executed", {
                reason: "original-tool-unavailable",
              });
            const binding = await registration.bind({
              arguments: original.arguments,
              scope: original.scope,
              runInformationId: original.runInformationId,
              stepInformationId: id.completed_id,
            });
            if (
              actionDigest(binding.target) !== actionDigest(original.target) ||
              binding.environment?.environmentId !==
                original.environment?.environmentId
            )
              return result("rejected", "not-executed", {
                reason: "original-environment-changed",
              });
            const authorizationId = `continuity-reconcile:${execution.intentId}:${randomUUID()}`;
            await db.actions.authorize({
              id: authorizationId,
              scope: original.scope,
              version: 1,
              providerId: original.providerId,
              executor: original.executor,
              targetDigest: actionDigest(original.target),
              argumentsDigest: actionDigest(original.arguments),
              operationId: original.operationId,
              basisDigest: actionBasisDigest(original),
              executionDigest: actionExecutionDigest(original),
              expiresAt: new Date(
                Math.min(
                  Date.parse(execution.intent.deadline),
                  Date.now() + 300000,
                ),
              ).toISOString(),
              causeInformationId: execution.intentId,
            });
            const reconciled = await host
              .actions()
              .reconcile(
                receipt.intentId,
                original.scope,
                authorizationId,
                binding.environment,
              );
            const observed = (
              await db.continuity.receipts(
                "kaguya",
                execution.intent.scope,
                id.original_run,
              )
            ).find((r) => r.receiptId === reconciled.receiptId);
            return result(
              "succeeded",
              "observed",
              JSON.parse(
                JSON.stringify({
                  intentId: receipt.intentId,
                  state: reconciled.state,
                  receiptId: reconciled.receiptId,
                  receipt: observed ?? null,
                }),
              ),
            );
          }
          return result(
            "succeeded",
            "observed",
            JSON.parse(JSON.stringify({ receipt })),
          );
        }
        if (execution.intent.toolName !== "activity.deliver")
          return result("rejected", "not-executed", {
            reason: "unknown-activity-tool",
          });
        let plan: Awaited<
          ReturnType<typeof db.continuity.prepareAutonomousDelivery>
        >;
        try {
          plan = await db.continuity.prepareAutonomousDelivery(execution);
        } catch {
          return result("rejected", "not-executed", {
            reason: "delivery-plan-unproved",
          });
        }
        execution.signal.throwIfAborted();
        const assistant = await core.registerOnce(
          "continuity.delivery.assistant",
          execution.intentId,
          assistantTextInformationKind,
          {
            occurredAt: new Date().toISOString(),
            source: "runtime:continuity",
            payload: {
              text: String(execution.intent.arguments.text),
              source: plan.address,
              originatingModuleInstanceId: `continuity.runtime:${execution.intentId}`,
              turn: null,
            },
            references: [
              {
                relation: "core:caused-by",
                informationId: plan.completedInformationId,
              },
              {
                relation: "core:context",
                informationId: plan.contextInformationId,
              },
            ],
          },
        );
        execution.signal.throwIfAborted();
        const request = await core.registerOnce(
          "continuity.delivery.request",
          execution.intentId,
          deliveryRequestedInformationKind,
          {
            occurredAt: new Date().toISOString(),
            source: "runtime:continuity",
            payload: {
              ...plan.address,
              message: {
                kind: "text",
                text: String(execution.intent.arguments.text),
              },
              turn: null,
            },
            references: [
              {
                relation: "core:caused-by",
                informationId: assistant.informationId,
              },
              {
                relation: "core:context",
                informationId: plan.contextInformationId,
              },
            ],
          },
        );
        const until = Math.min(
          Date.parse(execution.intent.deadline),
          Date.now() + 25000,
        );
        while (!execution.signal.aborted && Date.now() < until) {
          const terminal = await deliveryResult(
            request.informationId,
            execution,
          );
          if (terminal) return terminal;
          await delay(25, undefined, { signal: execution.signal }).catch(
            () => {},
          );
        }
        return result("unknown", "unconfirmed", {
          deliveryRequestId: request.informationId,
          reason: "delivery-receipt-pending",
        });
      },
      reconcile: async (execution) => {
        await read(execution);
        const requestId = await db.continuity.autonomousDeliveryRequest(
          execution.intentId,
        );
        return requestId
          ? ((await deliveryResult(requestId, execution)) ??
              result("unknown", "unconfirmed", {
                deliveryRequestId: requestId,
              }))
          : result("unknown", "unconfirmed", {
              reason: "delivery-request-unconfirmed",
            });
      },
    },
  };
}
