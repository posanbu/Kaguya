/**
 * 功能概述：把原生 run/step/model/call/result 链投影为独立阶段，保留两个 run ID 和逐步知识边界。
 * cancellation 读取原点停止与转发事实；steps 核对持久索引和模型 nativeStep；calls 校验原 call、
 * action 与回执配对，错误引用不暴露正文。模型未知直接读取 typed reasonCode，不解析错误文本。
 * 代码库关系：inspection-domain 组合本模块，GUI 任务复用取消读取；只读原表，不恢复任务。
 */
import {
  actionDigest,
  type InspectionReader,
  type InspectionRow,
} from "@kaguya/database";
import {
  inspectionRunPageSchema,
  inspectionRunDetailSchema,
} from "@kaguya/schema";
import {
  DomainReader,
  denied,
  object,
  list,
  text,
  reference,
  hasReference,
} from "./inspection-domain-common.js";
import { verifiedReceipt } from "./inspection-actions.js";

export async function cancellation(
  r: InspectionReader,
  origin: unknown,
  persistedKey?: string | null,
) {
  if (!origin && !persistedKey) return null;
  const rows = await r.cancellation(persistedKey ?? actionDigest(origin));
  const requested = rows.find(
    (f) => f.kind === "agent.heavy.tool.origin.cancelled.v1",
  );
  if (!requested) return null;
  const forwarded = rows.find(
    (f) =>
      f.kind === "agent.heavy.tool.cancel.forwarded.v1" &&
      hasReference(f, requested.id, "core:uses-context"),
  );
  return {
    state: forwarded ? ("forwarded" as const) : ("pending" as const),
    requestedInformationId: requested.id,
    forwardedInformationId: forwarded?.id ?? null,
  };
}
export async function runSummary(
  r: InspectionReader,
  row: InspectionRow,
  at: string,
) {
  const terminal = row.stopped_id ? await r.fact(row.stopped_id) : undefined;
  return {
    runInformationId: row.run_id,
    actionRunInformationId: row.spec.actionRunInformationId,
    observationId: row.spec.observationId,
    sceneId: row.spec.sceneId,
    at,
    deadline: row.spec.deadline,
    terminalReason:
      terminal?.kind === "agent.heavy.tool.terminal.v1" &&
      terminal.payload.runInformationId === row.run_id
        ? text(terminal.payload.reason)
        : null,
  };
}
export function runInspection(d: DomainReader) {
  return {
    runs: (input: unknown) =>
      d.read(input, "runs", async (r, q, meta, before, cursor) => {
        const facts = await r.facts(
            ["agent.heavy.tool.run.v1"],
            q.scope,
            before,
            q.limit + 1,
          ),
          page = facts.slice(0, q.limit),
          items = [];
        for (const f of page) {
          const row = await r.run(f.id, q.scope);
          if (row) items.push(await runSummary(r, row, f.at));
        }
        return inspectionRunPageSchema.parse({
          ...meta,
          items,
          nextCursor:
            facts.length > q.limit ? cursor(page.at(-1)!.position) : null,
          truncated: facts.length > q.limit,
        });
      }),
    run: (id: string, input: unknown) =>
      d.read(input, `run:${id}`, async (r, q, meta) => {
        const row = await r.run(id, q.scope),
          root = await r.fact(id);
        if (!row || root?.kind !== "agent.heavy.tool.run.v1") throw denied();
        const rawSteps = await r.steps(id),
          rawCalls = await r.calls(id),
          steps = [];
        for (const s of rawSteps.slice(0, 32)) {
          const frozen = await r.fact(s.frozen_id),
            request = s.request_id ? await r.fact(s.request_id) : undefined,
            dispatch = s.dispatched_id
              ? await r.fact(s.dispatched_id)
              : undefined;
          const frozenValid =
            frozen?.kind === "agent.heavy.tool.step.frozen.v1" &&
            frozen.payload.runInformationId === id &&
            frozen.payload.stepIndex === s.step_index &&
            frozen.payload.observationId === row.spec.observationId;
          const requested =
            request?.kind === "core.model.task.requested" &&
            request.payload.nativeStep?.runInformationId === id &&
            request.payload.nativeStep?.stepIndex === s.step_index &&
            hasReference(request, s.frozen_id, "core:uses-context");
          const terminals = requested
            ? await r.related(
                request!.id,
                [
                  "core.model.task.completed",
                  "core.model.task.failed",
                  "core.model.task.cancelled",
                ],
                "core:status-of",
                3,
              )
            : [];
          const terminal = terminals.length === 1 ? terminals[0] : undefined;
          const dispatched =
            requested &&
            dispatch?.kind === "core.model.task.dispatched.v1" &&
            dispatch.payload.requestedInformationId === request!.id &&
            hasReference(dispatch, request!.id, "core:caused-by");
          steps.push({
            stepIndex: s.step_index,
            frozenInformationId: s.frozen_id,
            requestInformationId: requested ? request!.id : null,
            dispatchInformationId: dispatched ? dispatch!.id : null,
            terminalInformationId: terminal?.id ?? null,
            phase:
              !frozenValid ||
              (s.request_id && !requested) ||
              (s.dispatched_id && !dispatched) ||
              terminals.length > 1
                ? "invalid"
                : terminal
                  ? terminal.kind.split(".").at(-1)
                  : dispatched
                    ? "dispatched-unconfirmed"
                    : requested
                      ? "requested"
                      : "frozen",
            reasonCode: text(terminal?.payload.error?.reasonCode),
            generationKind: text(terminal?.payload.generationKind),
            contextTrimming: requested
              ? (request!.payload.contextTrimming ?? null)
              : null,
            frozen: frozenValid ? d.safe(frozen!.payload) : null,
          });
        }
        const calls = [];
        for (const c of rawCalls.slice(0, 128)) {
          const completed = await r.fact(c.completed_id),
            result = c.result_id ? await r.fact(c.result_id) : undefined;
          const action = c.intent_id
            ? await r.action(c.intent_id, q.scope)
            : undefined;
          const call = list(completed?.payload.toolCalls).find(
            (x) => x.toolCallId === c.call_id,
          );
          const p = object(result?.payload),
            receipt = p.receiptId ? await r.fact(p.receiptId) : undefined;
          const declaration = list(row.spec.declarations).find(
            (x) => x.wireName === c.call.toolName,
          );
          const decision = action
            ? await r.fact(action.input.decisionInformationId)
            : undefined;
          let valid =
            completed?.kind === "core.model.task.completed" &&
            completed.payload.nativeStep?.runInformationId === id &&
            completed.payload.nativeStep?.stepIndex === c.step_index &&
            hasReference(
              completed,
              rawSteps.find((s) => s.step_index === c.step_index)?.request_id,
              "core:status-of",
            ) &&
            call &&
            actionDigest(call) === actionDigest(c.call);
          if (c.intent_id)
            valid =
              valid &&
              action &&
              action.input.runInformationId ===
                row.spec.actionRunInformationId &&
              action.input.toolCallId === c.call_id &&
              action.input.operationId ===
                `native:${id}:${c.step_index}:${c.call_index}:${actionDigest(c.call_id)}` &&
              action.input.toolName === declaration?.id &&
              actionDigest(action.input.arguments) ===
                actionDigest(c.call.input) &&
              action.input.dependencies.observationId ===
                row.spec.observationId &&
              action.input.dependencies.evidenceInformationId ===
                c.completed_id &&
              decision?.kind === "agent.action.decision.v1" &&
              decision.payload.observationId === row.spec.observationId &&
              decision.payload.domain === "tool" &&
              hasReference(decision, c.completed_id, "core:uses-context") &&
              hasReference(
                decision,
                row.spec.actionRunInformationId,
                "core:uses-context",
              );
          if (result)
            valid =
              valid &&
              result.kind === "agent.heavy.tool.result.v1" &&
              p.runInformationId === id &&
              p.stepIndex === c.step_index &&
              p.toolCallId === c.call_id &&
              p.modelCompletedInformationId === c.completed_id &&
              p.intentId === c.intent_id;
          if (p.receiptId)
            valid =
              valid &&
              receipt &&
              action &&
              (await verifiedReceipt(r, receipt, action, q.scope)) &&
              hasReference(result, receipt.id, "core:uses-context") &&
              (actionDigest(p.value) ===
                actionDigest({
                  ...receipt.payload.outcome,
                  receiptId: receipt.id,
                  resultHash: receipt.payload.resultHash,
                }) ||
                actionDigest(p.value) ===
                  actionDigest({
                    status: "output-budget",
                    receiptId: receipt.id,
                    truncated: true,
                  }));
          if (result && action && !p.receiptId)
            valid = valid && action.state === "queued";
          calls.push({
            stepIndex: c.step_index,
            callIndex: c.call_index,
            toolCallId: c.call_id,
            toolId: declaration?.id ?? null,
            toolVersion: declaration?.version ?? null,
            wireName: c.call.toolName,
            validation: c.call.validation,
            arguments: d.safe(
              valid ? { rawInput: c.call.rawInput, input: c.call.input } : null,
            ),
            modelCompletedInformationId: c.completed_id,
            intent: c.intent_id
              ? {
                  domain: "action",
                  id: c.intent_id,
                  relation: "tool-intent",
                  availability: valid ? "available" : "invalid",
                }
              : null,
            resultInformationId: c.result_id,
            receipt: p.receiptId
              ? {
                  domain: "atom",
                  id: p.receiptId,
                  relation: "execution-receipt",
                  availability: valid ? "available" : "invalid",
                }
              : null,
            result: valid && result ? d.safe(p.value) : null,
            outputBytes: valid && result ? p.outputBytes : null,
            pairing: !valid ? "invalid" : result ? "verified" : "pending",
          });
        }
        return inspectionRunDetailSchema.parse({
          ...meta,
          run: await runSummary(r, row, root.at),
          budget: d.safe(row.spec.budget),
          usage: {
            admittedSteps: row.steps_count,
            registeredCalls: row.calls_count,
            projectedOutputBytes: row.output_bytes,
          },
          cancellation: await cancellation(r, row.spec.origin, row.origin_key),
          steps,
          stepsTruncated: rawSteps.length > 32,
          calls,
          callsTruncated: rawCalls.length > 128,
          references: [
            {
              domain: "observation",
              id: row.spec.observationId,
              relation: "initial-observation",
              availability: (
                await r.observations(
                  q.scope,
                  null,
                  null,
                  1,
                  row.spec.observationId,
                )
              ).length
                ? "available"
                : "missing-or-denied",
            },
            await reference(
              r,
              q.scope,
              row.spec.actionRunInformationId,
              "action-run",
            ),
          ],
        });
      }),
  };
}
