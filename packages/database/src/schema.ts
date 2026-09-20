/**
 * 功能概述：初始化并校验 PostgreSQL v1 账本；prepareLifecycleProjection 建立可重建的开放集合及 scope 槽。
 * 主要职责：prepareDatabaseSchema 在启动事务中校验既有结构并首次回填投影；后续启动不扫描历史。
 * prepareWebMemoryDestination 兼容旧 Web 目标约束，允许 conversationId 索引；旧 NULL 行不改写。
 * lifecycle 回填与在线追加使用同一 Web conversationId scope，保持历史查询和观察范围一致。
 * 代码库关系：InformationRepository 同事务维护投影，ReliableInformationRepository 锁定 scope head；原子仍只追加。
 * 输入输出与副作用：执行 DDL 与首次历史回填；不支持的账本结构报错，失败回滚全部 schema 变更。
 */
import type { SqlDatabase } from "./driver.js";

export const POSTGRES_SCHEMA_VERSION = 1;

const REQUIRED_TABLES = [
  "kaguya_schema_metadata",
  "information_kinds",
  "information_atoms",
  "information_references",
  "information_log_outbox",
  "information_subscriptions",
  "information_deliveries",
  "information_commit_slots",
  "memory_documents",
  "memory_document_ngrams",
  "information_schedule_arms",
] as const;

const REQUIRED_INDEXES = [
  "information_deliveries_pending_idx",
  "information_schedule_arms_open_due_idx",
  "information_atoms_kind_occurred_at_idx",
  "information_atoms_source_occurred_at_idx",
  "information_references_target_relation_idx",
  "information_log_outbox_pending_idx",
  "memory_document_ngrams_gram_idx",
  "memory_documents_namespace_time_idx",
  "memory_documents_account_time_idx",
  "memory_documents_scope_time_idx",
] as const;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  kaguya_schema_metadata: ["singleton", "version"],
  information_kinds: ["kind"],
  information_atoms: [
    "information_id",
    "kind",
    "occurred_at",
    "source",
    "payload",
  ],
  information_references: [
    "information_id",
    "ordinal",
    "relation",
    "target_information_id",
  ],
  information_log_outbox: [
    "information_id",
    "created_at",
    "projected_at",
    "attempt_count",
    "last_error",
  ],
  information_subscriptions: ["subscription_id", "kind", "enabled"],
  information_deliveries: [
    "subscription_id",
    "information_id",
    "state",
    "attempts",
    "created_at",
    "available_at",
    "token",
    "lease_until",
  ],
  information_commit_slots: ["slot_type", "namespace", "key", "information_id"],
  memory_documents: [
    "memory_id",
    "source_information_id",
    "source_kind",
    "content",
    "occurred_at",
    "created_at",
    "platform",
    "adapter_id",
    "platform_message_id",
    "account_id",
    "destination_kind",
    "destination_id",
  ],
  memory_document_ngrams: ["memory_id", "gram"],
  information_schedule_arms: [
    "schedule_information_id",
    "due_at",
    "state",
    "due_information_id",
    "terminal_information_id",
  ],
};

export class UnsupportedDatabaseSchemaError extends Error {
  constructor() {
    super("Unsupported Kaguya database schema");
    this.name = "UnsupportedDatabaseSchemaError";
  }
}

export async function prepareDatabaseSchema(
  database: SqlDatabase,
): Promise<void> {
  await database.transaction(async (tx) => {
    const tables = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()`,
    );
    const tableNames = new Set(tables.rows.map(({ table_name }) => table_name));
    if (tableNames.has("kaguya_schema_migrations")) {
      throw new UnsupportedDatabaseSchemaError();
    }
    if (tableNames.has("kaguya_schema_metadata")) {
      await validateCurrentSchema(tx, tableNames);
      await prepareWebMemoryDestination(tx);
      await prepareLifecycleProjection(tx);
      return;
    }
    if (tableNames.size > 0) {
      throw new UnsupportedDatabaseSchemaError();
    }
    await tx.exec(`
      CREATE TABLE kaguya_schema_metadata (
        singleton boolean PRIMARY KEY CHECK (singleton),
        version integer NOT NULL CHECK (version = 1)
      );

      CREATE TABLE information_kinds (
        kind text PRIMARY KEY
      );

      CREATE TABLE information_atoms (
        information_id text PRIMARY KEY,
        kind text NOT NULL REFERENCES information_kinds (kind) ON DELETE RESTRICT,
        occurred_at text NOT NULL,
        source text NOT NULL,
        payload jsonb NOT NULL
      );

      CREATE TABLE information_references (
        information_id text NOT NULL REFERENCES information_atoms (information_id) ON DELETE RESTRICT,
        ordinal integer NOT NULL,
        relation text NOT NULL,
        target_information_id text NOT NULL REFERENCES information_atoms (information_id) ON DELETE RESTRICT,
        PRIMARY KEY (information_id, ordinal)
      );

      CREATE TABLE information_log_outbox (
        information_id text PRIMARY KEY REFERENCES information_atoms (information_id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        projected_at timestamptz,
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error text
      );

      CREATE TABLE information_subscriptions (
        subscription_id text PRIMARY KEY,
        kind text NOT NULL REFERENCES information_kinds(kind),
        enabled boolean NOT NULL DEFAULT true
      );
      CREATE TABLE information_deliveries (
        subscription_id text NOT NULL REFERENCES information_subscriptions(subscription_id),
        information_id text NOT NULL REFERENCES information_atoms(information_id),
        state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','acked','exhausted')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        token text,
        lease_until timestamptz,
        PRIMARY KEY (subscription_id, information_id)
      );
      CREATE INDEX information_deliveries_pending_idx
        ON information_deliveries(subscription_id, available_at, created_at)
        WHERE state IN ('pending', 'claimed');
      CREATE TABLE information_commit_slots (
        slot_type text NOT NULL CHECK (slot_type IN ('operation','terminal')),
        namespace text NOT NULL,
        key text NOT NULL,
        information_id text NOT NULL REFERENCES information_atoms(information_id) DEFERRABLE INITIALLY DEFERRED,
        PRIMARY KEY (slot_type, namespace, key)
      );

      CREATE TABLE memory_documents (
        memory_id text PRIMARY KEY,
        source_information_id text NOT NULL UNIQUE
          REFERENCES information_atoms(information_id) ON DELETE RESTRICT,
        source_kind text NOT NULL,
        content text NOT NULL,
        occurred_at text NOT NULL,
        created_at text NOT NULL,
        platform text NOT NULL,
        adapter_id text NOT NULL,
        platform_message_id text NOT NULL,
        account_id text NOT NULL,
        destination_kind text NOT NULL
          CHECK (destination_kind IN ('private', 'group', 'web')),
        destination_id text,
        CONSTRAINT memory_documents_destination_check CHECK (
          destination_kind = 'web'
          OR (destination_kind IN ('private', 'group') AND destination_id IS NOT NULL)
        )
      );

      CREATE TABLE memory_document_ngrams (
        memory_id text NOT NULL
          REFERENCES memory_documents(memory_id) ON DELETE CASCADE,
        gram text NOT NULL,
        PRIMARY KEY (memory_id, gram)
      );

      CREATE TABLE information_schedule_arms (
        schedule_information_id text PRIMARY KEY
          REFERENCES information_atoms(information_id) ON DELETE RESTRICT,
        due_at timestamptz NOT NULL,
        state text NOT NULL CHECK (state IN ('open', 'due', 'terminal')),
        due_information_id text UNIQUE
          REFERENCES information_atoms(information_id) DEFERRABLE INITIALLY DEFERRED,
        terminal_information_id text UNIQUE
          REFERENCES information_atoms(information_id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX information_schedule_arms_open_due_idx
        ON information_schedule_arms(due_at, schedule_information_id)
        WHERE state = 'open';

      CREATE INDEX information_atoms_kind_occurred_at_idx
        ON information_atoms (kind, occurred_at, information_id);

      CREATE INDEX information_atoms_source_occurred_at_idx
        ON information_atoms (source, occurred_at, information_id);

      CREATE INDEX information_references_target_relation_idx
        ON information_references (target_information_id, relation, information_id, ordinal);

      CREATE INDEX information_log_outbox_pending_idx
        ON information_log_outbox (attempt_count, created_at, information_id)
        WHERE projected_at IS NULL;

      CREATE INDEX memory_document_ngrams_gram_idx
        ON memory_document_ngrams (gram, memory_id);

      CREATE INDEX memory_documents_namespace_time_idx
        ON memory_documents (platform, adapter_id, occurred_at, memory_id);

      CREATE INDEX memory_documents_account_time_idx
        ON memory_documents (platform, adapter_id, account_id, occurred_at, memory_id);

      CREATE INDEX memory_documents_scope_time_idx
        ON memory_documents (
          platform, adapter_id, destination_kind, destination_id, occurred_at, memory_id
        );

      CREATE OR REPLACE FUNCTION kaguya_reject_information_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'information atoms are append-only';
      END;
      $$;

      CREATE TRIGGER information_atoms_reject_mutation
        BEFORE UPDATE OR DELETE ON information_atoms
        FOR EACH ROW
        EXECUTE FUNCTION kaguya_reject_information_mutation();

      CREATE TRIGGER information_references_reject_mutation
        BEFORE UPDATE OR DELETE ON information_references
        FOR EACH ROW
        EXECUTE FUNCTION kaguya_reject_information_mutation();
    `);

    await tx.query(
      `INSERT INTO kaguya_schema_metadata (singleton, version) VALUES (true, $1)`,
      [POSTGRES_SCHEMA_VERSION],
    );
    await prepareLifecycleProjection(tx);
  });
}

async function validateCurrentSchema(
  database: Pick<SqlDatabase, "query">,
  tableNames: ReadonlySet<string>,
): Promise<void> {
  if (REQUIRED_TABLES.some((name) => !tableNames.has(name))) {
    throw new UnsupportedDatabaseSchemaError();
  }
  const columns = await database.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()`,
  );
  const columnNames = new Map<string, Set<string>>();
  for (const column of columns.rows) {
    const names = columnNames.get(column.table_name) ?? new Set<string>();
    names.add(column.column_name);
    columnNames.set(column.table_name, names);
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columnNames.get(table);
    if (actual === undefined || required.some((name) => !actual.has(name))) {
      throw new UnsupportedDatabaseSchemaError();
    }
  }
  const metadata = await database.query<{
    singleton: boolean;
    version: number;
  }>("SELECT singleton, version FROM kaguya_schema_metadata");
  if (
    metadata.rows.length !== 1 ||
    metadata.rows[0]?.singleton !== true ||
    metadata.rows[0]?.version !== POSTGRES_SCHEMA_VERSION
  ) {
    throw new UnsupportedDatabaseSchemaError();
  }
  const indexes = await database.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  const indexNames = new Set(indexes.rows.map(({ indexname }) => indexname));
  if (REQUIRED_INDEXES.some((name) => !indexNames.has(name))) {
    throw new UnsupportedDatabaseSchemaError();
  }
  const triggers = await database.query<{ trigger_name: string }>(
    `SELECT trigger_name FROM information_schema.triggers
     WHERE trigger_schema = current_schema()`,
  );
  const triggerNames = new Set(
    triggers.rows.map(({ trigger_name }) => trigger_name),
  );
  if (
    !triggerNames.has("information_atoms_reject_mutation") ||
    !triggerNames.has("information_references_reject_mutation")
  ) {
    throw new UnsupportedDatabaseSchemaError();
  }
}

/** 旧 v1 匿名 Web 约束只阻止新增会话 ID；替换后保留原行及 QQ 目标非空要求。 */
async function prepareWebMemoryDestination(
  tx: import("./driver.js").SqlTransaction,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(168168)");
  const current = await tx.query<{ name: string }>(
    `SELECT conname AS name FROM pg_constraint
     WHERE conrelid = 'memory_documents'::regclass
       AND conname = 'memory_documents_destination_check'`,
  );
  if (current.rows.length > 0) return;
  await tx.exec(`
    ALTER TABLE memory_documents
      DROP CONSTRAINT IF EXISTS memory_documents_check,
      ADD CONSTRAINT memory_documents_destination_check CHECK (
        destination_kind = 'web'
        OR (destination_kind IN ('private', 'group') AND destination_id IS NOT NULL)
      );
  `);
}

/** 可重建的开放集合与 scope head；旧账本仅首次建表回填，不改写业务事实。 */
async function prepareLifecycleProjection(
  tx: import("./driver.js").SqlTransaction,
) {
  // schema 启动事务串行化，避免两个进程同时回填。
  await tx.query("SELECT pg_advisory_xact_lock(168168)");
  const exists = await tx.query<{ name: string | null }>(
    "SELECT to_regclass('information_lifecycle')::text AS name",
  );
  if (exists.rows[0]?.name) return;
  await tx.exec(`
    CREATE TABLE information_lifecycle (
      information_id text PRIMARY KEY REFERENCES information_atoms(information_id),
      kind text NOT NULL,
      scope_key text,
      occurred_at timestamptz NOT NULL,
      position bigint GENERATED ALWAYS AS IDENTITY,
      is_open boolean NOT NULL DEFAULT true
    );
    CREATE INDEX information_lifecycle_scope_idx
      ON information_lifecycle(kind, scope_key, position DESC) WHERE is_open;
    CREATE INDEX information_lifecycle_scope_position_idx ON information_lifecycle(kind, scope_key, position DESC);
    CREATE UNIQUE INDEX information_lifecycle_position_idx ON information_lifecycle(position);
    CREATE TABLE information_scope_heads (
      namespace text NOT NULL,
      scope_key text NOT NULL,
      information_id text REFERENCES information_atoms(information_id) DEFERRABLE INITIALLY DEFERRED,
      terminal_group text NOT NULL,
      PRIMARY KEY(namespace, scope_key)
    );
    INSERT INTO information_lifecycle(information_id,kind,scope_key,occurred_at,is_open)
      SELECT a.information_id, a.kind, COALESCE(a.payload->>'scopeKey', a.payload->'input'->>'scopeKey',
        CASE WHEN a.payload->'source'->>'platform' IS NOT NULL THEN
          (a.payload->'source'->>'platform') || ':' || (a.payload->'source'->>'adapterId') || ':' ||
          COALESCE(a.payload->'source'->'destination'->>'kind','unknown') || ':' ||
          COALESCE(a.payload->'source'->'destination'->>'groupId', a.payload->'source'->'destination'->>'userId',
            a.payload->'source'->'destination'->>'channelId', a.payload->'source'->'destination'->>'id',
            a.payload->'source'->'destination'->>'conversationId', '')
        WHEN a.payload->>'platform' = 'web' AND a.payload->'target'->>'kind' = 'web' THEN
          'web:' || (a.payload->>'adapterId') || ':web:' ||
          COALESCE(a.payload->'target'->>'conversationId', '') END), a.occurred_at::timestamptz,
        NOT EXISTS (SELECT 1 FROM information_references r
          WHERE r.target_information_id=a.information_id AND r.relation='core:status-of')
        AND NOT EXISTS (SELECT 1 FROM information_commit_slots s
          WHERE s.slot_type='terminal' AND s.key=a.information_id)
      FROM information_atoms a ORDER BY a.occurred_at::timestamptz, a.information_id;
    CREATE INDEX information_atoms_scope_time_idx
      ON information_atoms(kind, (payload->>'scopeKey'), occurred_at DESC, information_id DESC);
  `);
}
