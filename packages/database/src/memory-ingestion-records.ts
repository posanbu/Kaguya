/**
 * 功能概述：列出与管理全局主动录入的记忆记录，不读取其他聊天的原始消息。
 * 主要职责：listIngestionRecords 提供有界搜索；readIngestionRecord 锁定当前断言；
 * mutateIngestionRecord 将删除写成撤回、撤销写成新断言，并按 operationId 幂等记录管理操作。
 * 代码库关系：录入仓储和管理路由共用此边界；继续复用 Knowledge 的断言/证据/Wiki，无第二份记忆内容库。
 * 输入输出与副作用：事务按全局范围串行化，与 AI 修改共锁；旧目标返回冲突。每次操作同步刷新 Wiki，保留审计链。
 */
import {
  GLOBAL_MEMORY_SCOPE_ID,
  USER_STATEMENT_KIND,
  memoryIngestionRecordSchema,
  memoryIngestionMutationSchema,
  userStatementPayloadSchema,
  type MemoryIngestionRecord,
} from "@kaguya/schema";
import type { KnowledgeClaimInput } from "@kaguya/memory";
import type { SqlDatabase, SqlTransaction } from "./driver.js";
import { PostgresMemoryKnowledgeStore } from "./memory-knowledge.js";
import { MemoryIngestionError } from "./memory-ingestion.js";

type RecordRow = {
  input: KnowledgeClaimInput;
  label: string;
  payload: unknown;
  recorded_at: string | Date;
};
const recordQuery = `SELECT c.input, COALESCE(a.payload->>'label',a.payload->>'accountId',a.information_id) AS label,
  s.payload, c.recorded_at FROM memory_knowledge_claims c
  JOIN information_atoms a ON a.information_id=c.subject_id
  JOIN information_atoms s ON s.information_id=(c.input->'evidenceSourceInformationIds'->>0)
  WHERE c.scope_id=$1 AND c.invalidated_at IS NULL AND c.speaker_id IS NULL
  AND s.kind='agent.user.statement'
  AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claims n WHERE n.supersedes_id=c.claim_id OR n.retracts_id=c.claim_id)`;
function record(row: RecordRow): MemoryIngestionRecord {
  const source = userStatementPayloadSchema.parse(row.payload);
  return memoryIngestionRecordSchema.parse({
    claimId: row.input.claimId,
    subjectInformationId: row.input.subjectInformationId,
    subjectLabel: row.label,
    predicate: row.input.predicate,
    value: row.input.value.replace(/ \[entity:[^\]]+\]$/u, ""),
    sourceType: source.sourceType,
    sourceInformationId: source.originalSourceInformationId!,
    evidenceText: source.text,
    deleted: !!row.input.retractsClaimId,
    updatedAt: new Date(row.recorded_at).toISOString(),
  });
}
export async function listIngestionRecords(
  database: SqlTransaction,
  query = "",
  offset = 0,
) {
  const rows = await database.query<RecordRow>(
    `${recordQuery} AND ($2::text='' OR strpos(lower(a.payload->>'label'),lower($2))>0 OR strpos(lower((c.input->>'predicate') || ' ' || (c.input->>'value')),lower($2))>0) ORDER BY c.recorded_at DESC,c.claim_id DESC LIMIT 21 OFFSET $3`,
    [GLOBAL_MEMORY_SCOPE_ID, query, offset],
  );
  return {
    records: rows.rows.slice(0, 20).map(record),
    hasMore: rows.rows.length > 20,
  };
}
export async function readIngestionRecord(
  database: SqlTransaction,
  claimId: string,
) {
  const rows = await database.query<RecordRow>(
    `${recordQuery} AND c.claim_id=$2`,
    [GLOBAL_MEMORY_SCOPE_ID, claimId],
  );
  if (!rows.rows[0]) throw new MemoryIngestionError("record_changed", 409);
  return {
    claim: {
      ...rows.rows[0].input,
      recordedAt: new Date(rows.rows[0].recorded_at).toISOString(),
    },
    record: record(rows.rows[0]),
  };
}
export function ingestionTransactionDatabase(tx: SqlTransaction): SqlDatabase {
  return {
    query: tx.query.bind(tx),
    exec: tx.exec.bind(tx),
    transaction: (operation) => operation(tx),
    close: async () => {},
  };
}
export async function refreshIngestionWiki(
  knowledge: PostgresMemoryKnowledgeStore,
  entityId: string,
  operationId: string,
) {
  const page = await knowledge.readWikiPage({
    scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
    entityInformationId: entityId,
  });
  if (!page) return;
  const cutoff = new Date().toISOString();
  const memory = await knowledge.recall({
    scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
    entityInformationId: entityId,
    occurredBefore: cutoff,
    recordedBefore: cutoff,
    limit: 100,
  });
  await knowledge.writeWikiRevision({
    operationId,
    scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
    entityInformationId: entityId,
    expectedVersion: page.version,
    expectedDirtyVersion: page.dirtyVersion,
    evidenceCutoff: { occurredBefore: cutoff, recordedBefore: cutoff },
    generatorVersion: "user-ingestion-v2",
    sections: memory.claims
      .slice(0, 16)
      .map((c) => ({
        heading: c.predicate,
        content: `[${c.epistemic}] ${c.value}`,
        evidenceSourceInformationIds: c.evidenceSourceInformationIds,
        claimIds: [c.claimId],
      })),
  });
}
export async function mutateIngestionRecord(
  database: SqlDatabase,
  input: unknown,
) {
  const parsed = memoryIngestionMutationSchema.safeParse(input);
  if (!parsed.success)
    throw new MemoryIngestionError("invalid_record_operation");
  const request = parsed.data;
  return database.transaction(async (tx) => {
    const scope = await tx.query(
      "SELECT scope_id FROM memory_knowledge_scopes WHERE scope_id=$1 FOR UPDATE",
      [GLOBAL_MEMORY_SCOPE_ID],
    );
    if (!scope.rows.length)
      throw new MemoryIngestionError("record_changed", 409);
    const operationId = `ingestion-record:${request.operationId}`;
    const prior = await tx.query<{
      input: { request: unknown; result: unknown };
    }>(
      "SELECT input FROM memory_knowledge_mutations WHERE scope_id=$1 AND operation_id=$2",
      [GLOBAL_MEMORY_SCOPE_ID, operationId],
    );
    if (prior.rows[0]) {
      const previous = memoryIngestionMutationSchema.parse(
        prior.rows[0].input.request,
      );
      if (JSON.stringify(previous) !== JSON.stringify(request))
        throw new MemoryIngestionError("request_id_conflict", 409);
      return memoryIngestionRecordSchema.parse(prior.rows[0].input.result);
    }
    const current = await readIngestionRecord(tx, request.claimId);
    if (current.record.deleted !== (request.action === "restore"))
      throw new MemoryIngestionError("record_changed", 409);
    const sourceCheck = await tx.query<{ source_kind: string }>(
      "SELECT source_kind FROM memory_knowledge_events WHERE source_id=ANY($1::text[])",
      [current.claim.evidenceSourceInformationIds],
    );
    if (
      sourceCheck.rows.length !==
        current.claim.evidenceSourceInformationIds.length ||
      sourceCheck.rows.some((r) => r.source_kind !== USER_STATEMENT_KIND)
    )
      throw new MemoryIngestionError("record_changed", 409);
    const knowledge = new PostgresMemoryKnowledgeStore(
      ingestionTransactionDatabase(tx),
    );
    const claimId = `user-${request.action}:${request.operationId}`;
    let original = current.claim;
    if (request.action === "restore") {
      const source = await tx.query<{ input: KnowledgeClaimInput }>(
        "SELECT input FROM memory_knowledge_claims WHERE claim_id=$1 AND scope_id=$2",
        [current.claim.retractsClaimId!, GLOBAL_MEMORY_SCOPE_ID],
      );
      if (!source.rows[0])
        throw new MemoryIngestionError("record_changed", 409);
      original = {
        ...source.rows[0].input,
        recordedAt: current.claim.recordedAt,
      };
      if (original.validTo && Date.parse(original.validTo) < Date.now())
        throw new MemoryIngestionError("record_expired", 409);
    }
    const {
      supersedesClaimId: _supersedes,
      retractsClaimId: _retracts,
      recordedAt: _recorded,
      validTo,
      ...content
    } = original;
    await knowledge.appendClaim({
      ...content,
      claimId,
      ...(request.action === "restore" && validTo ? { validTo } : {}),
      validFrom: new Date(
        Math.max(Date.now(), Date.parse(content.validFrom)),
      ).toISOString(),
      ...(request.action === "delete"
        ? { retractsClaimId: current.claim.claimId }
        : { supersedesClaimId: current.claim.claimId }),
    });
    await refreshIngestionWiki(
      knowledge,
      current.claim.subjectInformationId,
      operationId,
    );
    const result = (await readIngestionRecord(tx, claimId)).record;
    await tx.query(
      "INSERT INTO memory_knowledge_mutations(scope_id,operation_id,input) VALUES($1,$2,$3::jsonb)",
      [
        GLOBAL_MEMORY_SCOPE_ID,
        operationId,
        JSON.stringify({ request, submitter: "webui:management", result }),
      ],
    );
    return result;
  });
}
