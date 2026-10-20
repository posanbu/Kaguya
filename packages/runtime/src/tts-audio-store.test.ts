import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
  unlink,
  utimes,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TtsAudioStore } from "./tts-audio-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kaguya-tts-test-"));
  roots.push(root);
  const store = await TtsAudioStore.open(root);
  const bytes = Buffer.alloc(48, 1);
  const audio = {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "audio/wav" as const,
    durationMs: 1,
    synthesizedText: "test",
  };
  return { root, store, audio, task: "a".repeat(64) };
}
it("persists across store instances and atomically reuses a task winner", async () => {
  const f = await fixture();
  const [one, two] = await Promise.all([
    f.store.save(f.task, f.audio),
    f.store.save(f.task, f.audio),
  ]);
  expect(one).toEqual(two);
  const reopened = await TtsAudioStore.open(f.root);
  expect(await reopened.find(f.task)).toEqual(one);
  expect(await reopened.bytes(one)).toEqual(f.audio.bytes);
});
it("detects missing and corrupted audio without returning unchecked bytes", async () => {
  const f = await fixture();
  const resource = await f.store.save(f.task, f.audio);
  await writeFile(
    join(f.root, `${resource.resourceId}.wav`),
    Buffer.alloc(48, 2),
  );
  expect(await f.store.find(f.task)).toBeUndefined();
  await unlink(join(f.root, `${resource.resourceId}.wav`));
  expect(await f.store.exists(resource)).toBe(false);
});
it("rejects arbitrary paths and mismatched digests", async () => {
  const f = await fixture();
  await expect(f.store.find("../outside")).rejects.toThrow(
    "Invalid TTS resource identifier",
  );
  await expect(
    f.store.save(f.task, { ...f.audio, sha256: "b".repeat(64) }),
  ).rejects.toThrow("digest mismatch");
});

it("cleans expired artifacts but protects recently read audio and foreign files", async () => {
  const f = await fixture();
  const resource = await f.store.save(f.task, f.audio);
  const old = new Date(Date.now() - 2 * 86400000);
  await utimes(join(f.root, `${resource.resourceId}.wav`), old, old);
  await utimes(join(f.root, `${f.task}.json`), old, old);
  await writeFile(join(f.root, "keep.txt"), "unrelated");
  // Reading during the retry window refreshes the protected artifact and its index.
  expect(await f.store.find(f.task)).toEqual(resource);
  await f.store.prune();
  expect(await f.store.find(f.task)).toEqual(resource);
  await utimes(join(f.root, `${resource.resourceId}.wav`), old, old);
  await utimes(join(f.root, `${f.task}.json`), old, old);
  await f.store.prune();
  expect(await f.store.find(f.task)).toBeUndefined();
  expect(await readdir(f.root)).toEqual(["keep.txt"]);
});
it("enforces quotas without deleting active artifacts, including concurrent stores", async () => {
  const f = await fixture();
  const store = await TtsAudioStore.open(f.root, { maxFiles: 2 });
  const second = await TtsAudioStore.open(f.root, { maxFiles: 2 });
  const results = await Promise.allSettled([
    store.save(f.task, f.audio),
    second.save("b".repeat(64), f.audio),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await readdir(f.root)).length).toBe(2);
  const small = await TtsAudioStore.open(f.root, { maxBytes: 44 });
  await expect(small.save("c".repeat(64), f.audio)).rejects.toThrow("quota");
  expect(await store.find(f.task)).toBeDefined();
});
