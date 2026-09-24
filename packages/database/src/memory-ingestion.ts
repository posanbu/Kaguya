/**
 * 功能概述：将主动记忆录入保存为可恢复任务，并把经校验的计划原子提交到现有 Memory。
 * 主要职责：submit 按 requestId 幂等排队并固定全局存储与来源类型；claim 用数据库租约恢复中断；
 * context 提供同会话原文、全局实体、待修改记录和有效断言；apply 校验引用/证据/歧义后追加来源、
 * 实体、断言和 Wiki 修订，最后写入可核对的结果。retry 复用任务和已冻结计划。
 * 代码库关系：server workflow 调用本仓储；InformationRepository 与 KnowledgeStore
 * 在同一外层事务中工作，失败回滚全部内容。范围锁保护去重与修订，租约防止迟到写入。
 * 输入输出与副作用：所有写入受版本 2 契约约束，管理提交者固定且不接收 Token；
 * 自由文本仅是数据。没有独立 persona 配置，不写模板、系统指令或工具权限。
 */
import {
  listIngestionRecords,
  readIngestionRecord,
  mutateIngestionRecord,
} from "./memory-ingestion-records.js";
import { randomUUID } from "node:crypto";
import {
  MEMORY_INGESTION_VERSION,
  USER_STATEMENT_KIND,
  USER_INPUT_KIND,
  USER_SUBJECT_KIND,
  USER_MEMORY_SCOPE_KIND,
  GLOBAL_MEMORY_SCOPE_ID,
  memoryIngestionSubmissionSchema,
  memoryIngestionPlanSchema,
  memoryIngestionJobSchema,
  userStatementPayloadSchema,
  type MemoryIngestionSubmission,
  type MemoryIngestionJob,
  type MemoryIngestionPlan,
  type MemoryIngestionResult,
  type JsonObject,
} from "@kaguya/schema";
import type { KnowledgeClaim } from "@kaguya/memory";
import { InformationRepository } from "./information-repository.js";
import { PostgresMemoryKnowledgeStore } from "./memory-knowledge.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

export class MemoryIngestionError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = "MemoryIngestionError";
  }
}
type JobRow = {
  input: MemoryIngestionSubmission;
  result: Record<string, unknown>;
  contract_version: number;
  status: MemoryIngestionJob["status"];
  created_at: Date | string;
  updated_at: Date | string;
  attempt: number;
  plan: unknown;
  lease_token: string | null;
  request_id: string;
};
type Candidate = {
  entityInformationId: string;
  label: string;
  description: string;
};
export interface MemoryIngestionContext {
  job: MemoryIngestionJob;
  history: MemoryIngestionJob[];
  candidates: Candidate[];
  claims: KnowledgeClaim[];
  targetClaim: KnowledgeClaim | null;
}
export interface ClaimedMemoryIngestion {
  job: MemoryIngestionJob;
  leaseToken: string;
  plan: unknown;
}

export class PostgresMemoryIngestionStore {
  constructor(private readonly database: SqlDatabase) {}

  records(query = "", offset = 0) {
    return listIngestionRecords(this.database, query, offset);
  }
  mutateRecord(input: unknown) {
    return mutateIngestionRecord(this.database, input);
  }

  async submit(input: unknown): Promise<MemoryIngestionJob> {
    const parsed = memoryIngestionSubmissionSchema.safeParse(input);
    if (!parsed.success) throw new MemoryIngestionError("invalid_submission");
    return this.database.transaction(async (tx) => {
      // 锁会话，禁止同一上下文跨 scope 或 sourceType，限制模型上下文总量。
      await tx.query(
        "INSERT INTO memory_ingestion_sessions(session_id,scope_id,source_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          parsed.data.sessionId,
          parsed.data.scopeInformationId,
          parsed.data.sourceType,
        ],
      );
      const session = await tx.query<{ scope_id: string; source_type: string }>(
        "SELECT scope_id,source_type FROM memory_ingestion_sessions WHERE session_id=$1 FOR UPDATE",
        [parsed.data.sessionId],
      );
      if (
        session.rows[0]?.scope_id !== parsed.data.scopeInformationId ||
        session.rows[0]?.source_type !== parsed.data.sourceType
      )
        throw new MemoryIngestionError("session_scope_conflict", 409);
      const existing = await this.readRow(tx, parsed.data.requestId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(parsed.data)) {
          // jsonb 对键排序，使用规范化比较以允许合法重放。
          if (canonical(existing.input) !== canonical(parsed.data))
            throw new MemoryIngestionError("request_id_conflict", 409);
        }
        return jobFromRow(existing);
      }
      await ensureScope(tx, parsed.data.scopeInformationId);
      if (parsed.data.targetClaimId) {
        const target = await readIngestionRecord(tx, parsed.data.targetClaimId);
        if (
          target.record.deleted ||
          target.record.sourceType !== parsed.data.sourceType
        )
          throw new MemoryIngestionError("record_changed", 409);
      }
      const size = await tx.query<{
        count: number;
        size: number;
        busy: number;
      }>(
        "SELECT COUNT(*)::int AS count,COALESCE(SUM(length(input->>'text')),0)::int AS size,COUNT(*) FILTER(WHERE status IN ('queued','processing'))::int AS busy FROM memory_ingestion_jobs WHERE session_id=$1",
        [parsed.data.sessionId],
      );
      if (size.rows[0]!.busy)
        throw new MemoryIngestionError("session_busy", 409);
      if (
        size.rows[0]!.count >= 20 ||
        size.rows[0]!.size + parsed.data.text.length > 24000
      )
        throw new MemoryIngestionError("session_full", 409);
      const rows = await tx.query<JobRow>(
        "INSERT INTO memory_ingestion_jobs(request_id,session_id,scope_id,contract_version,input) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *",
        [
          parsed.data.requestId,
          parsed.data.sessionId,
          parsed.data.scopeInformationId,
          MEMORY_INGESTION_VERSION,
          JSON.stringify(parsed.data),
        ],
      );
      return jobFromRow(rows.rows[0]!);
    });
  }

  async list(sessionId: string): Promise<MemoryIngestionJob[]> {
    const result = await this.database.query<JobRow>(
      "SELECT * FROM memory_ingestion_jobs WHERE session_id=$1 ORDER BY created_at,request_id LIMIT 20",
      [sessionId],
    );
    return result.rows.map(jobFromRow);
  }
  async get(requestId: string): Promise<MemoryIngestionJob> {
    const row = await this.readRow(this.database, requestId);
    if (!row) throw new MemoryIngestionError("job_not_found", 404);
    return jobFromRow(row);
  }
  async retry(requestId: string): Promise<MemoryIngestionJob> {
    return this.database.transaction(async (tx) => {
      const initial = await this.readRow(tx, requestId);
      if (!initial) throw new MemoryIngestionError("job_not_found", 404);
      await tx.query(
        "SELECT session_id FROM memory_ingestion_sessions WHERE session_id=$1 FOR UPDATE",
        [initial.input.sessionId],
      );
      const row = await this.readRow(tx, requestId, true);
      if (!row) throw new MemoryIngestionError("job_not_found", 404);
      if (row.contract_version !== MEMORY_INGESTION_VERSION)
        throw new MemoryIngestionError("incompatible_contract", 409);
      if (row.status === "failed") {
        const busy = await tx.query(
          "SELECT request_id FROM memory_ingestion_jobs WHERE session_id=$1 AND status IN ('queued','processing') LIMIT 1",
          [row.input.sessionId],
        );
        if (busy.rows.length)
          throw new MemoryIngestionError("session_busy", 409);
        await tx.query(
          "UPDATE memory_ingestion_jobs SET status='queued',result='{}',updated_at=clock_timestamp() WHERE request_id=$1",
          [requestId],
        );
      }
      return jobFromRow((await this.readRow(tx, requestId))!);
    });
  }
  async claim(): Promise<ClaimedMemoryIngestion | undefined> {
    return this.database.transaction(async (tx) => {
      const rows = await tx.query<JobRow>(
        "SELECT * FROM memory_ingestion_jobs WHERE status='queued' OR (status='processing' AND lease_until < clock_timestamp()) ORDER BY created_at,request_id FOR UPDATE SKIP LOCKED LIMIT 1",
      );
      const row = rows.rows[0];
      if (!row) return undefined;
      if (row.contract_version !== MEMORY_INGESTION_VERSION) {
        await tx.query(
          "UPDATE memory_ingestion_jobs SET status='failed',result=$2::jsonb,updated_at=clock_timestamp() WHERE request_id=$1",
          [
            row.request_id,
            JSON.stringify({ errorCode: "incompatible_contract" }),
          ],
        );
        return undefined;
      }
      const leaseToken = randomUUID();
      const next = await tx.query<JobRow>(
        "UPDATE memory_ingestion_jobs SET status='processing',attempt=attempt+1,lease_token=$2,lease_until=clock_timestamp()+interval '6 minutes',updated_at=clock_timestamp() WHERE request_id=$1 RETURNING *",
        [row.request_id, leaseToken],
      );
      return { job: jobFromRow(next.rows[0]!), leaseToken, plan: row.plan };
    });
  }
  async context(job: MemoryIngestionJob): Promise<MemoryIngestionContext> {
    const history = (await this.list(job.sessionId)).filter(
      (j) => j.createdAt <= job.createdAt,
    );
    const candidates = await readCandidates(
      this.database,
      job.scopeInformationId,
    );
    const cutoff = new Date().toISOString();
    const recalled = await new PostgresMemoryKnowledgeStore(
      this.database,
    ).recall({
      scopeInformationId: job.scopeInformationId,
      occurredBefore: cutoff,
      recordedBefore: cutoff,
      limit: 100,
    });
    const target = job.targetClaimId
      ? await readIngestionRecord(this.database, job.targetClaimId)
      : undefined;
    if (target?.record.deleted)
      throw new MemoryIngestionError("record_changed", 409);
    return {
      job,
      history,
      candidates,
      claims: [...recalled.claims],
      targetClaim: target?.claim ?? null,
    };
  }
  async savePlan(claim: ClaimedMemoryIngestion, input: unknown): Promise<void> {
    const parsed = memoryIngestionPlanSchema.safeParse(input);
    if (!parsed.success) throw new MemoryIngestionError("invalid_plan");
    const result = await this.database.query(
      "UPDATE memory_ingestion_jobs SET plan=$3::jsonb WHERE request_id=$1 AND lease_token=$2 AND status='processing' AND lease_until>clock_timestamp()",
      [claim.job.requestId, claim.leaseToken, JSON.stringify(parsed.data)],
    );
    if (!result.rowCount) throw new MemoryIngestionError("lease_lost", 409);
  }
  async fail(claim: ClaimedMemoryIngestion, errorCode: string): Promise<void> {
    const regenerate = [
      "invalid_plan",
      "unsupported_evidence",
      "revision_conflict",
      "foreign_entity",
      "unknown_subject",
      "duplicate_subject_key",
      "invalid_validity",
      "invalid_resolution",
    ].includes(errorCode);
    await this.database.query(
      "UPDATE memory_ingestion_jobs SET status='failed',result=$3::jsonb,plan=CASE WHEN $4 THEN NULL ELSE plan END,lease_until=NULL,updated_at=clock_timestamp() WHERE request_id=$1 AND lease_token=$2 AND status='processing'",
      [
        claim.job.requestId,
        claim.leaseToken,
        JSON.stringify({ errorCode }),
        regenerate,
      ],
    );
  }
  async apply(claim: ClaimedMemoryIngestion): Promise<MemoryIngestionJob> {
    return this.database.transaction(async (tx) => {
      const row = await this.readRow(tx, claim.job.requestId, true);
      if (
        !row ||
        row.status !== "processing" ||
        row.lease_token !== claim.leaseToken
      )
        throw new MemoryIngestionError("lease_lost", 409);
      if (row.contract_version !== MEMORY_INGESTION_VERSION)
        throw new MemoryIngestionError("incompatible_contract", 409);
      const lease = await tx.query<{ live: boolean }>(
        "SELECT lease_until > clock_timestamp() AS live FROM memory_ingestion_jobs WHERE request_id=$1",
        [row.request_id],
      );
      if (!lease.rows[0]?.live)
        throw new MemoryIngestionError("lease_lost", 409);
      const parsed = memoryIngestionPlanSchema.safeParse(row.plan);
      if (!parsed.success) throw new MemoryIngestionError("invalid_plan");
      const plan = parsed.data;
      const job = jobFromRow(row);
      const scope = await ensureScope(tx, job.scopeInformationId);
      await tx.query(
        "INSERT INTO memory_knowledge_scopes(scope_id) VALUES($1) ON CONFLICT DO NOTHING",
        [job.scopeInformationId],
      );
      await tx.query(
        "SELECT scope_id FROM memory_knowledge_scopes WHERE scope_id=$1 FOR UPDATE",
        [job.scopeInformationId],
      );
      const historyRows = await tx.query<JobRow>(
        "SELECT * FROM memory_ingestion_jobs WHERE session_id=$1 AND created_at <= $2 ORDER BY created_at,request_id LIMIT 20",
        [job.sessionId, row.created_at],
      );
      const history = historyRows.rows.map(jobFromRow);
      const candidates = await readCandidates(tx, job.scopeInformationId);
      const target = job.targetClaimId
        ? await readIngestionRecord(tx, job.targetClaimId)
        : undefined;
      if (target) {
        if (target.record.deleted)
          throw new MemoryIngestionError("record_changed", 409);
        if (
          plan.claims.length > 1 ||
          plan.claims.some((c) => c.supersedesClaimId !== job.targetClaimId)
        )
          throw new MemoryIngestionError("invalid_plan");
      }
      validateEvidence(plan, history);
      const questions = [...plan.questions];
      const ambiguities: MemoryIngestionJob["ambiguities"] = [];
      const bindings = new Map(
        history
          .flatMap((j) => j.resolutions)
          .map((r) => [normalize(r.label), r.entityInformationId]),
      );
      // 点击具体记录已经明确选中了人物，不能因全局同名候选再次询问身份。
      if (target)
        bindings.set(
          normalize(target.record.subjectLabel),
          target.record.subjectInformationId,
        );
      const resolved = new Map<
        string,
        { id: string; label: string; created: boolean }
      >();
      for (const subject of plan.subjects) {
        if (resolved.has(subject.key))
          throw new MemoryIngestionError("duplicate_subject_key");
        const matches = candidates.filter(
          (c) => normalize(c.label) === normalize(subject.label),
        );
        const explicit = bindings.get(normalize(subject.label));
        if (
          explicit &&
          !matches.some((c) => c.entityInformationId === explicit)
        )
          throw new MemoryIngestionError("invalid_resolution");
        const known = candidates.find(
          (c) => c.entityInformationId === subject.existingEntityId,
        );
        if (subject.existingEntityId && !known)
          throw new MemoryIngestionError("foreign_entity");
        if (
          !known &&
          !matches.length &&
          !history.some((j) => j.text.includes(subject.label))
        )
          throw new MemoryIngestionError("unsupported_evidence");
        if (matches.length > 1 && !explicit) {
          ambiguities.push({ label: subject.label, candidates: matches });
          questions.push(`“${subject.label}”对应多个人物，请选择身份后补充。`);
        }
        // 模型不能越过同名候选自行选择；单一精确同名自动复用。
        const id =
          explicit ??
          (matches.length === 1
            ? matches[0]!.entityInformationId
            : subject.existingEntityId) ??
          `user-subject:${job.requestId}:${subject.key}`;
        resolved.set(subject.key, {
          id,
          label: subject.label,
          created: !candidates.some((c) => c.entityInformationId === id),
        });
      }
      for (const item of plan.claims) {
        const subject = resolved.get(item.subjectKey);
        if (item.supersedesClaimId && item.supplementsClaimId)
          throw new MemoryIngestionError("revision_conflict", 409);
        if (subject?.created && item.supplementsClaimId)
          throw new MemoryIngestionError("revision_conflict", 409);
        if (!subject || subject.created || item.supersedesClaimId) continue;
        const object = item.objectSubjectKey
          ? resolved.get(item.objectSubjectKey)
          : undefined;
        const value = object
          ? `${item.value} [entity:${object.id}]`
          : item.value;
        const conflicts = await tx.query<{ value: string; claim_id: string }>(
          "SELECT c.claim_id,c.input->>'value' AS value FROM memory_knowledge_claims c WHERE c.scope_id=$1 AND c.subject_id=$2 AND c.input->>'predicate'=$3 AND c.invalidated_at IS NULL AND c.retracts_id IS NULL AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claims n WHERE n.supersedes_id=c.claim_id OR n.retracts_id=c.claim_id) LIMIT 100",
          [job.scopeInformationId, subject.id, item.predicate],
        );
        if (
          item.supplementsClaimId &&
          !conflicts.rows.some((c) => c.claim_id === item.supplementsClaimId)
        )
          throw new MemoryIngestionError("revision_conflict", 409);
        if (
          conflicts.rows.length &&
          !item.supplementsClaimId &&
          !conflicts.rows.some((c) => c.value === value)
        )
          questions.push(
            `“${subject.label}”的“${item.predicate}”已有不同内容，请说明是补充还是更正。`,
          );
      }
      if (questions.length)
        return this.finish(tx, job, "clarification", {
          questions,
          ambiguities,
          results: [],
          errorCode: null,
        });
      const adapter = transactionDatabase(tx);
      const information = new InformationRepository(adapter);
      const knowledge = new PostgresMemoryKnowledgeStore(adapter);
      const results: MemoryIngestionResult[] = [];
      const entities = [
        ...new Map([...resolved.values()].map((e) => [e.id, e])).values(),
      ];
      for (const entity of entities) {
        if (entity.created)
          await appendAtom(
            information,
            entity.id,
            USER_SUBJECT_KIND,
            job.createdAt,
            { label: entity.label, scopeInformationId: job.scopeInformationId },
            [
              {
                relation: "agent:scope",
                informationId: job.scopeInformationId,
              },
            ],
          );
        results.push({
          status: entity.created ? "new" : "linked",
          label: entity.label,
          entityInformationId: entity.id,
        });
      }
      const sourceIds = new Map<string, string>();
      for (const input of history) {
        const sourceId = `user-input:${input.requestId}`;
        sourceIds.set(input.requestId, sourceId);
        if (await information.get(sourceId)) continue;
        const payload = userStatementPayloadSchema.parse({
          requestId: input.requestId,
          sessionId: input.sessionId,
          scopeInformationId: input.scopeInformationId,
          sourceType: input.sourceType,
          submitter: "webui:management",
          text: input.text,
          scope,
        });
        await appendAtom(
          information,
          sourceId,
          USER_INPUT_KIND,
          input.createdAt,
          payload,
          [{ relation: "agent:scope", informationId: job.scopeInformationId }],
        );
      }
      for (const [index, item] of plan.claims.entries()) {
        const subject = resolved.get(item.subjectKey);
        const object = item.objectSubjectKey
          ? resolved.get(item.objectSubjectKey)
          : undefined;
        if (!subject || (item.objectSubjectKey && !object))
          throw new MemoryIngestionError("unknown_subject");
        const evidence = history.filter((j) =>
          j.text.includes(item.evidenceQuote),
        );
        const value = object
          ? `${item.value} [entity:${object.id}]`
          : item.value;
        // 删除与 AI 计划提交共用 scope 锁。旧原文不能在删除后重新生成同一条记忆；
        // 用户删除后发送的新指令仍可明确重新录入。
        const sourceInput = evidence.at(-1)!;
        const deleted = await tx.query(
          `SELECT d.claim_id FROM memory_knowledge_claims d
           JOIN memory_knowledge_claims old ON old.claim_id=d.retracts_id
           WHERE d.scope_id=$1 AND d.subject_id=$2
             AND old.input->>'predicate'=$3 AND old.input->>'value'=$4
             AND d.recorded_at >= $5::timestamptz LIMIT 1`,
          [
            job.scopeInformationId,
            subject.id,
            item.predicate,
            value,
            sourceInput.createdAt,
          ],
        );
        if (deleted.rows.length)
          throw new MemoryIngestionError("record_changed", 409);
        const existingRows = await tx.query<{ input: KnowledgeClaim }>(
          "SELECT c.input FROM memory_knowledge_claims c WHERE scope_id=$1 AND subject_id=$2 AND c.invalidated_at IS NULL AND c.retracts_id IS NULL AND c.input->>'predicate'=$3 AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claims n WHERE n.supersedes_id=c.claim_id OR n.retracts_id=c.claim_id) ORDER BY recorded_at DESC LIMIT 100",
          [job.scopeInformationId, subject.id, item.predicate],
        );
        const existing = existingRows.rows.map((r) => r.input);
        if (item.supersedesClaimId) {
          const old = existing.find(
            (c) => c.claimId === item.supersedesClaimId,
          );
          if (!old || old.speakerInformationId !== undefined)
            throw new MemoryIngestionError("revision_conflict", 409);
          const sources = await tx.query<{ source_kind: string }>(
            "SELECT source_kind FROM memory_knowledge_events WHERE source_id=ANY($1::text[])",
            [old.evidenceSourceInformationIds],
          );
          if (sources.rows.some((s) => s.source_kind !== USER_STATEMENT_KIND))
            throw new MemoryIngestionError("revision_conflict", 409);
        }
        const duplicate = existing.find(
          (c) =>
            c.value === value &&
            c.epistemic === item.epistemic &&
            (item.validTo ?? undefined) === c.validTo &&
            (!item.validFrom || c.validFrom === item.validFrom),
        );
        if (
          duplicate &&
          (!item.supersedesClaimId ||
            duplicate.claimId === item.supersedesClaimId)
        ) {
          results.push({
            status: "linked",
            label: `${subject.label} · ${item.predicate}：${item.value}`,
            entityInformationId: subject.id,
            claimId: duplicate.claimId,
            sourceInformationId: sourceIds.get(job.requestId)!,
          });
          continue;
        }
        const claimId = `user-claim:${job.requestId}:${index}`;
        const sourceId = `user-statement:${job.requestId}:${index}`;
        const originalSourceInformationId = sourceIds.get(
          sourceInput.requestId,
        )!;
        const payload = userStatementPayloadSchema.parse({
          requestId: sourceInput.requestId,
          sessionId: sourceInput.sessionId,
          scopeInformationId: job.scopeInformationId,
          sourceType: sourceInput.sourceType,
          submitter: "webui:management",
          text: item.evidenceQuote,
          originalSourceInformationId,
          scope,
        });
        await appendAtom(
          information,
          sourceId,
          USER_STATEMENT_KIND,
          sourceInput.createdAt,
          payload,
          [
            { relation: "agent:scope", informationId: job.scopeInformationId },
            {
              relation: "agent:source",
              informationId: originalSourceInformationId,
            },
          ],
        );
        await knowledge.putEvent({
          sourceInformationId: sourceId,
          scopeInformationId: job.scopeInformationId,
          occurredAt: sourceInput.createdAt,
          content: item.evidenceQuote,
          eventType: sourceInput.sourceType,
          actor: { status: "unresolved", label: "WebUI 管理者" },
          subjects: [subject, ...(object ? [object] : [])].map((e) => ({
            status: "resolved",
            entityInformationId: e.id,
          })),
        });
        await knowledge.appendClaim({
          claimId,
          scopeInformationId: job.scopeInformationId,
          subjectInformationId: subject.id,
          predicate: item.predicate,
          value,
          epistemic: item.epistemic,
          validFrom: item.validFrom ?? job.createdAt,
          ...(item.validTo ? { validTo: item.validTo } : {}),
          evidenceSourceInformationIds: [sourceId],
          ...(item.supersedesClaimId
            ? { supersedesClaimId: item.supersedesClaimId }
            : {}),
        });
        results.push({
          status: item.supersedesClaimId ? "revised" : "new",
          label: `${subject.label} · ${item.predicate}：${item.value}`,
          entityInformationId: subject.id,
          claimId,
          sourceInformationId: originalSourceInformationId,
          ...(item.supersedesClaimId
            ? { supersedesClaimId: item.supersedesClaimId }
            : {}),
        });
      }
      for (const label of plan.unprocessed)
        results.push({ status: "unprocessed", label });
      if (!plan.claims.length && !plan.unprocessed.length)
        results.push({
          status: "unprocessed",
          label: "未识别到可入库的记忆，请补充人物与具体内容。",
        });
      // 复用 Wiki CAS，事务内提交当前有效断言，避免已成功任务留下旧派生页面。
      const cutoff = new Date().toISOString();
      for (const entity of entities) {
        const page = await knowledge.readWikiPage({
          scopeInformationId: job.scopeInformationId,
          entityInformationId: entity.id,
        });
        if (!page) continue;
        const memory = await knowledge.recall({
          scopeInformationId: job.scopeInformationId,
          entityInformationId: entity.id,
          occurredBefore: cutoff,
          recordedBefore: cutoff,
          limit: 100,
        });
        const sections = memory.claims.slice(0, 16).map((c) => ({
          heading: c.predicate,
          content: `[${c.epistemic}] ${c.value}`,
          evidenceSourceInformationIds: c.evidenceSourceInformationIds,
          claimIds: [c.claimId],
        }));
        await knowledge.writeWikiRevision({
          operationId: `ingestion:${job.requestId}:${entity.id}`,
          scopeInformationId: job.scopeInformationId,
          entityInformationId: entity.id,
          expectedVersion: page.version,
          expectedDirtyVersion: page.dirtyVersion,
          evidenceCutoff: { occurredBefore: cutoff, recordedBefore: cutoff },
          generatorVersion: "user-ingestion-v2",
          sections,
        });
      }
      return this.finish(
        tx,
        job,
        results.some((r) => r.status === "unprocessed")
          ? "partial"
          : "succeeded",
        { questions: [], ambiguities: [], results, errorCode: null },
      );
    });
  }
  private async finish(
    tx: SqlTransaction,
    job: MemoryIngestionJob,
    status: MemoryIngestionJob["status"],
    result: Record<string, unknown>,
  ) {
    const rows = await tx.query<JobRow>(
      "UPDATE memory_ingestion_jobs SET status=$2,result=$3::jsonb,lease_until=NULL,updated_at=clock_timestamp() WHERE request_id=$1 RETURNING *",
      [job.requestId, status, JSON.stringify(result)],
    );
    return jobFromRow(rows.rows[0]!);
  }
  private async readRow(tx: SqlTransaction, id: string, lock = false) {
    const result = await tx.query<JobRow>(
      `SELECT * FROM memory_ingestion_jobs WHERE request_id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
    return result.rows[0];
  }
}

function jobFromRow(row: JobRow): MemoryIngestionJob {
  return memoryIngestionJobSchema.parse({
    ...row.input,
    contractVersion: row.contract_version,
    submitter: "webui:management",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    status: row.status,
    attempt: row.attempt,
    questions: [],
    ambiguities: [],
    results: [],
    errorCode: null,
    ...row.result,
  });
}
function normalize(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function transactionDatabase(tx: SqlTransaction): SqlDatabase {
  return {
    query: tx.query.bind(tx),
    exec: tx.exec.bind(tx),
    transaction: (operation) => operation(tx),
    close: async () => {},
  };
}
async function appendAtom(
  repository: InformationRepository,
  id: string,
  kind: string,
  occurredAt: string,
  payload: JsonObject,
  references: { relation: string; informationId: string }[],
) {
  await repository.append(
    {
      informationId: id,
      kind,
      occurredAt,
      source: "webui:memory-ingestion",
      payload,
      references,
    },
    references.map((r) => ({
      relation: r.relation,
      required: true,
      multiple: true,
    })),
  );
}
async function ensureScope(tx: SqlTransaction, scopeId: string) {
  if (scopeId === GLOBAL_MEMORY_SCOPE_ID) {
    const repository = new InformationRepository(transactionDatabase(tx));
    // 并发首次创建由全局会话初始化锁序列化，避免 duplicate atom 异常破坏事务。
    await tx.query(
      "SELECT id FROM memory_ingestion_locks WHERE id='web-scope' FOR UPDATE",
    );
    if (!(await repository.get(scopeId)))
      await appendAtom(
        repository,
        scopeId,
        USER_MEMORY_SCOPE_KIND,
        new Date().toISOString(),
        {
          platform: "web",
          adapterId: "web.ui.main",
          destination: { kind: "web" },
        },
        [],
      );
    return {
      platform: "web",
      adapterId: "web.ui.main",
      destination: { kind: "web" as const },
    };
  }
  throw new MemoryIngestionError("invalid_scope");
}
async function readCandidates(
  tx: SqlTransaction,
  scopeId: string,
): Promise<Candidate[]> {
  const rows = await tx.query<{
    information_id: string;
    label: string;
    description: string;
  }>(
    `
    SELECT a.information_id,COALESCE(a.payload->>'label',
      (SELECT o.payload->>'nickname' FROM information_atoms o
        JOIN information_references observed ON observed.information_id=o.information_id AND observed.relation='core:observes'
        JOIN information_references bound ON bound.target_information_id=observed.target_information_id AND bound.relation='core:binds'
        JOIN information_atoms binding ON binding.information_id=bound.information_id
        WHERE o.kind='memory.identity.person.observed' AND binding.kind='memory.identity.platform.account.binding' AND binding.payload->>'personInformationId'=a.information_id
        ORDER BY o.occurred_at DESC LIMIT 1),a.payload->>'accountId',a.information_id) AS label,
      COALESCE(a.payload->>'accountId','用户录入的主体') AS description
    FROM information_atoms a WHERE a.kind IN ('agent.user.subject.entity','memory.identity.person.entity') AND (
      EXISTS(SELECT 1 FROM information_references r WHERE r.information_id=a.information_id AND r.relation='agent:scope' AND r.target_information_id=$1)
      OR EXISTS(SELECT 1 FROM memory_knowledge_event_entities p JOIN memory_knowledge_events e ON e.source_id=p.source_id WHERE p.entity_id=a.information_id AND e.scope_id=$1 AND e.revoked_at IS NULL))
    ORDER BY a.information_id LIMIT 201`,
    [scopeId],
  );
  if (rows.rows.length > 200) throw new MemoryIngestionError("scope_too_large");
  return rows.rows.map((r) => ({
    entityInformationId: r.information_id,
    label: r.label,
    description: r.description,
  }));
}
function validateEvidence(
  plan: MemoryIngestionPlan,
  history: MemoryIngestionJob[],
) {
  for (const item of [...plan.subjects, ...plan.claims]) {
    if (!history.some((j) => j.text.includes(item.evidenceQuote)))
      throw new MemoryIngestionError("unsupported_evidence");
  }
  for (const claim of plan.claims) {
    if (
      claim.validFrom &&
      claim.validTo &&
      Date.parse(claim.validFrom) > Date.parse(claim.validTo)
    )
      throw new MemoryIngestionError("invalid_validity");
  }
}
