/**
 * 功能概述：定义可替换 embedding、可重建向量索引与稳定混合召回的版本化边界。
 * EmbeddingProvider 只接收文本和 abort signal；MemoryVectorIndex 按完整模型身份保存/检索。
 * HybridMemoryRecall 在相同检索过滤下分别获取 sparse/vector Top-K，再按 RRF 与 memoryId 融合；
 * embedding/索引不可用仅退化到 sparse，正文、query、密钥及 provider 错误均不进入日志。
 * MemoryDocumentReader 为后台任务提供有界 keyset 分页，避免用召回接口扫描全库。
 */
import { awaitWithSignal } from "./cognition.js";
import { defineModuleCapability } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import {
  parseMemoryRecallQuery,
  type MemoryDocument,
  type MemoryRecall,
  type MemoryRecallHit,
  type MemoryRecallQuery,
} from "./contracts.js";
export const embeddingIdentitySchema = z
  .object({
    modelId: z.string().min(1),
    revision: z.string().min(1),
    dimensions: z.number().int().min(1).max(16000),
  })
  .strict();
export type EmbeddingIdentity = Readonly<
  z.infer<typeof embeddingIdentitySchema>
>;
export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  embed(text: string, signal: AbortSignal): Promise<readonly number[]>;
}
export const embeddingCapability = defineModuleCapability<EmbeddingProvider>(
  "kaguya:memory.embedding",
  1,
);
export interface MemoryDocumentReader {
  getBySource(sourceInformationId: string): Promise<MemoryDocument | undefined>;
  listDocuments(input: {
    readonly afterMemoryId?: string;
    readonly limit: number;
  }): Promise<readonly MemoryDocument[]>;
}
export const memoryDocumentReaderCapability =
  defineModuleCapability<MemoryDocumentReader>("kaguya:memory.documents", 1);
export interface MemoryVectorIndex {
  putVector(
    memoryId: string,
    identity: EmbeddingIdentity,
    vector: readonly number[],
  ): Promise<void>;
  recallVector(
    query: MemoryRecallQuery,
    identity: EmbeddingIdentity,
    vector: readonly number[],
  ): Promise<readonly MemoryRecallHit[]>;
}
export const memoryVectorCapability = defineModuleCapability<MemoryVectorIndex>(
  "kaguya:memory.vector",
  1,
);
export function validateEmbedding(
  vector: readonly number[],
  identity: EmbeddingIdentity,
): readonly number[] {
  embeddingIdentitySchema.parse(identity);
  if (
    vector.length !== identity.dimensions ||
    !vector.every(Number.isFinite) ||
    vector.every((value) => value === 0)
  )
    throw new Error("Invalid embedding vector");
  return vector;
}
export function embeddingIdentityKey(identity: EmbeddingIdentity): string {
  const parsed = embeddingIdentitySchema.parse(identity);
  return JSON.stringify([parsed.modelId, parsed.revision, parsed.dimensions]);
}
export class HybridMemoryRecall implements MemoryRecall {
  constructor(
    private readonly sparse: MemoryRecall,
    private readonly index: MemoryVectorIndex,
    private readonly provider: EmbeddingProvider,
    private readonly timeoutMs = 30_000,
  ) {}
  async recall(input: MemoryRecallQuery): Promise<readonly MemoryRecallHit[]> {
    const query = parseMemoryRecallQuery(input);
    const sparse = await this.sparse.recall(query);
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const vector = validateEmbedding(
        await awaitWithSignal(this.provider.embed(query.query, signal), signal),
        this.provider.identity,
      );
      const dense = await this.index.recallVector(
        query,
        this.provider.identity,
        vector,
      );
      return fuseMemoryRanks(sparse, dense, query.limit);
    } catch {
      return sparse;
    }
  }
}
export function fuseMemoryRanks(
  sparse: readonly MemoryRecallHit[],
  dense: readonly MemoryRecallHit[],
  limit: number,
): readonly MemoryRecallHit[] {
  const candidates = new Map<string, MemoryRecallHit>();
  for (const hits of [sparse, dense]) {
    const seen = new Set<string>();
    for (const [rank, hit] of hits.entries()) {
      const id = hit.document.memoryId;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.set(id, {
        document: hit.document,
        score: (candidates.get(id)?.score ?? 0) + 1 / (60 + rank + 1),
      });
    }
  }
  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.document.memoryId < b.document.memoryId
          ? -1
          : a.document.memoryId > b.document.memoryId
            ? 1
            : 0),
    )
    .slice(0, limit);
}
