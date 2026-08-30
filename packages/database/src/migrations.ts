import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const DATABASE_FORMAT_VERSION = "2";

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX messages_occurred_at_idx ON messages (occurred_at);

      CREATE TABLE event_runs (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        output_json TEXT,
        retryable INTEGER,
        error_json TEXT
      ) STRICT;

      CREATE INDEX event_runs_trace_started_at_idx
        ON event_runs (trace_id, started_at);

      CREATE TABLE llm_traces (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('route', 'reply', 'state', 'memory')),
        model_id TEXT NOT NULL,
        causation_event_id TEXT,
        root_event_id TEXT,
        prompt_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        response_json TEXT,
        usage_json TEXT,
        error_json TEXT
      ) STRICT;

      CREATE INDEX llm_traces_trace_started_at_idx
        ON llm_traces (trace_id, started_at);

      CREATE TABLE outbound_messages (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        message_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('requested', 'delivered', 'failed')),
        receipt_json TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX outbound_messages_trace_occurred_at_idx
        ON outbound_messages (trace_id, occurred_at);
    `,
  },
];

export class DatabaseFormatError extends Error {
  readonly code = "DATABASE_UNSUPPORTED_FORMAT";

  constructor() {
    super(
      "The database format is no longer supported; back up the database and initialize a new one",
    );
    this.name = "DatabaseFormatError";
  }
}

export function migrateDatabase(database: DatabaseSync): void {
  assertSupportedOrEmptyDatabase(database);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS kaguya_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        migrated_at TEXT NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        "INSERT OR IGNORE INTO kaguya_metadata (key, value) VALUES (?, ?)",
      )
      .run("format_version", DATABASE_FORMAT_VERSION);

    const appliedVersions = new Set(
      database
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => row.version)
        .filter((version): version is number => typeof version === "number"),
    );
    const recordMigration = database.prepare(
      "INSERT INTO schema_migrations (version, migrated_at) VALUES (?, ?)",
    );

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      database.exec(migration.sql);
      recordMigration.run(migration.version, new Date().toISOString());
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function assertSupportedOrEmptyDatabase(database: DatabaseSync): void {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
  if (tables.length === 0) {
    return;
  }
  if (
    !tables.includes("kaguya_metadata") ||
    !tables.includes("schema_migrations")
  ) {
    throw new DatabaseFormatError();
  }
  const format = database
    .prepare("SELECT value FROM kaguya_metadata WHERE key = ?")
    .get("format_version");
  if (format?.value !== DATABASE_FORMAT_VERSION) {
    throw new DatabaseFormatError();
  }
}
