import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { OutboundMessageRecord } from "@kaguya/schema";
import { afterEach, describe, expect, it } from "vitest";

import { KaguyaDatabase } from "./index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kaguya-database-"));
  directories.push(directory);
  return join(directory, "kaguya.sqlite");
}

describe("KaguyaDatabase", () => {
  it("stores messages without a Core session", () => {
    const database = KaguyaDatabase.open(databasePath());
    database.migrate();
    database.messages.insert({
      id: "message-1",
      role: "user",
      content: "hello",
      occurredAt: "2026-08-14T00:00:00.000Z",
      metadata: { source: "test" },
    });

    expect(database.messages.getById("message-1")).toEqual({
      id: "message-1",
      role: "user",
      content: "hello",
      occurredAt: "2026-08-14T00:00:00.000Z",
      metadata: { source: "test" },
    });
    expect(database.messages.listRecent(10)).toHaveLength(1);
    database.close();
  });

  it("migrates legacy session_id into metadata and removes the column", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        migrated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (1, '2026-08-14T00:00:00.000Z');
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
      CREATE TABLE llm_traces (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        usage_json TEXT,
        error_json TEXT
      ) STRICT;
      INSERT INTO messages VALUES (
        'legacy-message', 'qq:group:778899', 'user', 'old',
        '2026-08-13T00:00:00.000Z', '{"existing":true}'
      );
      INSERT INTO messages VALUES (
        'legacy-malformed', 'qq:private:112233', 'user', 'also old',
        '2026-08-13T00:00:01.000Z', 'not-json'
      );
    `);
    legacy.close();

    const database = KaguyaDatabase.open(path);
    database.migrate();
    expect(database.messages.getById("legacy-message")).toMatchObject({
      metadata: { existing: true, legacySessionId: "qq:group:778899" },
    });
    expect(database.messages.getById("legacy-malformed")).toMatchObject({
      metadata: {
        legacySessionId: "qq:private:112233",
        legacyMetadata: "not-json",
      },
    });
    expect(database.messages.listRecent(10)).toHaveLength(2);
    database.close();

    const inspected = new DatabaseSync(path);
    const columns = inspected
      .prepare("PRAGMA table_info(messages)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("session_id");
    const traceColumns = inspected
      .prepare("PRAGMA table_info(llm_traces)")
      .all()
      .map((row) => row.name);
    expect(traceColumns).toEqual(
      expect.arrayContaining(["causation_event_id", "root_event_id"]),
    );
    inspected.close();
  });

  it("records outbound request and delivery as one audited lifecycle", () => {
    const database = KaguyaDatabase.open(databasePath());
    database.migrate();
    const requested: Extract<OutboundMessageRecord, { status: "requested" }> = {
      id: "outbound-1",
      traceId: "trace-1",
      adapterId: "napcat.qq.main",
      platform: "qq",
      destination: { kind: "group", groupId: "778899" },
      message: { kind: "text", text: "hello" },
      occurredAt: "2026-08-14T00:00:00.000Z",
      status: "requested",
      metadata: { causationEventId: "event-1" },
    };
    database.outboundMessages.insert(requested);
    database.outboundMessages.complete({
      ...requested,
      status: "delivered",
      completedAt: "2026-08-14T00:00:01.000Z",
      receipt: { ok: true, platformMessageId: "platform-2" },
    });

    expect(database.outboundMessages.getById("outbound-1")).toMatchObject({
      status: "delivered",
      receipt: { ok: true, platformMessageId: "platform-2" },
    });
    expect(database.outboundMessages.listByTrace("trace-1")).toHaveLength(1);
    expect(() =>
      database.outboundMessages.complete({
        ...requested,
        status: "failed",
        completedAt: "2026-08-14T00:00:02.000Z",
        error: "late failure",
      }),
    ).toThrow("invalid lifecycle transition");
    database.close();
  });
});
