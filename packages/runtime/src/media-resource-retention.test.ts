/** 使用真实账本表验证媒体清理，不以文件年龄替代可靠投递状态。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import { mediaResourceRetentionGuard } from "./media-resource-retention.js";

let database: Awaited<ReturnType<typeof createTestingDatabase>>;
const resourceId = `sha256:${"a".repeat(64)}`;
beforeEach(async () => {
  database = await createTestingDatabase();
  await database.prepareSchema();
  for (const kind of [
    "test.resource",
    "core.message.assistant.authorized",
    "core.delivery.requested",
    "core.delivery.delivered",
    "core.delivery.failed",
  ]) {
    await database.sql.query(
      "INSERT INTO information_kinds(kind) VALUES ($1)",
      [kind],
    );
  }
  await atom("authorized", "core.message.assistant.authorized", {});
  await atom("resource", "test.resource", { resourceId });
  await reference("resource", "core:caused-by", "authorized");
  await database.sql.query(
    "INSERT INTO information_subscriptions(subscription_id,kind) VALUES ('output','core.message.assistant.authorized')",
  );
});
afterEach(async () => {
  await database?.close();
});

async function atom(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  await database.sql.query(
    "INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload) VALUES ($1,$2,'2026-10-10T00:00:00Z','test',$3::jsonb)",
    [id, kind, JSON.stringify(payload)],
  );
}
async function reference(
  id: string,
  relation: string,
  target: string,
  ordinal = 0,
) {
  await database.sql.query(
    "INSERT INTO information_references(information_id,ordinal,relation,target_information_id) VALUES ($1,$2,$3,$4)",
    [id, ordinal, relation, target],
  );
}

describe("media resource retention guard", () => {
  it("retains an undelivered completed resource during recovery, then releases it after exhaustion", async () => {
    const retained = mediaResourceRetentionGuard(database.sql);
    expect(await retained(resourceId)).toBe(false);
    await database.sql.query(
      "INSERT INTO information_deliveries(subscription_id,information_id,state) VALUES ('output','authorized','pending')",
    );
    expect(await retained(resourceId)).toBe(true);
    await database.sql.query(
      "UPDATE information_deliveries SET state = 'claimed' WHERE information_id = 'authorized'",
    );
    expect(await retained(resourceId)).toBe(true);
    await database.sql.query(
      "UPDATE information_deliveries SET state = 'exhausted' WHERE information_id = 'authorized'",
    );
    expect(await retained(resourceId)).toBe(false);
  });

  it.each(["core.delivery.delivered", "core.delivery.failed"])(
    "releases only after %s, retaining a shared resource for other open deliveries",
    async (terminalKind) => {
      const retained = mediaResourceRetentionGuard(database.sql);
      await atom("delivery", "core.delivery.requested", {
        message: { kind: "audio", resourceId },
      });
      await reference("delivery", "core:result", "resource");
      expect(await retained(resourceId)).toBe(true);
      await atom("terminal", terminalKind, {});
      await reference("terminal", "core:status-of", "delivery");
      expect(await retained(resourceId)).toBe(false);
      await atom("second-delivery", "core.delivery.requested", {
        message: { kind: "audio", resourceId },
      });
      await reference("second-delivery", "core:result", "resource");
      expect(await retained(resourceId)).toBe(true);
      expect(await retained(`sha256:${"b".repeat(64)}`)).toBe(false);
    },
  );
});
