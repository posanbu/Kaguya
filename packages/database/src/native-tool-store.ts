/**
 * cancelOrigin 与 open/admission 共锁，持久取消未创建 run 的来源；admitModel 同时核对四项原点和冻结模型配置。
 * cancellationForwarded 与停止事实分开追加；转发失败保留 pending，避免任务终态掩盖未送达的取消。
 * 稳定 origin_key 仅由 activation/task/source 决定；旧记录按 requested 事实回填索引，模型 admission 校验冻结配置绑定。
 * 功能概述：在同一持久事务内裁决工具 run/step、预算、模型 dispatch 和 call→intent 身份。
 * open/freeze 固定不可变上下文，admitModel 在有效 claim 下扣一次步骤预算，calls 固定模型调用顺序。
 * bind 与 W3 register 共用 7149321 锁，stop 阻止后续 admission；结果事实保留实际 receipt，不重执行。
 * registerCalls 对新增与恢复的整批调用核对原生消息、参数、行动身份和结果证明，全部通过后才返回可推进记录。
 * auditCall 检查历史结果指针及回执投影；intents 仅返回属于本 run/call 的行动，避免异常指针取消其他行动。
 * Runtime 协调器调用本仓储；模型没有 SQL 或授权入口。所有状态均追加事实并保留原始依据。
 */
import { randomUUID } from "node:crypto";
import {
  freezeInformationAtom,
  nativeMemorySnapshotSchema,
  informationAtomSchema,
  type NativeToolCall,
  type JsonObject,
  type z,
} from "@kaguya/schema";
import {
  actionIntentSchema,
  nativeToolBudgetSchema,
  nativeToolStepSchema,
  type ActionIntent,
} from "@kaguya/sdk";
import type { InformationClaim } from "@kaguya/engine";
import { assertClaimInTransaction } from "./reliable-repository.js";
import { appendInformationAtom } from "./information-repository.js";
import { PostgresActionStore, actionDigest } from "./action-store.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

export interface NativeToolRunRow {
  run_id: string;
  run_key: string;
  origin_key: string | null;
  spec: JsonObject;
  context_id: string;
  stopped_id: string | null;
  steps_count: number;
  calls_count: number;
  output_bytes: number;
}
export interface NativeToolOrigin {
  instanceId: string;
  definitionId: string;
  taskId: string;
  sourceInformationId: string;
}
export interface NativeToolCallRow {
  run_id: string;
  step_index: number;
  call_index: number;
  call_id: string;
  completed_id: string;
  call: NativeToolCall;
  intent_id: string | null;
  result_id: string | null;
}
export async function prepareNativeToolSchema(db: SqlDatabase) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(7149321)");
    await tx.exec(`CREATE TABLE IF NOT EXISTS information_native_tool_runs (
      run_id text PRIMARY KEY REFERENCES information_atoms(information_id), run_key text UNIQUE NOT NULL,
      spec jsonb NOT NULL,context_id text NOT NULL REFERENCES information_atoms(information_id),
      stopped_id text REFERENCES information_atoms(information_id),steps_count integer NOT NULL DEFAULT 0,
      calls_count integer NOT NULL DEFAULT 0,output_bytes integer NOT NULL DEFAULT 0);
    ALTER TABLE information_native_tool_runs ADD COLUMN IF NOT EXISTS origin_key text;
    CREATE UNIQUE INDEX IF NOT EXISTS information_native_tool_origin ON information_native_tool_runs(origin_key);
    CREATE INDEX IF NOT EXISTS information_native_origin_cancelled ON information_atoms((payload->>'originKey'))
      WHERE kind='agent.heavy.tool.origin.cancelled.v1';
    CREATE TABLE IF NOT EXISTS information_native_tool_steps (
      run_id text NOT NULL REFERENCES information_native_tool_runs(run_id), step_index integer NOT NULL,
      frozen_id text NOT NULL REFERENCES information_atoms(information_id), request_id text,
      dispatched_id text REFERENCES information_atoms(information_id), PRIMARY KEY(run_id,step_index));
    CREATE TABLE IF NOT EXISTS information_native_tool_calls (
      run_id text NOT NULL,step_index integer NOT NULL,call_index integer NOT NULL,call_id text NOT NULL,
      completed_id text NOT NULL REFERENCES information_atoms(information_id),call jsonb NOT NULL,
      intent_id text REFERENCES information_action_heads(intent_id),result_id text REFERENCES information_atoms(information_id),
      PRIMARY KEY(run_id,step_index,call_index),UNIQUE(run_id,step_index,call_id),
      FOREIGN KEY(run_id,step_index) REFERENCES information_native_tool_steps(run_id,step_index));`);
  });
}
export class PostgresNativeToolStore {
  constructor(private readonly db: SqlDatabase) {}
  private tx<T>(fn: (tx: SqlTransaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      return fn(tx);
    });
  }
  private async fact(
    tx: SqlTransaction,
    kind: string,
    payload: unknown,
    context: string,
    refs: string[],
  ) {
    await tx.query(
      "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
      [kind],
    );
    const atom = freezeInformationAtom(
      informationAtomSchema.parse({
        informationId: randomUUID(),
        kind,
        source: "runtime:native-tools",
        occurredAt: new Date().toISOString(),
        payload,
        references:
          kind === "core.model.task.dispatched.v1"
            ? [{ relation: "core:caused-by", informationId: refs[0] }]
            : [
                { relation: "core:context", informationId: context },
                ...[...new Set(refs)].map((informationId) => ({
                  relation: "core:uses-context",
                  informationId,
                })),
              ],
      }),
    );
    await appendInformationAtom(
      tx,
      atom,
      kind === "core.model.task.dispatched.v1"
        ? [{ relation: "core:caused-by", required: true, multiple: false }]
        : [
            { relation: "core:context", required: true, multiple: false },
            { relation: "core:uses-context", required: true, multiple: true },
          ],
    );
    return atom;
  }
  private async row(tx: SqlTransaction, id: string) {
    const row = (
      await tx.query<NativeToolRunRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_runs WHERE run_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row) throw new Error("native-run-missing");
    return row;
  }
  private async active(
    tx: SqlTransaction,
    row: NativeToolRunRow,
    guard?: InformationClaim,
  ) {
    if (guard) await assertClaimInTransaction(tx, guard);
    const action = (
      await tx.query<{ invalidated_id: string | null }>(
        "SELECT invalidated_id FROM information_action_runs WHERE run_id=$1",
        [String(row.spec.actionRunInformationId)],
      )
    ).rows[0];
    if (
      row.stopped_id ||
      (row.origin_key && (await this.originCancelled(tx, row.origin_key))) ||
      action?.invalidated_id ||
      Date.parse(String(row.spec.deadline)) <= Date.now()
    )
      throw new Error("native-run-stopped");
  }
  private async originCancelled(tx: SqlTransaction, originKey: string) {
    return (
      await tx.query<{ information_id: string }>(
        "SELECT information_id FROM information_atoms WHERE kind='agent.heavy.tool.origin.cancelled.v1' AND payload->>'originKey'=$1 LIMIT 1",
        [originKey],
      )
    ).rows[0]?.information_id;
  }
  /** 与 open/admission 共用锁；先取消再开 run 也不会派发。停止事实不表示外部效果回滚。 */
  async cancelOrigin(origin: NativeToolOrigin, context: string) {
    return this.tx(async (tx) => {
      const row = await this.findOrigin(tx, origin);
      if (row?.stopped_id) return row;
      const originKey = actionDigest(origin);
      let cancelled = await this.originCancelled(tx, originKey);
      if (!cancelled)
        cancelled = (
          await this.fact(
            tx,
            "agent.heavy.tool.origin.cancelled.v1",
            { originKey },
            context,
            [origin.sourceInformationId],
          )
        ).informationId;
      if (row) {
        const terminal = await this.fact(
          tx,
          "agent.heavy.tool.terminal.v1",
          {
            runInformationId: row.run_id,
            reason: "cancelled",
            modelResult: null,
          },
          context,
          [row.run_id, cancelled],
        );
        await tx.query(
          "UPDATE information_native_tool_runs SET stopped_id=$2 WHERE run_id=$1",
          [row.run_id, terminal.informationId],
        );
        return { ...row, stopped_id: terminal.informationId };
      }
      return undefined;
    });
  }
  async cancellation(origin: NativeToolOrigin) {
    const key = actionDigest(origin);
    const rows = (
      await this.db.query<{ kind: string; information_id: string }>(
        "SELECT kind,information_id FROM information_atoms WHERE kind IN ('agent.heavy.tool.origin.cancelled.v1','agent.heavy.tool.cancel.forwarded.v1') AND payload->>'originKey'=$1",
        [key],
      )
    ).rows;
    const pending = rows.find(
      (r) => r.kind === "agent.heavy.tool.origin.cancelled.v1",
    );
    return pending
      ? {
          state: rows.some(
            (r) => r.kind === "agent.heavy.tool.cancel.forwarded.v1",
          )
            ? ("forwarded" as const)
            : ("pending" as const),
          requestedInformationId: pending.information_id,
        }
      : null;
  }
  async cancellationForwarded(
    origin: NativeToolOrigin,
    context: string,
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      if (guard) await assertClaimInTransaction(tx, guard);
      const key = actionDigest(origin);
      const pending = await this.originCancelled(tx, key);
      if (!pending) throw new Error("native-cancellation-missing");
      const done = (
        await tx.query(
          "SELECT information_id FROM information_atoms WHERE kind='agent.heavy.tool.cancel.forwarded.v1' AND payload->>'originKey'=$1",
          [key],
        )
      ).rows[0];
      if (!done)
        await this.fact(
          tx,
          "agent.heavy.tool.cancel.forwarded.v1",
          { originKey: key },
          context,
          [pending, origin.sourceInformationId],
        );
    });
  }
  async open(
    key: string,
    spec: JsonObject,
    context: string,
    refs: string[],
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const origin = spec.origin as unknown as NativeToolOrigin | undefined;
      const prior = origin ? await this.findOrigin(tx, origin) : undefined;
      if (prior) return prior;
      const old = (
        await tx.query<NativeToolRunRow & Record<string, unknown>>(
          "SELECT * FROM information_native_tool_runs WHERE run_key=$1",
          [key],
        )
      ).rows[0];
      if (old) return old;
      if (guard) await assertClaimInTransaction(tx, guard);
      if (origin && (await this.originCancelled(tx, actionDigest(origin))))
        throw new Error("native-run-stopped");
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.run.v1",
        { key, spec },
        context,
        refs,
      );
      await tx.query(
        "INSERT INTO information_native_tool_runs(run_id,run_key,spec,context_id,origin_key) VALUES($1,$2,$3::jsonb,$4,$5)",
        [
          atom.informationId,
          key,
          JSON.stringify(spec),
          context,
          origin ? actionDigest(origin) : null,
        ],
      );
      return this.row(tx, atom.informationId);
    });
  }
  /** 原点不包含路由。旧 run 仅按真实 requested 事实反查，不修改不可变 run key/spec。 */
  private async findOrigin(tx: SqlTransaction, origin: NativeToolOrigin) {
    const key = actionDigest(origin);
    const current = (
      await tx.query<NativeToolRunRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_runs WHERE origin_key=$1",
        [key],
      )
    ).rows[0];
    if (current) return current;
    const candidates = (
      await tx.query<NativeToolRunRow & Record<string, unknown>>(
        `SELECT n.* FROM information_native_tool_runs n WHERE n.origin_key IS NULL AND EXISTS (
        SELECT 1 FROM information_references r WHERE r.information_id=n.run_id
        AND r.relation='core:uses-context' AND r.target_information_id=$1)`,
        [origin.sourceInformationId],
      )
    ).rows;
    const matches: NativeToolRunRow[] = [];
    for (const candidate of candidates) {
      const facts = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE kind='core.model.task.requested' AND payload->'nativeStep'->>'runInformationId'=$1",
          [candidate.run_id],
        )
      ).rows;
      if (!facts.length) throw new Error("native-origin-proof-missing");
      const origins = new Set(
        facts.map(({ payload: p }) =>
          actionDigest({
            instanceId: p.activation?.instanceId,
            definitionId: p.activation?.definitionId,
            taskId: p.taskId,
            sourceInformationId: p.sourceInformationId,
          }),
        ),
      );
      if (origins.size !== 1) throw new Error("native-origin-proof-ambiguous");
      if (origins.has(key)) matches.push(candidate);
    }
    if (matches.length > 1) throw new Error("native-origin-proof-ambiguous");
    const match = matches[0];
    if (match) {
      await tx.query(
        "UPDATE information_native_tool_runs SET origin_key=$2 WHERE run_id=$1",
        [match.run_id, key],
      );
      return { ...match, origin_key: key };
    }
    return undefined;
  }
  async byOrigin(origin: NativeToolOrigin) {
    return this.tx((tx) => this.findOrigin(tx, origin));
  }
  async read(id: string) {
    return this.tx((tx) => this.row(tx, id));
  }
  async byKey(key: string) {
    return (
      await this.db.query<NativeToolRunRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_runs WHERE run_key=$1",
        [key],
      )
    ).rows[0];
  }
  async step(
    runInformationId: string,
    index: number,
    db: SqlTransaction = this.db,
  ) {
    const row = (
      await db.query<{
        information_id: string;
        payload: z.infer<typeof nativeToolStepSchema>;
      }>(
        "SELECT a.information_id,a.payload FROM information_native_tool_steps s JOIN information_atoms a ON a.information_id=s.frozen_id WHERE run_id=$1 AND step_index=$2",
        [runInformationId, index],
      )
    ).rows[0];
    return row
      ? { ...row, payload: nativeToolStepSchema.parse(row.payload) }
      : undefined;
  }
  async freeze(
    raw: z.infer<typeof nativeToolStepSchema>,
    guard?: InformationClaim,
  ) {
    const p = nativeToolStepSchema.parse(raw);
    return this.tx(async (tx) => {
      const row = await this.row(tx, p.runInformationId);
      const old = await this.step(p.runInformationId, p.stepIndex, tx);
      if (old) return old;
      await this.active(tx, row, guard);
      if (p.observationId !== row.spec.observationId)
        throw new Error("native-step-observation-mismatch");
      if (
        p.stepIndex === 0 &&
        (p.previousStepInformationId ||
          p.modelCompletedInformationId ||
          p.receiptIds.length ||
          p.supplements.length ||
          actionDigest(p.memory) !== actionDigest(row.spec.memory))
      )
        throw new Error("native-step-memory-mismatch");
      if (p.stepIndex > 0) {
        const previous = (
          await tx.query<{ frozen_id: string }>(
            "SELECT frozen_id FROM information_native_tool_steps WHERE run_id=$1 AND step_index=$2",
            [row.run_id, p.stepIndex - 1],
          )
        ).rows[0];
        const calls = (
          await tx.query<NativeToolCallRow & Record<string, unknown>>(
            "SELECT * FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 ORDER BY call_index",
            [row.run_id, p.stepIndex - 1],
          )
        ).rows;
        if (
          !previous ||
          previous.frozen_id !== p.previousStepInformationId ||
          !calls.length ||
          calls.some(
            (c) =>
              !c.result_id || c.completed_id !== p.modelCompletedInformationId,
          )
        )
          throw new Error("native-step-unpaired");
        const resultIds = calls.map((c) => c.result_id!);
        const receipts = (
          await tx.query<{ receipt_id: string }>(
            "SELECT payload->>'receiptId' receipt_id FROM information_atoms WHERE information_id=ANY($1::text[]) AND payload->>'receiptId' IS NOT NULL",
            [resultIds],
          )
        ).rows.map((r) => r.receipt_id);
        if (
          actionDigest([...receipts].sort()) !==
          actionDigest([...p.receiptIds].sort())
        )
          throw new Error("native-step-receipt-mismatch");
        const memoryResults = (
          await tx.query<{ value: any }>(
            `SELECT a.payload->'value' value FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id JOIN information_action_heads h ON h.intent_id=c.intent_id WHERE c.run_id=$1 AND c.step_index=$2 AND h.input->>'providerId'='core.native-memory' ORDER BY c.call_index`,
            [row.run_id, p.stepIndex - 1],
          )
        ).rows;
        const supplements = memoryResults.flatMap((r) => [
          ...(r.value?.result?.memorySnapshot
            ? [nativeMemorySnapshotSchema.parse(r.value.result.memorySnapshot)]
            : []),
          ...(r.value?.result?.memorySnapshots
            ? r.value.result.memorySnapshots.map((s: unknown) =>
                nativeMemorySnapshotSchema.parse(s),
              )
            : []),
        ]);
        const prior = (await this.step(row.run_id, p.stepIndex - 1, tx))!
          .payload.memory;
        const latest = supplements.at(-1);
        const memory =
          latest &&
          (!prior ||
            BigInt(latest.cutoff?.publicationPosition ?? "0") >=
              BigInt(prior.cutoff?.publicationPosition ?? "0"))
            ? latest
            : prior;
        if (
          actionDigest(p.supplements) !== actionDigest(supplements) ||
          actionDigest(p.memory) !== actionDigest(memory)
        )
          throw new Error("native-step-memory-mismatch");
      }
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.step.frozen.v1",
        p,
        row.context_id,
        [
          row.run_id,
          ...p.receiptIds,
          ...(p.previousStepInformationId ? [p.previousStepInformationId] : []),
          ...(p.modelCompletedInformationId
            ? [p.modelCompletedInformationId]
            : []),
        ],
      );
      await tx.query(
        "INSERT INTO information_native_tool_steps(run_id,step_index,frozen_id) VALUES($1,$2,$3)",
        [row.run_id, p.stepIndex, atom.informationId],
      );
      return { information_id: atom.informationId, payload: p };
    });
  }
  async admitModel(
    runInformationId: string,
    index: number,
    requestId: string,
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, runInformationId);
      await this.active(tx, row, guard);
      const step = (
        await tx.query<{
          dispatched_id: string | null;
          request_id: string | null;
        }>(
          "SELECT dispatched_id,request_id FROM information_native_tool_steps WHERE run_id=$1 AND step_index=$2 FOR UPDATE",
          [runInformationId, index],
        )
      ).rows[0];
      if (!step) throw new Error("native-step-missing");
      if (step.dispatched_id) return false;
      const request = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.model.task.requested'",
          [requestId],
        )
      ).rows[0];
      if (
        !request ||
        request.payload.nativeStep?.runInformationId !== runInformationId ||
        request.payload.nativeStep?.stepIndex !== index ||
        actionDigest(request.payload.tools) !==
          actionDigest(row.spec.declarations)
      )
        throw new Error("native-request-unproved");
      const requestedOrigin: NativeToolOrigin = {
        instanceId: request.payload.activation?.instanceId,
        definitionId: request.payload.activation?.definitionId,
        taskId: request.payload.taskId,
        sourceInformationId: request.payload.sourceInformationId,
      };
      if (
        !row.spec.origin ||
        actionDigest(requestedOrigin) !== row.origin_key ||
        actionDigest(requestedOrigin) !== actionDigest(row.spec.origin)
      )
        throw new Error("native-request-origin-mismatch");
      const binding = row.spec.modelBinding as any;
      if (
        !binding ||
        !binding.resolvedModel?.configurationDigest ||
        actionDigest(request.payload.nativeModelBinding) !==
          actionDigest(binding) ||
        actionDigest(request.payload.selectionPolicy) !==
          actionDigest(binding.selectionPolicy) ||
        actionDigest(request.payload.resolvedModel) !==
          actionDigest(binding.resolvedModel)
      )
        throw new Error("native-model-binding-unproved");
      const budget = nativeToolBudgetSchema.parse(row.spec.budget);
      if (row.steps_count >= budget.maxSteps)
        throw new Error("native-step-budget");
      const atom = await this.fact(
        tx,
        "core.model.task.dispatched.v1",
        { requestedInformationId: requestId, nonce: randomUUID() },
        row.context_id,
        [requestId],
      );
      await tx.query(
        "UPDATE information_native_tool_steps SET dispatched_id=$3,request_id=$4 WHERE run_id=$1 AND step_index=$2",
        [runInformationId, index, atom.informationId, requestId],
      );
      await tx.query(
        "UPDATE information_native_tool_runs SET steps_count=steps_count+1 WHERE run_id=$1",
        [runInformationId],
      );
      await this.active(tx, row, guard);
      return true;
    });
  }
  async calls(
    runInformationId: string,
    index: number,
    db: SqlTransaction = this.db,
  ) {
    return (
      await db.query<NativeToolCallRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 ORDER BY call_index",
        [runInformationId, index],
      )
    ).rows;
  }
  async registerCalls(
    runInformationId: string,
    index: number,
    completedId: string,
    calls: NativeToolCall[],
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, runInformationId);
      const old = await this.calls(runInformationId, index, tx);
      await this.active(tx, row, guard);
      const completed = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.model.task.completed'",
          [completedId],
        )
      ).rows[0];
      const request = (
        await tx.query<{ request_id: string }>(
          "SELECT request_id FROM information_native_tool_steps WHERE run_id=$1 AND step_index=$2 AND dispatched_id IS NOT NULL",
          [runInformationId, index],
        )
      ).rows[0];
      const caused = (
        await tx.query(
          "SELECT 1 FROM information_references WHERE information_id=$1 AND target_information_id=$2 AND relation='core:status-of'",
          [completedId, request?.request_id],
        )
      ).rowCount;
      if (
        !caused ||
        !completed ||
        completed.payload.nativeStep?.runInformationId !== runInformationId ||
        completed.payload.nativeStep?.stepIndex !== index ||
        completed.payload.generationKind !== "tool-calls" ||
        actionDigest(completed.payload.toolCalls) !== actionDigest(calls)
      )
        throw new Error("native-calls-unproved");
      if (
        !calls.length ||
        new Set(calls.map((c) => c.toolCallId)).size !== calls.length
      )
        throw new Error("native-call-id-conflict");
      const messages = completed.payload.native?.messages;
      if (
        !Array.isArray(messages) ||
        messages.some(
          (m: any) =>
            m.role !== "assistant" ||
            m.nativeToolResultGroup !== undefined ||
            (Array.isArray(m.content) &&
              m.content.some((part: any) => part?.type === "tool-result")),
        )
      )
        throw new Error("native-calls-message-mismatch");
      const nativeCalls = messages.flatMap((m: any) =>
        Array.isArray(m.content)
          ? m.content.filter((part: any) => part?.type === "tool-call")
          : [],
      );
      if (
        nativeCalls.length !== calls.length ||
        nativeCalls.some(
          (part: any, i: number) =>
            part.toolCallId !== calls[i]!.toolCallId ||
            part.toolName !== calls[i]!.toolName,
        )
      )
        throw new Error("native-calls-message-mismatch");
      for (const [i, call] of calls.entries()) {
        if (call.validation !== "valid") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.rawInput);
        } catch {
          throw new Error("native-call-input-mismatch");
        }
        if (
          nativeCalls[i].input === undefined ||
          actionDigest(parsed) !== actionDigest(call.input) ||
          actionDigest(nativeCalls[i].input) !== actionDigest(call.input) ||
          (nativeCalls[i].rawInput !== undefined &&
            nativeCalls[i].rawInput !== call.rawInput)
        )
          throw new Error("native-call-input-mismatch");
      }
      if (old.length) {
        if (
          old.length !== calls.length ||
          old.some(
            (c, i) =>
              c.call_index !== i ||
              c.call_id !== calls[i]!.toolCallId ||
              c.completed_id !== completedId,
          ) ||
          actionDigest(old.map((c) => c.call)) !== actionDigest(calls)
        )
          throw new Error("native-calls-conflict");
        // 整批先审计，再让 Runtime 执行其中任何未完成行动。
        for (const call of old) await this.auditCall(tx, row, call);
        return old;
      }
      const budget = nativeToolBudgetSchema.parse(row.spec.budget);
      if (row.calls_count + calls.length > budget.maxCalls)
        throw new Error("native-call-budget");
      for (const [i, c] of calls.entries())
        await tx.query(
          "INSERT INTO information_native_tool_calls(run_id,step_index,call_index,call_id,completed_id,call) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [
            runInformationId,
            index,
            i,
            c.toolCallId,
            completedId,
            JSON.stringify(c),
          ],
        );
      await tx.query(
        "UPDATE information_native_tool_runs SET calls_count=calls_count+$2 WHERE run_id=$1",
        [runInformationId, calls.length],
      );
      return this.calls(runInformationId, index, tx);
    });
  }
  private ownsIntent(
    row: NativeToolRunRow,
    call: NativeToolCallRow,
    intent: any,
  ) {
    return Boolean(
      intent &&
      intent.operationId ===
        `native:${row.run_id}:${call.step_index}:${call.call_index}:${actionDigest(call.call_id)}` &&
      intent.runInformationId === row.spec.actionRunInformationId &&
      intent.scope === row.spec.scope &&
      intent.toolCallId === call.call_id,
    );
  }
  private async auditCall(
    tx: SqlTransaction,
    row: NativeToolRunRow,
    call: NativeToolCallRow,
  ) {
    const head = call.intent_id
      ? (
          await tx.query<{
            input: any;
            digest: string;
            state: string;
            attempt_id: string;
            started_id: string;
          }>(
            "SELECT input,digest,state,attempt_id,started_id FROM information_action_heads WHERE intent_id=$1",
            [call.intent_id],
          )
        ).rows[0]
      : undefined;
    if (
      call.intent_id &&
      (!head ||
        !actionIntentSchema.safeParse(head.input).success ||
        !this.ownsIntent(row, call, head.input) ||
        actionDigest(head.input) !== head.digest ||
        actionDigest(head.input.arguments) !== actionDigest(call.call.input) ||
        head.input.deadline !== row.spec.deadline ||
        !(row.spec.declarations as any[]).some(
          (d) =>
            d.wireName === call.call.toolName && d.id === head.input.toolName,
        ))
    )
      throw new Error("native-recovery-intent-mismatch");
    if (head) {
      const original = (
        await tx.query<{ payload: unknown }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.action.intent.v1'",
          [call.intent_id],
        )
      ).rows[0];
      if (!original || actionDigest(original.payload) !== head.digest)
        throw new Error("native-recovery-intent-mismatch");
    }
    if (!call.result_id) return;
    const result = (
      await tx.query<{ kind: string; payload: any }>(
        "SELECT kind,payload FROM information_atoms WHERE information_id=$1",
        [call.result_id],
      )
    ).rows[0];
    const p = result?.payload;
    if (
      !p ||
      result!.kind !== "agent.heavy.tool.result.v1" ||
      p.runInformationId !== row.run_id ||
      p.stepIndex !== call.step_index ||
      p.toolCallId !== call.call_id ||
      p.modelCompletedInformationId !== call.completed_id ||
      p.intentId !== call.intent_id ||
      p.value === undefined ||
      p.outputBytes !== Buffer.byteLength(JSON.stringify(p.value))
    )
      throw new Error("native-recovery-result-mismatch");
    if (!p.receiptId) {
      const truncated =
        actionDigest(p.value) ===
        actionDigest({
          status: "output-budget",
          receiptId: null,
          truncated: true,
        });
      if (
        (head && head.state !== "queued") ||
        (!truncated &&
          (p.value?.status !== "rejected" ||
            p.value?.evidence !== "not-executed"))
      )
        throw new Error("native-recovery-result-unproved");
      return;
    }
    let r;
    try {
      // 宿主内部审计只读取既有证明，不签发新的读取/执行授权。
      r = await new PostgresActionStore(this.db).inspectReceipt(
        p.receiptId,
        String(row.spec.scope),
        tx,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("receipt-") ||
          error.message.startsWith("action-") ||
          error.name === "ZodError")
      )
        throw new Error("native-recovery-receipt-unproved", { cause: error });
      throw error;
    }
    if (
      !head ||
      r.intentId !== call.intent_id ||
      actionDigest(r.intent) !== head.digest
    )
      throw new Error("native-recovery-receipt-unproved");
    const expected =
      p.value?.status === "output-budget"
        ? { status: "output-budget", receiptId: p.receiptId, truncated: true }
        : { ...r.outcome, receiptId: p.receiptId, resultHash: r.resultHash };
    if (actionDigest(p.value) !== actionDigest(expected))
      throw new Error("native-recovery-result-unproved");
  }
  async bind(
    call: NativeToolCallRow,
    intent: ActionIntent,
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, call.run_id);
      await this.active(tx, row, guard);
      const current = (
        await tx.query<{ intent_id: string | null }>(
          "SELECT intent_id FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 AND call_index=$3 FOR UPDATE",
          [call.run_id, call.step_index, call.call_index],
        )
      ).rows[0];
      if (!current) throw new Error("native-call-missing");
      if (current.intent_id) return current.intent_id;
      if (intent.toolCallId !== call.call_id)
        throw new Error("native-call-intent-mismatch");
      const action = await new PostgresActionStore(this.db).register(
        intent,
        guard,
        tx,
      );
      await tx.query(
        "UPDATE information_native_tool_calls SET intent_id=$4 WHERE run_id=$1 AND step_index=$2 AND call_index=$3",
        [call.run_id, call.step_index, call.call_index, action.intentId],
      );
      await this.active(tx, row, guard);
      return action.intentId;
    });
  }
  async result(
    call: NativeToolCallRow,
    value: unknown,
    receiptId: string | null,
    authorizationId?: string,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, call.run_id);
      const current = (
        await tx.query<NativeToolCallRow & Record<string, unknown>>(
          "SELECT * FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 AND call_index=$3 FOR UPDATE",
          [call.run_id, call.step_index, call.call_index],
        )
      ).rows[0]!;
      if (
        !current ||
        actionDigest(current.call) !== actionDigest(call.call) ||
        current.call_id !== call.call_id ||
        current.completed_id !== call.completed_id
      )
        throw new Error("native-result-call-mismatch");
      if (current.result_id) return current.result_id;
      if (receiptId) {
        if (!authorizationId || !current.intent_id)
          throw new Error("native-result-receipt-unproved");
        const receipt = await new PostgresActionStore(this.db).readReceipt(
          receiptId,
          String(row.spec.scope),
          authorizationId,
          tx,
        );
        if (
          receipt.intentId !== current.intent_id ||
          receipt.intent.toolCallId !== current.call_id ||
          receipt.intent.runInformationId !== row.spec.actionRunInformationId
        )
          throw new Error("native-result-receipt-mismatch");
        value = {
          ...receipt.outcome,
          receiptId: receipt.receiptId,
          resultHash: receipt.resultHash,
        };
      } else if (current.intent_id) {
        const head = (
          await tx.query<{ state: string }>(
            "SELECT state FROM information_action_heads WHERE intent_id=$1",
            [current.intent_id],
          )
        ).rows[0];
        if (head?.state !== "queued")
          throw new Error("native-result-requires-receipt");
      }
      let projected = value;
      let bytes = Buffer.byteLength(JSON.stringify(value));
      const budget = nativeToolBudgetSchema.parse(row.spec.budget);
      if (
        bytes > budget.maxToolOutputBytes ||
        row.output_bytes + bytes > budget.maxTotalToolOutputBytes
      ) {
        projected = { status: "output-budget", receiptId, truncated: true };
        bytes = Buffer.byteLength(JSON.stringify(projected));
      }
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.result.v1",
        {
          runInformationId: row.run_id,
          stepIndex: call.step_index,
          toolCallId: call.call_id,
          modelCompletedInformationId: call.completed_id,
          intentId: current.intent_id,
          receiptId,
          value: projected,
          outputBytes: bytes,
        },
        row.context_id,
        [row.run_id, call.completed_id, ...(receiptId ? [receiptId] : [])],
      );
      await tx.query(
        "UPDATE information_native_tool_calls SET result_id=$4 WHERE run_id=$1 AND step_index=$2 AND call_index=$3",
        [call.run_id, call.step_index, call.call_index, atom.informationId],
      );
      await tx.query(
        "UPDATE information_native_tool_runs SET output_bytes=output_bytes+$2 WHERE run_id=$1",
        [call.run_id, bytes],
      );
      return atom.informationId;
    });
  }
  async stop(
    runInformationId: string,
    reason: string,
    modelResult: unknown = null,
    causeId?: string,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, runInformationId);
      if (row.stopped_id) return row.stopped_id;
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.terminal.v1",
        { runInformationId: runInformationId, reason, modelResult },
        row.context_id,
        [runInformationId, ...(causeId ? [causeId] : [])],
      );
      await tx.query(
        "UPDATE information_native_tool_runs SET stopped_id=$2 WHERE run_id=$1",
        [runInformationId, atom.informationId],
      );
      return atom.informationId;
    });
  }
  async requests(runInformationId: string) {
    return (
      await this.db.query<{ request_id: string }>(
        "SELECT request_id FROM information_native_tool_steps WHERE run_id=$1 AND request_id IS NOT NULL ORDER BY step_index",
        [runInformationId],
      )
    ).rows.map((r) => r.request_id);
  }
  async intents(runInformationId: string) {
    const row = await this.read(runInformationId);
    const calls = (
      await this.db.query<
        NativeToolCallRow & { input: any } & Record<string, unknown>
      >(
        "SELECT c.*,h.input FROM information_native_tool_calls c JOIN information_action_heads h ON h.intent_id=c.intent_id WHERE c.run_id=$1 ORDER BY c.step_index,c.call_index",
        [runInformationId],
      )
    ).rows;
    return calls
      .filter((c) => this.ownsIntent(row, c, c.input))
      .map((c) => c.intent_id!);
  }
}
