/**
 * 功能概述：使用隔离 PGlite/可选真实 PostgreSQL 账本验证媒体保留，年龄不能替代可靠投递状态。
 * 主要职责：覆盖已领取工作、共享资源独立投递、unknown 及结果引用、不可变来源与冻结重放。
 * 代码库关系：直接执行 mediaResourceRetentionGuard 的 SQL；测试工厂为每例分配独立数据库/schema。
 * 输入输出与副作用：只写合成事实，不启动后台 worker；每次 SQL await 是持久完成边界，关闭数据库完整清理。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import { mediaResourceRetentionGuard } from "./media-resource-retention.js";

const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error(
    "KAGUYA_TEST_DATABASE_URL is required for media retention PostgreSQL tests",
  );
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];
for (const backend of backends)
  describe(backend.name, () => {
    let database: Awaited<ReturnType<typeof createTestingDatabase>>;
    const resourceId = `sha256:${"a".repeat(64)}`;
    beforeEach(async () => {
      database = await backend.create();
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

    it("retains audio after an unknown transport outcome for later reconciliation", async () => {
      await atom("delivery", "core.delivery.requested", {
        message: { kind: "audio", resourceId },
      });
      await reference("delivery", "core:result", "resource");
      await atom("unknown", "core.delivery.failed", { outcome: "unknown" });
      await reference("unknown", "core:status-of", "delivery");
      expect(await mediaResourceRetentionGuard(database.sql)(resourceId)).toBe(
        true,
      );
    });

    it("keeps pending output work even when another delivery of its resource has terminated", async () => {
      await database.sql.query(
        "INSERT INTO information_deliveries(subscription_id,information_id,state) VALUES ('output','authorized','claimed')",
      );
      await atom("delivery", "core.delivery.requested", {
        message: { kind: "audio", resourceId },
      });
      await reference("delivery", "core:result", "resource");
      await atom("terminal", "core.delivery.delivered", {});
      await reference("terminal", "core:status-of", "delivery");
      const retained = mediaResourceRetentionGuard(database.sql);
      expect(await retained(resourceId)).toBe(true);
      await database.sql.query(
        "UPDATE information_deliveries SET state='acked' WHERE information_id='authorized'",
      );
      expect(await retained(resourceId)).toBe(false);
    });

    it("retains a resource linked by the result reference until its independent delivery is confirmed", async () => {
      await atom("delivery", "core.delivery.requested", {
        message: { kind: "audio", resourceId },
      });
      await reference("delivery", "core:result", "resource");
      await atom("terminal", "core.delivery.delivered", {});
      await reference("terminal", "core:status-of", "delivery");
      await atom("legacy-delivery", "core.delivery.requested", {
        message: { kind: "text", text: "fallback" },
      });
      await reference("legacy-delivery", "core:result", "resource");
      await atom("unknown", "core.delivery.failed", { outcome: "unknown" });
      await reference("unknown", "core:status-of", "legacy-delivery");
      const retained = mediaResourceRetentionGuard(database.sql);
      expect(await retained(resourceId)).toBe(true);
      await atom("confirmed", "core.delivery.delivered", {});
      await reference("confirmed", "core:status-of", "legacy-delivery");
      expect(await retained(resourceId)).toBe(false);
    });

    it("retains source bytes across pure-media delivery and frozen replay independently of Memory", async () => {
      const mediaId = `media:${"b".repeat(64)}`;
      const media = {
        mediaId,
        resourceId,
        position: 0,
        mediaType: "image" as const,
        status: "available" as const,
        mimeType: "image/png" as const,
        byteLength: 3,
      };
      await database.mediaSources.put(
        "authorized-scene",
        "original-message:0",
        media,
      );
      const frozen = {
        messages: [
          { role: "user", content: [{ type: "text", text: "old input" }] },
        ],
      };
      await database.mediaSources.freeze(
        "old-request",
        "authorized-scene",
        async () => frozen,
      );
      await atom("delivery", "core.delivery.requested", {
        message: {
          kind: "content",
          segments: [{ kind: "mediaRef", mediaId }],
          requestInformationId: "old-request",
        },
      });
      await atom("unknown", "core.delivery.failed", { outcome: "unknown" });
      await reference("unknown", "core:status-of", "delivery");
      const retained = mediaResourceRetentionGuard(database.sql);
      expect(await retained(resourceId)).toBe(true);
      await atom("confirmed", "core.delivery.delivered", {});
      await reference("confirmed", "core:status-of", "delivery");
      expect(await retained(resourceId)).toBe(true);
      expect(
        await database.mediaSources.freeze(
          "old-request",
          "authorized-scene",
          async () => {
            throw new Error("must not read new input or fetch expired media");
          },
        ),
      ).toEqual(frozen);
      expect(
        await database.mediaSources.read(mediaId, "other-scene"),
      ).toBeUndefined();
    });
  });
