import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { OutboundMessageRecord } from "@kaguya/schema";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseFormatError, KaguyaDatabase } from "./index.js";

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
    const path = databasePath();
    const database = KaguyaDatabase.open(path);
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

    const inspected = new DatabaseSync(path);
    expect(
      inspected
        .prepare("SELECT value FROM kaguya_metadata WHERE key = ?")
        .get("format_version"),
    ).toEqual({ value: "2" });
    const tables = inspected
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).not.toContain("memories");
    inspected.close();
  });

  it("lists session messages from metadata in chronological order", () => {
    const database = KaguyaDatabase.open(databasePath());
    database.migrate();
    database.messages.insert({
      id: "message-1",
      role: "user",
      content: "first",
      occurredAt: "2026-08-14T00:00:00.000Z",
      metadata: { sessionId: "session-a" },
    });
    database.messages.insert({
      id: "message-3",
      role: "assistant",
      content: "late reply",
      occurredAt: "2026-08-14T00:00:02.000Z",
      metadata: { sessionId: "session-a", sourceMessageId: "message-2" },
    });
    database.messages.insert({
      id: "message-2",
      role: "user",
      content: "second",
      occurredAt: "2026-08-14T00:00:01.000Z",
      metadata: { sessionId: "session-a" },
    });
    database.messages.insert({
      id: "message-4",
      role: "system",
      content: "outside the session",
      occurredAt: "2026-08-14T00:00:03.000Z",
      metadata: { source: "platform" },
    });

    expect(
      database.messages
        .listBySession("session-a", 10)
        .map((message) => message.id),
    ).toEqual(["message-1", "message-2", "message-3"]);
    expect(
      database.messages
        .listBySession("session-a", 2)
        .map((message) => message.id),
    ).toEqual(["message-2", "message-3"]);
    expect(database.messages.listBySession("unknown-session", 10)).toEqual([]);
    database.close();
  });

  it("rejects a legacy database without modifying schema or data", () => {
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
      INSERT INTO messages VALUES (
        'legacy-message', 'qq:group:778899', 'user', 'old',
        '2026-08-13T00:00:00.000Z', '{"existing":true}'
      );
    `);
    const beforeSchema = legacy
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const beforeMessages = legacy.prepare("SELECT * FROM messages").all();
    legacy.close();

    const database = KaguyaDatabase.open(path);
    expect(() => database.migrate()).toThrowError(DatabaseFormatError);
    expect(() => database.migrate()).toThrowError(
      expect.objectContaining({ code: "DATABASE_UNSUPPORTED_FORMAT" }),
    );
    database.close();

    const inspected = new DatabaseSync(path);
    expect(
      inspected
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
    ).toEqual(beforeSchema);
    expect(inspected.prepare("SELECT * FROM messages").all()).toEqual(
      beforeMessages,
    );
    inspected.close();
  });

  it("rejects an unsupported format marker without repairing it", () => {
    const path = databasePath();
    const initialized = KaguyaDatabase.open(path);
    initialized.migrate();
    initialized.close();

    const incompatible = new DatabaseSync(path);
    incompatible
      .prepare("UPDATE kaguya_metadata SET value = ? WHERE key = ?")
      .run("unsupported", "format_version");
    incompatible.close();

    const database = KaguyaDatabase.open(path);
    expect(() => database.migrate()).toThrowError(
      expect.objectContaining({ code: "DATABASE_UNSUPPORTED_FORMAT" }),
    );
    database.close();

    const inspected = new DatabaseSync(path);
    expect(
      inspected
        .prepare("SELECT value FROM kaguya_metadata WHERE key = ?")
        .get("format_version"),
    ).toEqual({ value: "unsupported" });
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
