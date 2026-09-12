/**
 * 功能概述：以 pgvector 保存独立、可重建的 Memory 向量，canonical 文档不发生修改。
 * PostgresMemoryVectorIndex.prepare 在显式启用后幂等安装可选扩展/表；缺失扩展由宿主降级。
 * putVector 按 memoryId + model/revision/dimensions 幂等写入；recallVector 复用 sparse 的
 * 原生 key、截止时间与排除条件，在相同模型身份内按 cosine distance 与 memoryId 排序。
 * 仅参数化 SQL 执行 I/O，错误不包含正文或向量；不读取模型密钥，也不调用 embedding。
 */
import {
  embeddingIdentitySchema,
  parseMemoryRecallQuery,
  validateEmbedding,
  type EmbeddingIdentity,
  type MemoryRecallHit,
  type MemoryRecallQuery,
  type MemoryVectorIndex,
} from "@kaguya/memory";
import type { SqlDatabase } from "./driver.js";
import {
  memoryRecallPredicates,
  rowToDocument,
  type MemoryDocumentRow,
} from "./memory-store.js";
export class PostgresMemoryVectorIndex implements MemoryVectorIndex {
  constructor(private readonly database: SqlDatabase) {}
  async prepare(): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.exec("CREATE EXTENSION IF NOT EXISTS vector");
      await tx.exec(`CREATE TABLE IF NOT EXISTS memory_document_vectors (
        memory_id text NOT NULL REFERENCES memory_documents(memory_id) ON DELETE CASCADE,
        model_id text NOT NULL, revision text NOT NULL, dimensions integer NOT NULL CHECK (dimensions > 0),
        embedding vector NOT NULL CHECK (vector_dims(embedding) = dimensions),
        PRIMARY KEY(memory_id, model_id, revision, dimensions)
      )`);
    });
  }
  async putVector(
    memoryId: string,
    identity: EmbeddingIdentity,
    vector: readonly number[],
  ): Promise<void> {
    validateEmbedding(vector, identity);
    await this.database.query(
      `INSERT INTO memory_document_vectors(memory_id, model_id, revision, dimensions, embedding)
      VALUES ($1,$2,$3,$4,$5::vector) ON CONFLICT (memory_id,model_id,revision,dimensions) DO NOTHING`,
      [
        memoryId,
        identity.modelId,
        identity.revision,
        identity.dimensions,
        JSON.stringify(vector),
      ],
    );
  }
  async recallVector(
    input: MemoryRecallQuery,
    identity: EmbeddingIdentity,
    vector: readonly number[],
  ): Promise<readonly MemoryRecallHit[]> {
    const query = parseMemoryRecallQuery(input);
    embeddingIdentitySchema.parse(identity);
    validateEmbedding(vector, identity);
    const values: unknown[] = [
      identity.modelId,
      identity.revision,
      identity.dimensions,
      JSON.stringify(vector),
    ];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const predicates = memoryRecallPredicates(query, bind);
    const result = await this.database.query<
      MemoryDocumentRow & { score: number }
    >(
      `SELECT d.*, 1 - (v.embedding <=> $4::vector) AS score
      FROM memory_document_vectors v JOIN memory_documents d ON d.memory_id = v.memory_id
      WHERE v.model_id = $1 AND v.revision = $2 AND v.dimensions = $3 ${predicates.map((p) => `AND ${p}`).join(" ")}
      ORDER BY v.embedding <=> $4::vector, d.memory_id ASC LIMIT ${bind(query.limit)}`,
      values,
    );
    return result.rows.map((row) => ({
      document: rowToDocument(row),
      score: Number(row.score),
    }));
  }
}
