/**
 * 功能概述：验证文件媒体的摘要、不可变元数据、路径安全与过期清理并发。
 * 主要职责：用独立临时目录驱动 FileMediaResourceStore，检查持久重开、重复写入、损坏、
 * 符号链接拒绝，以及保留检查期间刷新资源不被删除；真实完成 Promise 作为同步边界。
 * 代码库关系：与数据库后端共享 SDK 契约，afterEach 完整删除临时目录；不调用外部服务。
 */
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMediaResourceStore } from "./media-resource-store.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("FileMediaResourceStore", () => {
  it("persists content-addressed bytes and rejects forged checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
    roots.push(root);
    const store = new FileMediaResourceStore(root, 1024);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await store.put({
      resourceId: `sha256:${sha256}`,
      bytes,
      mimeType: "audio/wav",
      sha256,
    });
    await expect(store.get(`sha256:${sha256}`)).resolves.toMatchObject({
      mimeType: "audio/wav",
      sha256,
    });
    await expect(
      store.put({
        resourceId: `sha256:${"0".repeat(64)}`,
        bytes,
        mimeType: "audio/wav",
        sha256,
      }),
    ).rejects.toThrow(/checksum/u);
  });
  it("retains expired resources until their delivery or retry window closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
    roots.push(root);
    const store = new FileMediaResourceStore(root);
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const resourceId = `sha256:${sha256}`;
    const input = { resourceId, bytes, mimeType: "audio/wav", sha256 };
    await Promise.all([store.put(input), store.put(input)]);
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(join(root, `${sha256}.bin`), old, old);
    expect(
      await store.cleanupExpired(new Date(), async (id) => id === resourceId),
    ).toBe(0);
    expect(await store.get(resourceId)).toBeDefined();
    expect(await store.cleanupExpired(new Date(), async () => false)).toBe(1);
    expect(await store.get(resourceId)).toBeUndefined();
    await store.delete(resourceId);
  });
  it("rejects paths and corrupted stored bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
    roots.push(root);
    const store = new FileMediaResourceStore(root);
    await expect(store.get("../private-file")).rejects.toThrow(
      "Invalid media resource ID",
    );
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await store.put({
      resourceId: `sha256:${sha256}`,
      bytes,
      mimeType: "audio/wav",
      sha256,
    });
    await writeFile(join(root, `${sha256}.bin`), new Uint8Array([4, 5, 6]));
    await expect(store.get(`sha256:${sha256}`)).rejects.toThrow("integrity");
  });
});

it("freezes caller bytes, reopens resources and rejects conflicting MIME without replacing metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
  roots.push(root);
  const store = new FileMediaResourceStore(root);
  const bytes = Uint8Array.from([1, 2, 3]);
  const original = bytes.slice();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const value = {
    resourceId: `sha256:${sha256}`,
    bytes,
    sha256,
    mimeType: "audio/wav",
  };
  const writing = store.put(value);
  bytes.fill(9);
  await writing;
  const reopened = new FileMediaResourceStore(root);
  expect(await reopened.get(value.resourceId)).toEqual({
    ...value,
    bytes: Buffer.from(original),
  });
  await expect(
    reopened.put({ ...value, bytes: original, mimeType: "image/png" }),
  ).rejects.toThrow("metadata conflict");
  expect((await store.get(value.resourceId))!.mimeType).toBe("audio/wav");
  expect((await readdir(root)).sort()).toEqual([
    `${sha256}.bin`,
    `${sha256}.json`,
  ]);
});

it("rechecks an expired resource after a concurrent refresh from another store instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
  roots.push(root);
  const store = new FileMediaResourceStore(root);
  const bytes = Uint8Array.from([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const value = {
    resourceId: `sha256:${sha256}`,
    bytes,
    sha256,
    mimeType: "audio/wav",
  };
  await store.put(value);
  const old = new Date("2020-01-01");
  await utimes(join(root, `${sha256}.bin`), old, old);
  const removed = await store.cleanupExpired(
    new Date("2021-01-01"),
    async () => {
      await new FileMediaResourceStore(root).put(value);
      return false;
    },
  );
  expect(removed).toBe(0);
  expect(await store.get(value.resourceId)).toMatchObject({ sha256 });
});

it("rejects a symlink resource without reading or replacing its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
  roots.push(root);
  const store = new FileMediaResourceStore(root);
  const bytes = Uint8Array.from([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const value = {
    resourceId: `sha256:${sha256}`,
    bytes,
    sha256,
    mimeType: "audio/wav",
  };
  await store.put(value);
  const target = join(root, "private-target");
  await writeFile(target, bytes);
  await rm(join(root, `${sha256}.bin`));
  await symlink(target, join(root, `${sha256}.bin`));
  await expect(store.get(value.resourceId)).rejects.toThrow(
    "Invalid media resource file",
  );
  await expect(store.put(value)).rejects.toThrow("Invalid media resource file");
  expect(await readFile(target)).toEqual(Buffer.from(bytes));
});

it("rejects swapped resource metadata and oversized on-disk bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-media-"));
  roots.push(root);
  const store = new FileMediaResourceStore(root, 3);
  const bytes = Uint8Array.from([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const value = {
    resourceId: `sha256:${sha256}`,
    bytes,
    sha256,
    mimeType: "audio/wav",
  };
  await store.put(value);
  await writeFile(
    join(root, `${sha256}.json`),
    JSON.stringify({
      ...value,
      resourceId: `sha256:${"0".repeat(64)}`,
      bytes: undefined,
    }),
  );
  await expect(store.get(value.resourceId)).rejects.toThrow(
    "integrity validation",
  );
  await writeFile(join(root, `${sha256}.bin`), Uint8Array.from([1, 2, 3, 4]));
  await expect(store.get(value.resourceId)).rejects.toThrow("size is outside");
});
