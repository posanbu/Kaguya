/**
 * 显式要求 PostgreSQL 时缺少 URL 直接失败，不能静默退回 PGlite。
 * 功能概述：在真实 PGlite/可选隔离 PostgreSQL 上验证入站媒体来源隔离与 Heavy 三档实际消息。
 * fixture 仅使用合成 PNG、内存资源仓储和受控视觉观察，关闭 Memory 后仍可直接调用同一生产输入入口。
 * 验证原顺序、摘要字节去重但不共享权限、预算、冻结恢复、观察失败；所有数据库由 afterEach 关闭。
 */
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import type { KaguyaDatabase } from "@kaguya/database";
import type {
  MediaResource,
  MediaResourceInput,
  MediaResourceStore,
} from "@kaguya/sdk";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";
import { sceneIdentity, type MediaReference } from "@kaguya/schema";
import {
  ingestMediaContent,
  prepareHeavyMedia,
  withoutFrozenMediaInput,
  type MediaInputOptions,
} from "./media-input.js";
const png = await sharp({
  create: { width: 1, height: 1, channels: 4, background: "#ff0000" },
})
  .png()
  .toBuffer();
const dbs: KaguyaDatabase[] = [];
afterEach(async () => {
  const closed = await Promise.allSettled(
    dbs.splice(0).map((db) => db.close()),
  );
  const failures = closed.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      "media test cleanup failed",
    );
});
class Resources implements MediaResourceStore {
  readonly values = new Map<string, MediaResource>();
  async put(value: MediaResourceInput) {
    this.values.set(value.resourceId, {
      ...value,
      bytes: Uint8Array.from(value.bytes),
    });
  }
  async get(id: string) {
    return this.values.get(id);
  }
  async delete(id: string) {
    this.values.delete(id);
  }
  async cleanupExpired() {
    return 0;
  }
}
const url = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL media test URL required");
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];
const message = (groupId = "A"): PlatformInboundMessage => ({
  platform: "qq",
  adapterId: "qq",
  platformMessageId: "one",
  occurredAt: "2026-01-01T00:00:00Z",
  text: "before[image]after",
  raw: {},
  sender: { userId: "sender" },
  target: { kind: "group", groupId },
  mentions: [],
  contentSegments: [
    { kind: "text", text: "before" },
    {
      kind: "media",
      position: 1,
      mediaType: "image",
      source: { url: "https://untrusted.test/token=do-not-persist" },
    },
    { kind: "text", text: "after" },
  ],
});
const model = { providerId: "test", modelId: "image-model" };
for (const backend of backends)
  describe(backend.name, () => {
    async function fixture() {
      const db = await backend.create();
      dbs.push(db);
      await db.prepareSchema();
      const resources = new Resources(),
        input = message();
      const scope = sceneIdentity({
        platform: input.platform,
        adapterId: input.adapterId,
        destination: input.target,
      });
      const acquire = vi.fn(async () => png);
      const segments = await ingestMediaContent(
        input,
        db.mediaSources,
        resources,
        { mode: "off", acquire },
      );
      const refs = segments!.flatMap((s) =>
        s.kind === "media" ? [s.media] : [],
      );
      return { db, resources, input, scope, acquire, segments, refs };
    }
    it("keeps ordered references without source URL and deduplicates bytes without granting another scene access", async () => {
      const f = await fixture();
      expect(f.segments!.map((s) => s.kind)).toEqual(["text", "media", "text"]);
      expect(JSON.stringify(f.segments)).not.toContain("untrusted");
      expect(f.refs[0]!.resourceId).toBe(
        `sha256:${createHash("sha256").update(png).digest("hex")}`,
      );
      const other = await ingestMediaContent(
        message("B"),
        f.db.mediaSources,
        f.resources,
        { mode: "off", acquire: f.acquire },
      );
      const ref = other![1]!.kind === "media" ? other![1]!.media : undefined;
      expect(ref!.mediaId).not.toBe(f.refs[0]!.mediaId);
      expect(ref!.resourceId).toBe(f.refs[0]!.resourceId);
      expect(f.resources.values.size).toBe(1);
      expect(
        await f.db.mediaSources.read(ref!.mediaId, f.scope),
      ).toBeUndefined();
      await ingestMediaContent(f.input, f.db.mediaSources, f.resources, {
        mode: "off",
        acquire: f.acquire,
      });
      expect(f.acquire).toHaveBeenCalledTimes(2);
      await f.db.prepareSchema(); // Existing schema/data survive idempotent initialization.
      expect(await f.db.mediaSources.read(f.refs[0]!.mediaId, f.scope)).toEqual(
        f.refs[0],
      );
    });
    it.each(["off", "native", "external"] as const)(
      "freezes actual %s content and replays without source reads or observation",
      async (mode) => {
        const f = await fixture();
        const observe = vi.fn(async () => ({
          text: "a synthetic pixel",
          modelIdentity: "vision/test",
          completedAt: "2026-01-02T00:00:00Z",
        }));
        const options: MediaInputOptions = {
          mode,
          nativeModel: model,
          observe,
        };
        const input = {
          key: `test-${mode}`,
          scope: f.scope,
          refs: f.refs,
          model,
          sources: f.db.mediaSources,
          resources: f.resources,
          options,
        };
        const messages = await prepareHeavyMedia(input);
        const serialized = JSON.stringify(messages);
        const marker = JSON.parse(
          (messages[0]!.content as { type: string; text: string }[])[0]!.text,
        );
        expect(marker.mediaInput.mode).toBe(mode);
        if (mode === "native")
          expect(serialized).toContain(png.toString("base64"));
        else expect(serialized).not.toContain('"type":"file"');
        expect(observe).toHaveBeenCalledTimes(mode === "external" ? 1 : 0);
        if (mode === "external") {
          expect(serialized).toContain("derived-visual-observation");
          expect(serialized).toContain("vision/test");
        }
        f.resources.values.clear();
        const unavailable = vi.fn(async () => {
          throw new Error("must not reprocess");
        });
        const replay = await prepareHeavyMedia({
          ...input,
          options: { mode: "external", observe: unavailable },
        });
        expect(replay).toEqual(messages);
        expect(unavailable).not.toHaveBeenCalled();
      },
    );
    it("rejects cross-scope refs, omits excess media, and preserves failures without fallback", async () => {
      const f = await fixture();
      const observe = vi.fn(async () => {
        throw new Error("private-provider-detail");
      });
      const denied = await prepareHeavyMedia({
        key: "denied",
        scope: "another",
        refs: f.refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: { mode: "native", nativeModel: model, observe },
      });
      expect(JSON.stringify(denied)).toContain("unauthorized");
      expect(JSON.stringify(denied)).not.toContain("sha256:");
      expect(observe).not.toHaveBeenCalled();
      const failed = await prepareHeavyMedia({
        key: "failed",
        scope: f.scope,
        refs: f.refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: { mode: "external", observe },
      });
      expect(JSON.stringify(failed)).toContain("vision-unavailable");
      expect(JSON.stringify(failed)).not.toContain("private-provider-detail");
      expect(JSON.stringify(failed)).not.toContain('"type":"file"');
      const refs: MediaReference[] = Array.from(
        { length: 5 },
        () => f.refs[0]!,
      );
      const budget = await prepareHeavyMedia({
        key: "budget",
        scope: f.scope,
        refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: { mode: "off" },
      });
      expect(JSON.stringify(budget.at(-1))).toContain("omitted");
    });
    it("keeps ordered animation frames and blocks unapproved native models", async () => {
      const f = await fixture();
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const segments = await ingestMediaContent(
        { ...f.input, platformMessageId: "animation" },
        f.db.mediaSources,
        f.resources,
        { mode: "off", acquire: async () => gif },
      );
      const refs = segments!.flatMap((s) =>
        s.kind === "media" ? [s.media] : [],
      );
      const options: MediaInputOptions = {
        mode: "native",
        nativeModel: model,
        decodeAnimation: async () => [
          { bytes: png, mimeType: "image/png", atMs: 0 },
          { bytes: png, mimeType: "image/png", atMs: 100 },
        ],
      };
      const input = {
        key: "animation",
        scope: f.scope,
        refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options,
      };
      const messages = await prepareHeavyMedia(input);
      const parts = messages[0]!.content as { type: string; text?: string }[];
      expect(parts.filter((p) => p.type === "file")).toHaveLength(2);
      expect(
        JSON.parse(parts[0]!.text!).mediaInput.frames.map(
          (f: { atMs: number }) => f.atMs,
        ),
      ).toEqual([0, 100]);
      await expect(
        prepareHeavyMedia({
          ...input,
          key: "wrong-model",
          model: { providerId: "other", modelId: "other" },
        }),
      ).rejects.toThrow("media-native-model-unapproved");
    });
    it("reappends frozen media independently of tool transcript text budgets", async () => {
      const f = await fixture();
      const imageMessages = await prepareHeavyMedia({
        key: "native-run",
        scope: f.scope,
        refs: f.refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: { mode: "native", nativeModel: model },
      });
      const text = { role: "user" as const, content: "current prompt" };
      const call = {
        role: "assistant" as const,
        content: [
          { type: "tool-call", toolCallId: "one", toolName: "read", input: {} },
        ],
      };
      const result = {
        role: "tool" as const,
        content: [
          {
            type: "tool-result",
            toolCallId: "one",
            toolName: "read",
            output: { type: "json", value: { ok: true } },
          },
        ],
      };
      expect(
        withoutFrozenMediaInput([text, ...imageMessages, call, result]),
      ).toEqual([text, call, result]);
      f.resources.values.clear();
      expect(
        await prepareHeavyMedia({
          key: "native-run",
          scope: f.scope,
          refs: f.refs,
          model,
          sources: f.db.mediaSources,
          resources: f.resources,
          options: { mode: "off" },
        }),
      ).toEqual(imageMessages);
    });
    it("preserves static WebP MIME and rejects mismatched animation frames before vision", async () => {
      const f = await fixture();
      const webp = await sharp(png).webp().toBuffer();
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const ingest = async (id: string, bytes: Buffer) =>
        (await ingestMediaContent(
          { ...f.input, platformMessageId: id },
          f.db.mediaSources,
          f.resources,
          { mode: "off", acquire: async () => bytes },
        ))!.flatMap((s) => (s.kind === "media" ? [s.media] : []));
      const refs = await ingest("webp", webp);
      const messages = await prepareHeavyMedia({
        key: "webp",
        scope: f.scope,
        refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: { mode: "native", nativeModel: model },
      });
      expect(JSON.stringify(messages)).toContain(webp.toString("base64"));
      const animation = await ingest("gif", gif);
      const observe = vi.fn(async () => ({
        text: "should not run",
        modelIdentity: "v",
        completedAt: "2026-01-01T00:00:00Z",
      }));
      const failed = await prepareHeavyMedia({
        key: "bad-frame-mime",
        scope: f.scope,
        refs: animation,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: {
          mode: "external",
          observe,
          decodeAnimation: async () => [
            { bytes: png, mimeType: "image/jpeg", atMs: 0 },
          ],
        },
      });
      expect(JSON.stringify(failed)).toContain("vision-unavailable");
      expect(JSON.stringify(failed)).not.toContain('"type":"file"');
      expect(observe).not.toHaveBeenCalled();
    });
    it("reports unsupported APNG explicitly and preserves its stable source reference", async () => {
      const f = await fixture();
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEACgAAwQzaBAAAABFmZEFUAAAAAnicY2D4z/AfAAQBAf9i5+mcAAAAAElFTkSuQmCC",
        "base64",
      );
      const segments = await ingestMediaContent(
        { ...f.input, platformMessageId: "apng" },
        f.db.mediaSources,
        f.resources,
        { mode: "off", acquire: async () => bytes },
      );
      const refs = segments!.flatMap((s) =>
        s.kind === "media" ? [s.media] : [],
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]!.status).toBe("unavailable");
      const observe = vi.fn();
      const messages = await prepareHeavyMedia({
        key: "apng",
        scope: f.scope,
        refs,
        model,
        sources: f.db.mediaSources,
        resources: f.resources,
        options: { mode: "external", observe },
      });
      expect(JSON.stringify(messages)).toContain("unavailable");
      expect(JSON.stringify(messages)).not.toContain('"type":"file"');
      expect(observe).not.toHaveBeenCalled();
    });
    it("rejects unordered or oversized frames without consuming the next media budget", async () => {
      const f = await fixture();
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const segments = await ingestMediaContent(
        { ...f.input, platformMessageId: "budget-animation" },
        f.db.mediaSources,
        f.resources,
        { mode: "off", acquire: async () => gif },
      );
      const animation = segments!.flatMap((s) =>
        s.kind === "media" ? [s.media] : [],
      );
      // Valid PNG followed by inert padding exercises the encoded-byte limit independently of pixel size.
      const large = Buffer.concat([png, Buffer.alloc(7 * 1024 * 1024)]);
      for (const [name, frames] of [
        [
          "order",
          [
            { bytes: png, mimeType: "image/png" as const, atMs: 1 },
            { bytes: png, mimeType: "image/png" as const, atMs: 0 },
          ],
        ],
        [
          "bytes",
          [0, 100, 200].map((atMs) => ({
            bytes: large,
            mimeType: "image/png" as const,
            atMs,
          })),
        ],
      ] as const) {
        const messages = await prepareHeavyMedia({
          key: name,
          scope: f.scope,
          refs: [...animation, ...f.refs],
          model,
          sources: f.db.mediaSources,
          resources: f.resources,
          options: {
            mode: "native",
            nativeModel: model,
            decodeAnimation: async () => frames,
          },
        });
        expect(JSON.stringify(messages[0])).toContain("vision-unavailable");
        expect(JSON.stringify(messages[0])).not.toContain('"type":"file"');
        expect(JSON.stringify(messages[1])).toContain(png.toString("base64"));
      }
    });
    it("marks invalid and unavailable media while preserving source identity", async () => {
      const f = await fixture();
      const invalid = await ingestMediaContent(
        { ...f.input, platformMessageId: "invalid" },
        f.db.mediaSources,
        f.resources,
        { mode: "off", acquire: async () => Buffer.from("not an image") },
      );
      expect(JSON.stringify(invalid)).toContain("invalid");
      const absent = await ingestMediaContent(
        { ...f.input, platformMessageId: "missing" },
        f.db.mediaSources,
        undefined,
      );
      expect(JSON.stringify(absent)).toContain("unavailable");
    });
  });
