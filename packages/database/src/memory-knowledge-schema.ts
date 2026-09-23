/**
 * 附加录入会话、版本化任务及租约表用于中断恢复，旧 Information schema 无需迁移。
 * 功能概述：为可选第一方知识 Memory 建立 PostgreSQL 投影表，不修改 v1 Information 身份账本。
 * 主要职责：prepareMemoryKnowledgeSchema 幂等安装事件、参与实体、断言证据、episode 与 Wiki 不可变修订；范围锁行串行化关联写入。
 * 代码库关系：KaguyaDatabase 的显式初始化方法调用本文件；PostgresMemoryKnowledgeStore 使用相同外键及范围/时间索引。
 * 输入输出与副作用：须先初始化基础账本；DDL 在事务内执行，创建记录时间均由数据库生成；不回填或无界扫描历史。
 */
import type { SqlDatabase } from "./driver.js";

export async function prepareMemoryKnowledgeSchema(
  database: SqlDatabase,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS memory_knowledge_scopes (
        scope_id text PRIMARY KEY REFERENCES information_atoms(information_id)
      );
      CREATE TABLE IF NOT EXISTS memory_knowledge_events (
        source_id text PRIMARY KEY REFERENCES information_atoms(information_id),
        scope_id text NOT NULL REFERENCES information_atoms(information_id),
        source_kind text NOT NULL, occurred_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        input jsonb NOT NULL, revoked_at timestamptz, revoke_reason text
      );
      CREATE INDEX IF NOT EXISTS memory_knowledge_events_scope_time_idx
        ON memory_knowledge_events(scope_id, occurred_at DESC, recorded_at DESC, source_id);
      CREATE TABLE IF NOT EXISTS memory_knowledge_revocations (
        source_id text NOT NULL REFERENCES information_atoms(information_id),
        scope_id text NOT NULL REFERENCES information_atoms(information_id),
        recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        reason text NOT NULL, PRIMARY KEY(scope_id,source_id)
      );
      CREATE TABLE IF NOT EXISTS memory_knowledge_mutations (
        scope_id text NOT NULL REFERENCES information_atoms(information_id), operation_id text NOT NULL,
        input jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        PRIMARY KEY(scope_id,operation_id)
      );
      CREATE TABLE IF NOT EXISTS memory_knowledge_event_entities (
        source_id text NOT NULL REFERENCES memory_knowledge_events(source_id),
        entity_id text NOT NULL REFERENCES information_atoms(information_id),
        PRIMARY KEY(source_id, entity_id)
      );
      CREATE INDEX IF NOT EXISTS memory_knowledge_event_entities_entity_idx
        ON memory_knowledge_event_entities(entity_id, source_id);
      CREATE TABLE IF NOT EXISTS memory_knowledge_claims (
        claim_id text PRIMARY KEY, scope_id text NOT NULL REFERENCES information_atoms(information_id),
        subject_id text NOT NULL REFERENCES information_atoms(information_id),
        speaker_id text REFERENCES information_atoms(information_id),
        valid_from timestamptz NOT NULL, valid_to timestamptz,
        recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        supersedes_id text REFERENCES memory_knowledge_claims(claim_id),
        retracts_id text REFERENCES memory_knowledge_claims(claim_id),
        invalidated_at timestamptz, input jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_knowledge_claims_scope_time_idx
        ON memory_knowledge_claims(scope_id, subject_id, valid_from, recorded_at);
      CREATE INDEX IF NOT EXISTS memory_knowledge_claims_supersedes_idx ON memory_knowledge_claims(supersedes_id);
      CREATE INDEX IF NOT EXISTS memory_knowledge_claims_retracts_idx ON memory_knowledge_claims(retracts_id);
      CREATE TABLE IF NOT EXISTS memory_knowledge_claim_evidence (
        claim_id text NOT NULL REFERENCES memory_knowledge_claims(claim_id),
        source_id text NOT NULL REFERENCES memory_knowledge_events(source_id),
        PRIMARY KEY(claim_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS memory_knowledge_claim_evidence_source_idx ON memory_knowledge_claim_evidence(source_id, claim_id);
      CREATE TABLE IF NOT EXISTS memory_knowledge_episodes (
        episode_id text PRIMARY KEY, scope_id text NOT NULL REFERENCES information_atoms(information_id),
        recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()), input jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_knowledge_wiki_pages (
        scope_id text NOT NULL REFERENCES information_atoms(information_id),
        entity_id text NOT NULL REFERENCES information_atoms(information_id),
        version integer NOT NULL DEFAULT 0, dirty_version integer NOT NULL DEFAULT 0,
        dirty boolean NOT NULL DEFAULT true, reasons jsonb NOT NULL DEFAULT '[]',
        PRIMARY KEY(scope_id, entity_id)
      );
      CREATE INDEX IF NOT EXISTS memory_knowledge_wiki_dirty_idx ON memory_knowledge_wiki_pages(scope_id, entity_id) WHERE dirty;
      CREATE TABLE IF NOT EXISTS memory_ingestion_locks (id text PRIMARY KEY);
      INSERT INTO memory_ingestion_locks(id) VALUES('web-scope') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS memory_ingestion_sessions (
        session_id text PRIMARY KEY, scope_id text NOT NULL, source_type text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_ingestion_jobs (
        request_id text PRIMARY KEY, session_id text NOT NULL REFERENCES memory_ingestion_sessions(session_id),
        scope_id text NOT NULL REFERENCES information_atoms(information_id), contract_version integer NOT NULL,
        input jsonb NOT NULL, status text NOT NULL DEFAULT 'queued', attempt integer NOT NULL DEFAULT 0,
        plan jsonb, result jsonb NOT NULL DEFAULT '{}', lease_token text, lease_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
        updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
        CHECK(status IN ('queued','processing','clarification','succeeded','partial','failed'))
      );
      CREATE INDEX IF NOT EXISTS memory_ingestion_session_idx ON memory_ingestion_jobs(session_id,created_at,request_id);
      CREATE INDEX IF NOT EXISTS memory_ingestion_pending_idx ON memory_ingestion_jobs(created_at,request_id)
        WHERE status IN ('queued','processing');
      CREATE TABLE IF NOT EXISTS memory_knowledge_wiki_revisions (
        scope_id text NOT NULL, entity_id text NOT NULL, version integer NOT NULL,
        operation_id text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
        input jsonb NOT NULL,
        PRIMARY KEY(scope_id, entity_id, version), UNIQUE(scope_id, entity_id, operation_id),
        FOREIGN KEY(scope_id, entity_id) REFERENCES memory_knowledge_wiki_pages(scope_id, entity_id)
      );
    `);
  });
}
