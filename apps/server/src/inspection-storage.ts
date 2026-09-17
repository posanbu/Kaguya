/**
 * 功能概述：把真实 Memory 文档与向量索引转成有界检查记录，与 Information 历史区分。
 * readInspectionStorage 仅接受 Manifest 指定的 storage；文档复用仓储分页，向量只读元数据。
 * 由 inspection.ts 调用并统一脱敏，所有游标校验失败返回固定错误，不回显数据库内容。
 * 只执行 GET 所需读取；available=false 表示可选向量表不存在，不表示有一个空向量库。
 */
import { inspectMemoryVectors, type KaguyaDatabase } from "@kaguya/database";
import { z } from "@kaguya/schema";
const vectorCursor = z
  .object({
    memoryId: z.string(),
    modelId: z.string(),
    revision: z.string(),
    dimensions: z.number().int().positive(),
  })
  .strict();
export async function readInspectionStorage(
  database: KaguyaDatabase,
  storage: "memory" | "vectors",
  query: { cursor?: string | undefined; limit: number },
) {
  if (storage === "memory") {
    const docs = await database.memory.listDocuments({
      limit: query.limit + 1,
      ...(query.cursor ? { afterMemoryId: query.cursor } : {}),
    });
    const page = docs.slice(0, query.limit);
    return {
      version: 1,
      available: true,
      title: "原始记忆文档库",
      description:
        "真实持久化文档，按文档 ID 稳定分页；库为全局共享，不按当前模块启用状态清空。",
      items: page.map((d) => ({
        id: d.memoryId,
        sourceInformationId: d.sourceInformationId,
        fields: [
          { label: "正文", value: d.content },
          { label: "平台", value: d.address.platform },
          { label: "适配器", value: d.address.adapterId },
          { label: "会话", value: d.address.destination },
          { label: "账号", value: d.address.accountId },
          { label: "发生时间", value: d.occurredAt },
          { label: "写入时间", value: d.createdAt },
        ],
      })),
      nextCursor: docs.length > query.limit ? page.at(-1)!.memoryId : null,
    };
  }
  let cursor: z.infer<typeof vectorCursor> | undefined;
  if (query.cursor) {
    try {
      cursor = vectorCursor.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new StorageCursorError();
    }
  }
  const result = await inspectMemoryVectors(database.sql, {
    limit: query.limit + 1,
    ...(cursor ? { cursor } : {}),
  });
  const page = result.items.slice(0, query.limit);
  const last = page.at(-1);
  return {
    version: 1,
    available: result.available,
    title: "向量索引库",
    description:
      "真实索引记录；显示模型版本与维度，不加载向量值。历史模型索引不代表当前运行模型。",
    items: page.map((v) => ({
      id: JSON.stringify([v.memoryId, v.modelId, v.revision, v.dimensions]),
      sourceInformationId: v.sourceInformationId,
      fields: [
        { label: "文档", value: v.memoryId },
        { label: "模型", value: v.modelId },
        { label: "版本", value: v.revision },
        { label: "维度", value: v.dimensions },
      ],
    })),
    nextCursor:
      result.items.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              memoryId: last.memoryId,
              modelId: last.modelId,
              revision: last.revision,
              dimensions: last.dimensions,
            }),
          ).toString("base64url")
        : null,
  };
}
export class StorageCursorError extends Error {
  constructor() {
    super("invalid_storage_cursor");
  }
}
