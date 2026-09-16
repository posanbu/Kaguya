/**
 * 功能概述：为控制台提供只读向量索引元数据页，不读取高维向量。
 * inspectMemoryVectors 检查可选表是否存在，按文档/模型/版本/维度复合游标稳定分页。
 * 由 Server 的 inspection-storage 调用，SqlDatabase 负责参数绑定；不安装扩展、不修改数据。
 * 缺表返回 available=false；数据库故障向上传递，由 HTTP 层输出安全错误。
 */
import type { SqlDatabase } from "./driver.js";
export type MemoryVectorInspectionRow = {
  memoryId: string;
  sourceInformationId: string;
  modelId: string;
  revision: string;
  dimensions: number;
};
export async function inspectMemoryVectors(
  database: SqlDatabase,
  input: {
    limit: number;
    cursor?: {
      memoryId: string;
      modelId: string;
      revision: string;
      dimensions: number;
    };
  },
) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 51)
    throw new Error("Invalid inspection limit");
  const exists = await database.query<{ present: boolean }>(
    "SELECT to_regclass('memory_document_vectors') IS NOT NULL AS present",
  );
  if (!exists.rows[0]?.present) return { available: false, items: [] };
  const c = input.cursor;
  const result = await database.query<MemoryVectorInspectionRow>(
    `SELECT v.memory_id AS "memoryId", d.source_information_id AS "sourceInformationId",
      v.model_id AS "modelId", v.revision, v.dimensions
     FROM memory_document_vectors v JOIN memory_documents d ON d.memory_id = v.memory_id
     ${c ? "WHERE (v.memory_id, v.model_id, v.revision, v.dimensions) > ($2, $3, $4, $5)" : ""}
     ORDER BY v.memory_id, v.model_id, v.revision, v.dimensions LIMIT $1`,
    c
      ? [input.limit, c.memoryId, c.modelId, c.revision, c.dimensions]
      : [input.limit],
  );
  return { available: true, items: result.rows };
}
