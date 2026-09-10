/** PostgreSQL schema v1 initializer and strict validator. */
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
        CHECK (
          (destination_kind = 'web' AND destination_id IS NULL)
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
