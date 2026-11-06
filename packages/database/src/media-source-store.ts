/**
 * 功能概述：独立于 Memory 持久化媒体来源授权及 Heavy 输入快照；字节复用 SDK MediaResourceStore。
 * prepareMediaSourceSchema 幂等准备附加表；PostgresMediaSourceStore.put 按原消息位置登记不可变来源。
 * read 强制匹配完整 scene 范围；freeze 保存同请求第一个已提交输入，恢复不重新识图或读取素材。
 * 数据库只保存稳定引用和冻结输入，不保存平台临时 URL；相同摘要不能赋予另一会话读取权限。
 */
import { isDeepStrictEqual } from "node:util";
import {
  mediaReferenceSchema,
  type MediaReference,
  type JsonValue,
} from "@kaguya/schema";
import type { SqlDatabase } from "./driver.js";
export async function prepareMediaSourceSchema(db: SqlDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS media_resources (
      resource_id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
      bytes BYTEA NOT NULL CHECK(octet_length(bytes)>0 AND octet_length(bytes)<=16777216),
      touched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS media_sources (
      media_id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_key TEXT NOT NULL,
      metadata JSONB NOT NULL, UNIQUE(scope, source_key)
    );
    CREATE TABLE IF NOT EXISTS media_input_snapshots (
      request_key TEXT PRIMARY KEY, scope TEXT NOT NULL, snapshot JSONB NOT NULL
    );
  `);
}
export class PostgresMediaSourceStore {
  constructor(private readonly db: SqlDatabase) {}
  async put(
    scope: string,
    sourceKey: string,
    value: MediaReference,
  ): Promise<MediaReference> {
    const media = mediaReferenceSchema.parse(value);
    await this.db.query(
      "INSERT INTO media_sources(media_id,scope,source_key,metadata) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [media.mediaId, scope, sourceKey, JSON.stringify(media)],
    );
    const row = (
      await this.db.query<{
        scope: string;
        source_key: string;
        metadata: unknown;
      }>(
        "SELECT scope,source_key,metadata FROM media_sources WHERE media_id=$1",
        [media.mediaId],
      )
    ).rows[0];
    if (
      !row ||
      row.scope !== scope ||
      row.source_key !== sourceKey ||
      !isDeepStrictEqual(row.metadata, media)
    )
      throw new Error("media-source-conflict");
    return media;
  }
  async read(
    mediaId: string,
    scope: string,
  ): Promise<MediaReference | undefined> {
    const row = (
      await this.db.query<{ metadata: unknown }>(
        "SELECT metadata FROM media_sources WHERE media_id=$1 AND scope=$2",
        [mediaId, scope],
      )
    ).rows[0];
    return row ? mediaReferenceSchema.parse(row.metadata) : undefined;
  }
  async freeze<T extends JsonValue>(
    key: string,
    scope: string,
    create: () => Promise<T>,
  ): Promise<T> {
    const read = async () =>
      (
        await this.db.query<{ scope: string; snapshot: T }>(
          "SELECT scope,snapshot FROM media_input_snapshots WHERE request_key=$1",
          [key],
        )
      ).rows[0];
    const existing = await read();
    if (existing) {
      if (existing.scope !== scope)
        throw new Error("media-snapshot-scope-conflict");
      return existing.snapshot;
    }
    // 创建发生在事务外，允许受控 ModelTask 使用自身账本；并发创建者共用稳定 key。
    const snapshot = await create();
    await this.db.query(
      "INSERT INTO media_input_snapshots(request_key,scope,snapshot) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [key, scope, JSON.stringify(snapshot)],
    );
    const winner = await read();
    if (!winner || winner.scope !== scope)
      throw new Error("media-snapshot-scope-conflict");
    return winner.snapshot;
  }
}
