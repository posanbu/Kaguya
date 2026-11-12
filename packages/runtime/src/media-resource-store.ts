/**
 * 功能概述：提供旧版文件媒体仓储，按 SHA-256 保存字节；来源授权由媒体来源表另行校验。
 * 主要职责：put 冻结调用方字节并校验摘要、幂等与 MIME；get 有界读取并复核元数据；
 * cleanupExpired 在保留检查后重验修改时间，保护新写入与待投递资源，delete 删除指定摘要。
 * 代码库关系：实现 SDK MediaResourceStore，作为 PostgreSQL 仓储的旧数据回退，Runtime 注入保留谓词。
 * 输入输出与副作用：仅在受控根目录读写摘要文件，拒绝符号链接与非普通文件，原子替换私有文件；
 * 同一进程内共享根目录的实例串行写入和读取。跨进程必须由宿主保证单一文件仓储写入者。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MediaResource,
  MediaResourceInput,
  MediaResourceStore,
} from "@kaguya/sdk";

const RESOURCE_ID = /^sha256:([a-f0-9]{64})$/u;
const operations = new Map<string, Promise<unknown>>();

export class FileMediaResourceStore implements MediaResourceStore {
  private readonly root: string;
  constructor(
    root: string,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid media resource size limit");
    this.root = resolve(root);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = (operations.get(this.root) ?? Promise.resolve()).then(
      operation,
      operation,
    );
    operations.set(this.root, current);
    const release = () => {
      if (operations.get(this.root) === current) operations.delete(this.root);
    };
    void current.then(release, release);
    return current;
  }

  private async prepareRoot(create = false): Promise<void> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new Error("Invalid media resource directory");
  }

  async put(input: MediaResourceInput): Promise<void> {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxBytes)
      throw new Error("Media resource size is outside the allowed range");
    // Copy before the first await: an adapter may reuse its input buffer.
    const value = { ...input, bytes: Uint8Array.from(input.bytes) };
    const hash = parseResourceId(value.resourceId);
    if (!value.mimeType || value.mimeType.length > 100)
      throw new Error("Invalid media resource MIME type");
    const actual = createHash("sha256").update(value.bytes).digest("hex");
    if (actual !== hash || actual !== value.sha256)
      throw new Error("Media resource checksum mismatch");
    await this.exclusive(async () => {
      await this.prepareRoot(true);
      const existing = await this.read(value.resourceId);
      if (existing) {
        if (existing.mimeType !== value.mimeType)
          throw new Error("Media resource metadata conflict");
        const now = new Date();
        await utimes(join(this.root, `${hash}.bin`), now, now);
        return;
      }
      await this.write(`${hash}.bin`, value.bytes);
      await this.write(
        `${hash}.json`,
        JSON.stringify({
          resourceId: value.resourceId,
          mimeType: value.mimeType,
          sha256: hash,
        }),
      );
    });
  }

  private async write(name: string, value: string | Uint8Array): Promise<void> {
    const destination = join(this.root, name);
    await regularFile(destination, true);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(resourceId: string): Promise<MediaResource | undefined> {
    parseResourceId(resourceId);
    return this.exclusive(() => this.read(resourceId));
  }

  private async read(resourceId: string): Promise<MediaResource | undefined> {
    const hash = parseResourceId(resourceId);
    try {
      await this.prepareRoot();
      const [bytes, raw] = await Promise.all([
        readBounded(join(this.root, `${hash}.bin`), this.maxBytes),
        readBounded(join(this.root, `${hash}.json`), 1024),
      ]);
      const metadata = JSON.parse(raw.toString("utf8")) as {
        resourceId?: unknown;
        mimeType?: unknown;
        sha256?: unknown;
      };
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (
        actual !== hash ||
        metadata.resourceId !== resourceId ||
        metadata.sha256 !== hash ||
        typeof metadata.mimeType !== "string" ||
        !metadata.mimeType ||
        metadata.mimeType.length > 100
      )
        throw new Error("Stored media resource failed integrity validation");
      return { resourceId, bytes, mimeType: metadata.mimeType, sha256: hash };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(resourceId: string): Promise<void> {
    const hash = parseResourceId(resourceId);
    return this.exclusive(async () => {
      try {
        await this.prepareRoot();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await this.remove(hash);
    });
  }

  private async remove(hash: string): Promise<void> {
    await Promise.all([
      rm(join(this.root, `${hash}.bin`), { force: true }),
      rm(join(this.root, `${hash}.json`), { force: true }),
    ]);
  }

  async cleanupExpired(
    olderThan: Date,
    isRetained?: (resourceId: string) => Promise<boolean>,
  ): Promise<number> {
    if (!Number.isFinite(olderThan.getTime()))
      throw new Error("Invalid media expiration cutoff");
    const names = await this.exclusive(async () => {
      await this.prepareRoot(true);
      return readdir(this.root);
    });
    let removed = 0;
    for (const name of names) {
      const resource = /^[a-f0-9]{64}\.bin$/u.test(name);
      const temporary =
        /^[a-f0-9]{64}\.(bin|json)\.\d+\.[a-f0-9-]+\.tmp$/u.test(name);
      if (!resource && !temporary) continue;
      const hash = name.slice(0, 64);
      const before = await this.exclusive(() =>
        regularFile(join(this.root, name), true),
      );
      if (!before || before.mtime >= olderThan) continue;
      // Do not hold the file lock while consulting the ledger: a concurrent put must be able to refresh it.
      if (resource && (await isRetained?.(`sha256:${hash}`))) continue;
      removed += await this.exclusive(async () => {
        await this.prepareRoot();
        const current = await regularFile(join(this.root, name), true);
        if (
          !current ||
          current.mtime >= olderThan ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs ||
          current.ino !== before.ino
        )
          return 0;
        if (temporary) {
          await rm(join(this.root, name), { force: true });
          return 0;
        }
        await this.remove(hash);
        return 1;
      });
    }
    return removed;
  }
}

async function regularFile(path: string, missing = false) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Invalid media resource file");
    return metadata;
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  await regularFile(path);
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > limit)
      throw new Error(
        "Stored media resource size is outside the allowed range",
      );
    const buffer = Buffer.alloc(metadata.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total !== metadata.size)
      throw new Error("Stored media resource changed during read");
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

function parseResourceId(resourceId: string): string {
  const match = RESOURCE_ID.exec(resourceId);
  if (!match) throw new Error("Invalid media resource ID");
  return match[1]!;
}
