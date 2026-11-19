/** 测试库的表与事务锁应在同一个 schema 范围内隔离，同一范围内仍互斥。 */
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresTestingDatabaseScope,
  type PostgresTestingDatabaseScope,
} from "./testing.js";

const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
describe.skipIf(!url)("PostgreSQL test scope advisory locks", () => {
  it("serializes the same schema without blocking an independent test schema", async () => {
    const scopes: PostgresTestingDatabaseScope[] = [];
    let holding: Promise<void> | undefined;
    let release = () => {};
    try {
      const left = await createPostgresTestingDatabaseScope(url!);
      scopes.push(left);
      const right = await createPostgresTestingDatabaseScope(url!);
      scopes.push(right);
      const a = await left.connect();
      const b = await right.connect();
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired = false;
      holding = a.sql.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(7149321)");
        acquired = true;
        await released;
      });
      await vi.waitFor(() => expect(acquired).toBe(true));
      const tryLock = (db: typeof a) =>
        db.sql.transaction(
          async (tx) =>
            (
              await tx.query<{ acquired: boolean }>(
                "SELECT pg_try_advisory_xact_lock(7149321) acquired",
              )
            ).rows[0]!.acquired,
        );
      expect(await tryLock(a)).toBe(false);
      expect(await tryLock(b)).toBe(true);
    } finally {
      try {
        release();
        await holding;
      } finally {
        await Promise.all(scopes.map((scope) => scope.close()));
      }
    }
  });
});
