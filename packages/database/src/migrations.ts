/**
 * 功能概述：本模块承载 PostgreSQL 版信息原子仓储的模式迁移，
 * 包括 migration ledger、kind 注册表、原子表、引用表、日志投影 outbox 与 append-only 触发器。
 * 主要职责：`migrateDatabase` 幂等创建 schema 版本、kind、atom、reference 与日志
 * outbox，建立按 kind/source 与发生时间读取的索引，并安装拒绝 UPDATE/DELETE 的触发器。
 * 代码库关系：`KaguyaDatabase.migrate()` 与测试 helper 都调用这里的函数；
 * 仓储逻辑假定这些表、索引与触发器已经存在，并用它们实现事务性写入与只追加约束。
 * 输入输出与副作用：接收 `SqlDatabase` 并在单个事务中执行 DDL、写入版本记录；成功
 * 返回 void，失败由驱动回滚并向调用方传播。
 */
import type { SqlDatabase } from "./driver.js";

const POSTGRES_SCHEMA_VERSION = 3;

export async function migrateDatabase(database: SqlDatabase): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS kaguya_schema_migrations (
        version integer PRIMARY KEY,
        migrated_at text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS information_kinds (
        kind text PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS information_atoms (
        information_id text PRIMARY KEY,
        kind text NOT NULL REFERENCES information_kinds (kind) ON DELETE RESTRICT,
        occurred_at text NOT NULL,
        source text NOT NULL,
        payload jsonb NOT NULL
      );

      CREATE TABLE IF NOT EXISTS information_references (
        information_id text NOT NULL REFERENCES information_atoms (information_id) ON DELETE RESTRICT,
        ordinal integer NOT NULL,
        relation text NOT NULL,
        target_information_id text NOT NULL REFERENCES information_atoms (information_id) ON DELETE RESTRICT,
        PRIMARY KEY (information_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS information_log_outbox (
        information_id text PRIMARY KEY REFERENCES information_atoms (information_id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        projected_at timestamptz,
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error text
      );

      CREATE INDEX IF NOT EXISTS information_atoms_kind_occurred_at_idx
        ON information_atoms (kind, occurred_at, information_id);

      CREATE INDEX IF NOT EXISTS information_atoms_source_occurred_at_idx
        ON information_atoms (source, occurred_at, information_id);

      CREATE INDEX IF NOT EXISTS information_references_target_relation_idx
        ON information_references (target_information_id, relation, information_id, ordinal);

      CREATE INDEX IF NOT EXISTS information_log_outbox_pending_idx
        ON information_log_outbox (attempt_count, created_at, information_id)
        WHERE projected_at IS NULL;

      CREATE OR REPLACE FUNCTION kaguya_reject_information_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'information atoms are append-only';
      END;
      $$;

      DROP TRIGGER IF EXISTS information_atoms_reject_mutation ON information_atoms;
      CREATE TRIGGER information_atoms_reject_mutation
        BEFORE UPDATE OR DELETE ON information_atoms
        FOR EACH ROW
        EXECUTE FUNCTION kaguya_reject_information_mutation();

      DROP TRIGGER IF EXISTS information_references_reject_mutation ON information_references;
      CREATE TRIGGER information_references_reject_mutation
        BEFORE UPDATE OR DELETE ON information_references
        FOR EACH ROW
        EXECUTE FUNCTION kaguya_reject_information_mutation();
    `);

    await tx.query(
      `INSERT INTO kaguya_schema_migrations (version, migrated_at)
       VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING`,
      [POSTGRES_SCHEMA_VERSION, new Date().toISOString()],
    );
  });
}
