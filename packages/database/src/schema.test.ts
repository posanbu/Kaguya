import { afterEach, describe, expect, it } from "vitest";

import { UnsupportedDatabaseSchemaError } from "./index.js";
import { createTestingDatabase } from "./testing.js";

const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database schema v1", () => {
  it("initializes an empty schema and reuses complete v1 data", async () => {
    const database = await createDatabase();
    await database.prepareSchema();
    const metadata = await database.sql.query<{ version: number }>(
      "SELECT version FROM kaguya_schema_metadata",
    );
    expect(metadata.rows).toEqual([{ version: 1 }]);
    await database.sql.query(
      "INSERT INTO information_kinds (kind) VALUES ($1)",
      ["test.kind"],
    );
    await expect(database.prepareSchema()).resolves.toBeUndefined();
    expect(
      (await database.sql.query("SELECT kind FROM information_kinds")).rows,
    ).toEqual([{ kind: "test.kind" }]);
  });

  it.each([
    [
      "legacy ledger",
      "CREATE TABLE kaguya_schema_migrations (version integer PRIMARY KEY)",
    ],
    [
      "partial schema",
      "CREATE TABLE information_kinds (kind text PRIMARY KEY)",
    ],
    [
      "unknown version",
      "CREATE TABLE kaguya_schema_metadata (singleton boolean PRIMARY KEY, version integer NOT NULL); INSERT INTO kaguya_schema_metadata VALUES (true, 6)",
    ],
  ])("rejects %s without modifying schema", async (_label, sql) => {
    const database = await createDatabase();
    await database.sql.exec(sql);
    await expect(database.prepareSchema()).rejects.toBeInstanceOf(
      UnsupportedDatabaseSchemaError,
    );
    const metadata = await database.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'information_atoms'`,
    );
    expect(metadata.rows[0]?.count).toBe("0");
  });

  it("rejects a forged metadata marker and a damaged current schema", async () => {
    const forged = await createDatabase();
    await forged.sql.exec(
      "CREATE TABLE kaguya_schema_metadata (singleton boolean PRIMARY KEY, version integer NOT NULL); INSERT INTO kaguya_schema_metadata VALUES (true, 1)",
    );
    await expect(forged.prepareSchema()).rejects.toBeInstanceOf(
      UnsupportedDatabaseSchemaError,
    );

    const damaged = await createDatabase();
    await damaged.prepareSchema();
    await damaged.sql.exec("DROP INDEX information_atoms_kind_occurred_at_idx");
    await expect(damaged.prepareSchema()).rejects.toBeInstanceOf(
      UnsupportedDatabaseSchemaError,
    );
  });
});

async function createDatabase() {
  const database = await createTestingDatabase();
  databases.push(database);
  return database;
}
