/**
 * 功能概述：在隔离 PGlite/真实 PostgreSQL 中验证媒体字节、来源授权和冻结输入的持久边界。
 * 主要职责：fixture 为每例建立独立数据库/schema；资源测试检查摘要、幂等、分页和清理竞态；
 * 来源测试检查 scope/sourceKey 唯一性和不可变元数据；freeze 测试以 barrier 选择首个提交赢家。
 * 代码库关系：直接使用数据库媒体仓储；旧文件后端用 SDK 接口模拟，不调用模型或平台服务。
 * 输入输出与副作用：仅合成字节和来源；PG 重连保留同一临时 schema，afterEach 关闭所有连接。
 * 清理回调在最终 DELETE 前插入来源/刷新字节，验证真实 SQL 的复查；失败路径释放所有 barrier。
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaReference } from "@kaguya/schema";
import type { MediaResourceInput, MediaResourceStore } from "@kaguya/sdk";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
  createPostgresTestingDatabaseScope,
} from "./testing.js";
import type { KaguyaDatabase } from "./index.js";
import { PostgresMediaResourceStore } from "./media-resource-store.js";
import { PostgresMediaSourceStore } from "./media-source-store.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "media database cleanup failed");
});
const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];
const cutoff = new Date("2026-01-01T00:00:00Z");
const wait = { timeout: 8000, interval: 20 };
function resource(text = "synthetic media"): MediaResourceInput {
  const bytes = Buffer.from(text),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    sha256,
    resourceId: `sha256:${sha256}`,
    mimeType: "image/png",
  };
}
function source(
  value: MediaResourceInput,
  name = "scene-a:message-1:0",
): MediaReference {
  return {
    mediaId: `media:${createHash("sha256").update(name).digest("hex")}`,
    position: 0,
    mediaType: "image",
    status: "available",
    resourceId: value.resourceId,
    mimeType: "image/png",
    byteLength: value.bytes.byteLength,
  };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function age(db: KaguyaDatabase) {
  await db.sql.query(
    "UPDATE media_resources SET touched_at='2020-01-01T00:00:00Z'",
  );
}
function legacyStore(get: MediaResourceStore["get"]): MediaResourceStore {
  return {
    get,
    put: async () => {},
    delete: async () => {},
    cleanupExpired: async () => 0,
  };
}
for (const backend of backends)
  describe(backend.name, () => {
    async function fixture() {
      const db = await backend.create();
      cleanup.push(() => db.close());
      await db.prepareSchema();
      return {
        db,
        store: new PostgresMediaResourceStore(db.sql),
        sources: new PostgresMediaSourceStore(db.sql),
      };
    }
    it("stores content once, survives schema preparation and honors retention", async () => {
      const { db, store } = await fixture(),
        value = resource();
      await Promise.all([store.put(value), store.put(value)]);
      await db.prepareSchema();
      const saved = await store.get(value.resourceId);
      expect(saved).toEqual({ ...value, bytes: Uint8Array.from(value.bytes) });
      expect(
        (await db.sql.query("SELECT resource_id FROM media_resources")).rows,
      ).toHaveLength(1);
      await expect(
        store.put({ ...value, mimeType: "audio/wav" }),
      ).rejects.toThrow("media-resource-conflict");
      await expect(
        store.put({ ...value, bytes: Uint8Array.from([4]) }),
      ).rejects.toThrow("media-resource-integrity-invalid");
      await age(db);
      expect(await store.cleanupExpired(cutoff, async () => true)).toBe(0);
      expect(await store.cleanupExpired(cutoff, async () => false)).toBe(1);
      expect(await store.get(value.resourceId)).toBeUndefined();
    });
    it("rejects corrupt stored bytes and a different valid resource returned by the legacy backend", async () => {
      const { db, store } = await fixture(),
        value = resource(),
        other = resource("different");
      await store.put(value);
      await db.sql.query(
        "UPDATE media_resources SET bytes=$1 WHERE resource_id=$2",
        [Buffer.from("corrupt"), value.resourceId],
      );
      await expect(store.get(value.resourceId)).rejects.toThrow(
        "media-resource-integrity-invalid",
      );
      const fallback = new PostgresMediaResourceStore(
        db.sql,
        legacyStore(async () => value),
      );
      await expect(fallback.get(other.resourceId)).rejects.toThrow(
        "media-resource-integrity-invalid",
      );
    });
    it("preserves an existing source without relying on an optional retention callback", async () => {
      const { db, store, sources } = await fixture(),
        value = resource();
      await store.put(value);
      await sources.put("scene-a", "message-1:0", source(value));
      await age(db);
      expect(await store.cleanupExpired(cutoff)).toBe(0);
      expect(await store.get(value.resourceId)).toBeDefined();
    });
    it("rechecks a source committed after the asynchronous retention check started", async () => {
      const { db, store, sources } = await fixture(),
        value = resource();
      await store.put(value);
      await age(db);
      const retained = vi.fn(async () => {
        await sources.put("scene-a", "message-1:0", source(value));
        return false;
      });
      expect(await store.cleanupExpired(cutoff, retained)).toBe(0);
      expect(retained).toHaveBeenCalledTimes(1);
      expect(await store.get(value.resourceId)).toBeDefined();
    });
    it("rechecks a concurrent identical put before expiring its bytes", async () => {
      const { db, store } = await fixture(),
        value = resource();
      await store.put(value);
      await age(db);
      expect(
        await store.cleanupExpired(cutoff, async () => {
          await store.put(value);
          return false;
        }),
      ).toBe(0);
      expect(await store.get(value.resourceId)).toBeDefined();
    });
    it("passes source retention to the legacy backend even without a host guard", async () => {
      const { db, sources } = await fixture(),
        value = resource();
      await sources.put("scene-a", "message-1:0", source(value));
      const legacy = legacyStore(async () => value);
      legacy.cleanupExpired = vi.fn(async (_date, retained) => {
        expect(await retained!(value.resourceId)).toBe(true);
        expect(await retained!(resource("unreferenced").resourceId)).toBe(
          false,
        );
        return 0;
      });
      expect(
        await new PostgresMediaResourceStore(db.sql, legacy).cleanupExpired(
          cutoff,
        ),
      ).toBe(0);
      expect(legacy.cleanupExpired).toHaveBeenCalledTimes(1);
    });
    it("continues expired cleanup across a full page while preserving referenced bytes", async () => {
      const { db, store, sources } = await fixture();
      const values = Array.from({ length: 102 }, (_, i) =>
        resource(`resource-${i}`),
      );
      for (const value of values) await store.put(value);
      await sources.put("scene-a", "message-1:0", source(values[0]!));
      await age(db);
      expect(await store.cleanupExpired(cutoff)).toBe(101);
      expect(
        (await db.sql.query("SELECT resource_id FROM media_resources")).rows,
      ).toEqual([{ resource_id: values[0]!.resourceId }]);
    });
    it("keeps content deduplication separate from source scope and rejects source rewrites", async () => {
      const { db, store, sources } = await fixture(),
        value = resource(),
        first = source(value),
        second = source(value, "scene-b:message-1:0");
      await store.put(value);
      await Promise.all([
        sources.put("scene-a", "message-1:0", first),
        sources.put("scene-a", "message-1:0", first),
      ]);
      await sources.put("scene-b", "message-1:0", second);
      expect(await sources.read(first.mediaId, "scene-b")).toBeUndefined();
      expect(await sources.read(second.mediaId, "scene-a")).toBeUndefined();
      expect(await sources.read(first.mediaId, "scene-a")).toEqual(first);
      await expect(sources.put("scene-b", "another", first)).rejects.toThrow(
        "media-source-conflict",
      );
      await expect(
        sources.put("scene-a", "message-1:0", { ...first, position: 1 }),
      ).rejects.toThrow("media-source-conflict");
      await expect(
        sources.put("scene-a", "message-1:0", source(value, "another-id")),
      ).rejects.toThrow("media-source-conflict");
      expect(
        (await db.sql.query("SELECT resource_id FROM media_resources")).rows,
      ).toHaveLength(1);
      expect(
        (await db.sql.query("SELECT media_id FROM media_sources")).rows,
      ).toHaveLength(2);
    });
    it("preserves the first committed snapshot under concurrent creation and never reruns a persisted snapshot", async () => {
      const { db, sources } = await fixture(),
        releaseFirst = barrier(),
        releaseSecond = barrier();
      let entered = 0;
      const first = sources.freeze("request-1", "scene-a", async () => {
        entered++;
        await releaseFirst.promise;
        return { result: "first" };
      });
      const second = sources.freeze("request-1", "scene-a", async () => {
        entered++;
        await releaseSecond.promise;
        return { result: "second" };
      });
      try {
        await vi.waitFor(() => expect(entered).toBe(2), wait);
        releaseSecond.release();
        expect(await second).toEqual({ result: "second" });
        releaseFirst.release();
        expect(await first).toEqual({ result: "second" });
        const create = vi.fn(async () => ({ result: "must-not-run" }));
        expect(await sources.freeze("request-1", "scene-a", create)).toEqual({
          result: "second",
        });
        await expect(
          sources.freeze("request-1", "scene-b", create),
        ).rejects.toThrow("media-snapshot-scope-conflict");
        expect(create).not.toHaveBeenCalled();
        expect(
          (await db.sql.query("SELECT request_key FROM media_input_snapshots"))
            .rows,
        ).toHaveLength(1);
      } finally {
        releaseFirst.release();
        releaseSecond.release();
        await Promise.allSettled([first, second]);
      }
    });
    it("does not save failed snapshot creation and permits a later successful attempt", async () => {
      const { db, sources } = await fixture();
      await expect(
        sources.freeze("failed", "scene-a", async () => {
          throw new Error("synthetic failure");
        }),
      ).rejects.toThrow("synthetic failure");
      expect(
        (await db.sql.query("SELECT request_key FROM media_input_snapshots"))
          .rows,
      ).toHaveLength(0);
      expect(
        await sources.freeze("failed", "scene-a", async () => ({
          result: "recovered",
        })),
      ).toEqual({ result: "recovered" });
    });
  });

it.skipIf(!url)(
  "preserves scoped source, bytes and frozen input after a PostgreSQL pool reconnect",
  async () => {
    const scope = await createPostgresTestingDatabaseScope(url!);
    cleanup.push(() => scope.close());
    const first = await scope.connect();
    await first.prepareSchema();
    const value = resource(),
      ref = source(value),
      store = new PostgresMediaResourceStore(first.sql);
    await store.put(value);
    await first.mediaSources.put("scene-a", "message-1:0", ref);
    await first.mediaSources.freeze("persisted", "scene-a", async () => ({
      text: "original input",
      resourceId: value.resourceId,
    }));
    await first.close();
    const second = await scope.reconnect();
    await second.prepareSchema();
    expect(await second.mediaSources.read(ref.mediaId, "scene-a")).toEqual(ref);
    expect(
      await second.mediaSources.read(ref.mediaId, "scene-b"),
    ).toBeUndefined();
    expect(
      await new PostgresMediaResourceStore(second.sql).get(value.resourceId),
    ).toEqual({ ...value, bytes: Uint8Array.from(value.bytes) });
    expect(
      await second.mediaSources.freeze("persisted", "scene-a", async () => {
        throw new Error("must not recreate input");
      }),
    ).toEqual({ text: "original input", resourceId: value.resourceId });
  },
);
