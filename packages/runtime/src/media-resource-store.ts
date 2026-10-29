/** 文件型媒体资源存储。资源 ID 只允许内容寻址的 SHA-256，不接受调用方路径。 */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  MediaResource,
  MediaResourceInput,
  MediaResourceStore,
} from "@kaguya/sdk";

const RESOURCE_ID = /^sha256:([a-f0-9]{64})$/u;

export class FileMediaResourceStore implements MediaResourceStore {
  constructor(
    private readonly root: string,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  async put(input: MediaResourceInput): Promise<void> {
    const hash = parseResourceId(input.resourceId);
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxBytes)
      throw new Error("Media resource size is outside the allowed range");
    const actual = createHash("sha256").update(input.bytes).digest("hex");
    if (actual !== hash || actual !== input.sha256)
      throw new Error("Media resource checksum mismatch");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const dataPath = join(this.root, `${hash}.bin`);
    const metadataPath = join(this.root, `${hash}.json`);
    const temporary = `${dataPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, dataPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    } finally {
      await rm(temporary, { force: true });
    }
    await writeFile(
      metadataPath,
      JSON.stringify({
        resourceId: input.resourceId,
        mimeType: input.mimeType,
        sha256: input.sha256,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }

  async get(resourceId: string): Promise<MediaResource | undefined> {
    const hash = parseResourceId(resourceId);
    try {
      const dataSize = (await stat(join(this.root, `${hash}.bin`))).size;
      const metadataSize = (await stat(join(this.root, `${hash}.json`))).size;
      if (dataSize < 1 || dataSize > this.maxBytes || metadataSize > 1024)
        throw new Error(
          "Stored media resource size is outside the allowed range",
        );
      const [bytes, raw] = await Promise.all([
        readFile(join(this.root, `${hash}.bin`)),
        readFile(join(this.root, `${hash}.json`), "utf8"),
      ]);
      const metadata = JSON.parse(raw) as {
        mimeType?: unknown;
        sha256?: unknown;
      };
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (
        actual !== hash ||
        metadata.sha256 !== hash ||
        typeof metadata.mimeType !== "string"
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
    await Promise.all([
      rm(join(this.root, `${hash}.bin`), { force: true }),
      rm(join(this.root, `${hash}.json`), { force: true }),
    ]);
  }

  async cleanupExpired(
    olderThan: Date,
    isRetained?: (resourceId: string) => Promise<boolean>,
  ): Promise<number> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = await readdir(this.root);
    for (const name of names.filter((item) =>
      /^[a-f0-9]{64}\.bin\.\d+\.[a-f0-9-]+\.tmp$/u.test(item),
    )) {
      if ((await stat(join(this.root, name))).mtime < olderThan)
        await rm(join(this.root, name), { force: true });
    }
    let removed = 0;
    for (const name of names.filter((item) =>
      /^[a-f0-9]{64}\.bin$/u.test(item),
    )) {
      const hash = name.slice(0, 64);
      if ((await stat(join(this.root, name))).mtime >= olderThan) continue;
      if (await isRetained?.(`sha256:${hash}`)) continue;
      await this.delete(`sha256:${hash}`);
      removed += 1;
    }
    return removed;
  }
}

function parseResourceId(resourceId: string): string {
  const match = RESOURCE_ID.exec(resourceId);
  if (!match) throw new Error("Invalid media resource ID");
  return match[1]!;
}
