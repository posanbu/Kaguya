/**
 * 功能概述：在宿主专用目录中持久化 TTS 音频和任务到产物的索引。
 * 主要职责：内容寻址、原子发布、读取完整性校验；不接受客户端文件路径。
 * 代码库关系：提供 TtsHost 的 find/save/exists；音频不进入信息总线。
 * 输入输出与副作用：写入受控目录；访问时清理超过保留期的产物；配额满时拒绝新产物，不驱逐有效文件。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  link,
  unlink,
  realpath,
  readdir,
  utimes,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { audioResourceSchema, type AudioResource } from "@kaguya/schema";
import type { TtsAudio } from "@kaguya/llm";

export interface TtsStorageOptions {
  readonly retentionMs?: number;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly now?: () => number;
}
const locks = new Map<string, Promise<unknown>>();
export class TtsAudioStore {
  private options = {
    retentionMs: 86400000,
    maxBytes: 512 * 1024 * 1024,
    maxFiles: 10000,
    now: Date.now,
  };
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.root) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    locks.set(this.root, pending);
    try {
      return await pending;
    } finally {
      if (locks.get(this.root) === pending) locks.delete(this.root);
    }
  }
  async prune(): Promise<void> {
    await this.locked(() => this.pruneInternal());
  }
  private async pruneInternal(): Promise<void> {
    const cutoff = this.options.now() - this.options.retentionMs;
    for (const name of await readdir(this.root)) {
      if (!/^(?:[a-f0-9]{64}\.(?:wav|json)|\.[a-f0-9-]+\.tmp)$/u.test(name))
        continue;
      const path = join(this.root, name);
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff)
        await unlink(path);
    }
  }
  async save(taskKey: string, audio: TtsAudio): Promise<AudioResource> {
    const frozen = { ...audio, bytes: Buffer.from(audio.bytes) };
    return this.locked(async () => {
      await this.pruneInternal();
      const existing = await this.findInternal(taskKey);
      if (existing) return existing;
      let bytes = 0;
      let files = 0;
      for (const name of await readdir(this.root)) {
        const stat = await lstat(join(this.root, name));
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Invalid TTS storage entry");
        bytes += stat.size;
        files++;
      }
      if (
        bytes + frozen.bytes.length + 4096 > this.options.maxBytes ||
        files + 2 > this.options.maxFiles
      )
        throw new Error("TTS storage quota exceeded");
      return this.saveInternal(taskKey, frozen);
    });
  }
  async find(taskKey: string): Promise<AudioResource | undefined> {
    return this.locked(() => this.findInternal(taskKey));
  }
  async bytes(resource: AudioResource): Promise<Buffer | undefined> {
    return this.locked(() => this.bytesInternal(resource));
  }
  async exists(resource: AudioResource): Promise<boolean> {
    return this.locked(() => this.existsInternal(resource));
  }

  private constructor(private readonly root: string) {}
  static async open(
    root: string,
    options: TtsStorageOptions = {},
  ): Promise<TtsAudioStore> {
    const path = resolve(root);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid TTS storage root");
    const store = new TtsAudioStore(await realpath(path));
    store.options = { ...store.options, ...options };
    if (
      !Number.isSafeInteger(store.options.retentionMs) ||
      store.options.retentionMs < 3600000 ||
      !Number.isSafeInteger(store.options.maxBytes) ||
      store.options.maxBytes < 44 ||
      !Number.isSafeInteger(store.options.maxFiles) ||
      store.options.maxFiles < 2
    )
      throw new Error("Invalid TTS storage limits");
    await store.prune();
    return store;
  }
  private path(id: string, suffix: "wav" | "json"): string {
    if (!/^[a-f0-9]{64}$/u.test(id))
      throw new Error("Invalid TTS resource identifier");
    return join(this.root, `${id}.${suffix}`);
  }
  private async read(path: string, max: number): Promise<Buffer | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
        throw new Error("Invalid TTS resource");
      const handle = await open(path, "r");
      try {
        const actual = await handle.stat();
        if (!actual.isFile() || actual.size > max || actual.ino !== stat.ino)
          throw new Error("Invalid TTS resource");
        const buffer = Buffer.alloc(actual.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== actual.size)
          throw new Error("Invalid TTS resource size");
        return buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async publish(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // hard link 原子发布且不覆盖已有赢家；不需要 Windows 符号链接权限。
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary);
    }
  }
  private async saveInternal(
    taskKey: string,
    audio: TtsAudio,
  ): Promise<AudioResource> {
    this.path(taskKey, "json");
    const bytes = Buffer.from(audio.bytes);
    const resource = audioResourceSchema.parse({
      resourceId: audio.sha256,
      mimeType: audio.mimeType,
      byteLength: bytes.byteLength,
      durationMs: audio.durationMs,
    });
    if (
      createHash("sha256").update(bytes).digest("hex") !== resource.resourceId
    )
      throw new Error("TTS audio digest mismatch");
    await this.publish(this.path(resource.resourceId, "wav"), bytes);
    if (!(await this.existsInternal(resource)))
      throw new Error("TTS audio publication failed");
    await this.publish(
      this.path(taskKey, "json"),
      Buffer.from(JSON.stringify(resource)),
    );
    const winner = await this.findInternal(taskKey);
    if (!winner) throw new Error("TTS artifact publication failed");
    return winner;
  }
  private async findInternal(
    taskKey: string,
  ): Promise<AudioResource | undefined> {
    const data = await this.read(this.path(taskKey, "json"), 4096);
    if (!data) return undefined;
    const resource = audioResourceSchema.parse(
      JSON.parse(data.toString("utf8")),
    );
    if (!(await this.existsInternal(resource))) return undefined;
    const date = new Date(this.options.now());
    await utimes(this.path(taskKey, "json"), date, date);
    return resource;
  }
  private async bytesInternal(
    resource: AudioResource,
  ): Promise<Buffer | undefined> {
    const checked = audioResourceSchema.parse(resource);
    const bytes = await this.read(
      this.path(checked.resourceId, "wav"),
      checked.byteLength,
    );
    if (
      !bytes ||
      bytes.length !== checked.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== checked.resourceId
    )
      return undefined;
    const date = new Date(this.options.now());
    await utimes(this.path(checked.resourceId, "wav"), date, date);
    return bytes;
  }
  private async existsInternal(resource: AudioResource): Promise<boolean> {
    return (await this.bytesInternal(resource)) !== undefined;
  }
}
