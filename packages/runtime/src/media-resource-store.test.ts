import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
