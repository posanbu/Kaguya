import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX messages_session_occurred_at_idx
        ON messages (session_id, occurred_at);

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX memories_session_occurred_at_idx
        ON memories (session_id, occurred_at);

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
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE messages_without_session (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;

      INSERT INTO messages_without_session (
        id, role, content, occurred_at, metadata_json
      )
      SELECT
        id,
        role,
        content,
        occurred_at,
        CASE
          WHEN json_valid(metadata_json) AND json_type(metadata_json) = 'object'
            THEN json_set(metadata_json, '$.legacySessionId', session_id)
          ELSE json_object(
            'legacySessionId', session_id,
            'legacyMetadata', metadata_json
          )
        END
      FROM messages;

      DROP INDEX messages_session_occurred_at_idx;
      DROP TABLE messages;
      ALTER TABLE messages_without_session RENAME TO messages;
      CREATE INDEX messages_occurred_at_idx ON messages (occurred_at);

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
  {
    version: 3,
    sql: `
      ALTER TABLE llm_traces ADD COLUMN causation_event_id TEXT;
      ALTER TABLE llm_traces ADD COLUMN root_event_id TEXT;
    `,
  },
];

export function migrateDatabase(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        migrated_at TEXT NOT NULL
      ) STRICT;
    `);

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
