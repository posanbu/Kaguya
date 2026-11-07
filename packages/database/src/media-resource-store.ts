/**
 * 功能概述：SDK 通用媒体仓储的 PostgreSQL 字节后端，图片与 TTS 共用摘要寻址、完整性和保留规则。
 * put 校验摘要并幂等写入/刷新保留时间；get 复核字节并兼容读取旧文件后端；来源权限由 media_sources 另行校验。
 * cleanupExpired 有界分页且在删除时复查写入时间与持久来源，调用宿主 retention guard 保护行动恢复。
 * 来源审计记录没有过期契约；即使省略 guard，删除语句可见的持久来源也会阻止按字节 TTL 清理。
 * get 的旧后端回退还核对请求身份，防止把另一份摘要有效的资源作为当前请求返回。
 * prepareMediaSourceSchema 拥有表结构；本类不临时建表、不读路径，不把相同摘要视为读取授权。
 */
import { createHash } from "node:crypto";
import type {
  MediaResource,
  MediaResourceInput,
  MediaResourceStore,
} from "@kaguya/sdk";
import type { SqlDatabase } from "./driver.js";
const maxBytes = 16 * 1024 * 1024;
const idPattern = /^sha256:([a-f0-9]{64})$/;
export class PostgresMediaResourceStore implements MediaResourceStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly legacy?: MediaResourceStore,
  ) {}
  async put(input: MediaResourceInput): Promise<void> {
    this.validate(input);
    await this.db.query(
      `INSERT INTO media_resources(resource_id,mime_type,sha256,bytes,touched_at) VALUES($1,$2,$3,$4,now())
      ON CONFLICT(resource_id) DO UPDATE SET touched_at=now() WHERE media_resources.mime_type=EXCLUDED.mime_type AND media_resources.sha256=EXCLUDED.sha256 AND media_resources.bytes=EXCLUDED.bytes`,
      [
        input.resourceId,
        input.mimeType,
        input.sha256,
        Buffer.from(input.bytes),
      ],
    );
    const saved = await this.get(input.resourceId);
    if (
      !saved ||
      saved.mimeType !== input.mimeType ||
      !Buffer.from(saved.bytes).equals(Buffer.from(input.bytes))
    )
      throw new Error("media-resource-conflict");
  }
  async get(resourceId: string): Promise<MediaResource | undefined> {
    if (!idPattern.test(resourceId))
      throw new Error("media-resource-id-invalid");
    const row = (
      await this.db.query<{
        mime_type: string;
        sha256: string;
        bytes: Uint8Array;
      }>(
        "SELECT mime_type,sha256,bytes FROM media_resources WHERE resource_id=$1",
        [resourceId],
      )
    ).rows[0];
    const value = row
      ? {
          resourceId,
          mimeType: row.mime_type,
          sha256: row.sha256,
          bytes: Uint8Array.from(row.bytes),
        }
      : await this.legacy?.get(resourceId);
    if (value) {
      this.validate(value);
      if (value.resourceId !== resourceId)
        throw new Error("media-resource-integrity-invalid");
    }
    return value;
  }
  async delete(resourceId: string): Promise<void> {
    if (!idPattern.test(resourceId))
      throw new Error("media-resource-id-invalid");
    await this.db.query("DELETE FROM media_resources WHERE resource_id=$1", [
      resourceId,
    ]);
    await this.legacy?.delete(resourceId);
  }
  async cleanupExpired(
    olderThan: Date,
    isRetained?: (id: string) => Promise<boolean>,
  ): Promise<number> {
    let cursor = "",
      removed = 0;
    while (true) {
      const rows = (
        await this.db.query<{ resource_id: string }>(
          "SELECT resource_id FROM media_resources WHERE touched_at<$1 AND resource_id>$2 ORDER BY resource_id LIMIT 100",
          [olderThan.toISOString(), cursor],
        )
      ).rows;
      for (const row of rows) {
        cursor = row.resource_id;
        if (await isRetained?.(cursor)) continue;
        removed +=
          (
            await this.db.query(
              `DELETE FROM media_resources WHERE resource_id=$1 AND touched_at<$2
          AND NOT EXISTS (SELECT 1 FROM media_sources WHERE metadata->>'resourceId'=media_resources.resource_id)`,
              [cursor, olderThan.toISOString()],
            )
          ).rowCount ?? 0;
      }
      if (rows.length < 100) break;
    }
    return (
      removed +
      ((await this.legacy?.cleanupExpired(olderThan, async (id) => {
        const referenced = await this.db.query(
          "SELECT 1 FROM media_sources WHERE metadata->>'resourceId'=$1 LIMIT 1",
          [id],
        );
        return (
          referenced.rows.length > 0 || ((await isRetained?.(id)) ?? false)
        );
      })) ?? 0)
    );
  }
  private validate(value: MediaResourceInput) {
    const hash = idPattern.exec(value.resourceId)?.[1];
    if (
      !hash ||
      value.bytes.byteLength < 1 ||
      value.bytes.byteLength > maxBytes ||
      value.mimeType.length > 100 ||
      !value.mimeType ||
      value.sha256 !== hash ||
      createHash("sha256").update(value.bytes).digest("hex") !== hash
    )
      throw new Error("media-resource-integrity-invalid");
  }
}
