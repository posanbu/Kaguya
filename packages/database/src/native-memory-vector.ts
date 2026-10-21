/** Revision-bound pgvector projections. Failures affect only the configured auxiliary channel. */
/** Revision-bound pgvector projections. Failures affect only the configured auxiliary channel. */
import { createHash } from "node:crypto";
import {
  nativeMemoryNodeSchema,
  validateEmbedding,
  embeddingIdentityKey,
  type MemoryAuxiliaryRetriever,
  type NativeEmbeddingSource,
  type MemoryReadContext,
} from "@kaguya/memory";
import type { SqlDatabase } from "./driver.js";
export class PostgresNativeVectorRetriever implements MemoryAuxiliaryRetriever {
  readonly identity: string;
  readonly role: "semantic" | "language";
  private prepared = false;
  private indexing: Promise<void> | undefined;
  constructor(
    private readonly db: SqlDatabase,
    private readonly source: NativeEmbeddingSource,
  ) {
    this.role = source.role;
    this.identity = embeddingIdentityKey(source.provider.identity);
  }
  private async prepare() {
    if (this.prepared) return;
    await this.db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS memory_native_vectors (
        node_id uuid NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        role text NOT NULL, model_identity text NOT NULL, revision integer NOT NULL,
        input_hash text NOT NULL, embedding vector NOT NULL,
        PRIMARY KEY(node_id,role,model_identity)
      )`);
    this.prepared = true;
  }
  async index(signal?: AbortSignal) {
    if (signal?.aborted) return;
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      await this.record("rebuilding");
      try {
        const more = await this.build(signal);
        await this.record(more ? "rebuilding" : "ready");
      } catch (error) {
        await this.record("degraded");
        throw error;
      }
    })().finally(() => {
      this.indexing = undefined;
    });
    return this.indexing;
  }
  private async record(status: string) {
    await this.db.query(
      `INSERT INTO memory_native_stages(stage,status) VALUES($1,$2)
      ON CONFLICT(stage) DO UPDATE SET status=EXCLUDED.status,updated_at=now()`,
      [this.role, status],
    );
  }
  private async build(lifetime?: AbortSignal) {
    lifetime?.throwIfAborted();
    await this.prepare();
    const pending = await this.db.query<{
      id: string;
      metadata: unknown;
      content: string;
    }>(
      `
      SELECT n.* FROM memory_nodes n LEFT JOIN memory_native_vectors v
        ON v.node_id=n.id AND v.role=$1 AND v.model_identity=$2
      WHERE n.metadata->>'system'='native-v1' AND n.metadata->>'status'='active'
        AND (v.revision IS NULL OR v.revision<>(n.metadata->>'revision')::int)
      ORDER BY n.id LIMIT 50`,
      [this.role, this.identity],
    );
    for (const row of pending.rows) {
      const node = nativeMemoryNodeSchema.parse(row);
      const input = `${node.metadata.aliases.join(" ")}\n${node.metadata.tags.join(" ")}\n${node.content}`;
      lifetime?.throwIfAborted();
      const signal = lifetime
        ? AbortSignal.any([
            lifetime,
            AbortSignal.timeout(this.source.timeoutMs),
          ])
        : AbortSignal.timeout(this.source.timeoutMs);
      const vector = await this.embed(input, signal);
      signal.throwIfAborted();
      await this.db.query(
        `INSERT INTO memory_native_vectors(node_id,role,model_identity,revision,input_hash,embedding)
        SELECT id,$2,$3,$4,$5,$6::vector FROM memory_nodes WHERE id=$1
          AND (metadata->>'revision')::int=$4 AND metadata->>'status'='active'
        ON CONFLICT(node_id,role,model_identity) DO UPDATE SET revision=EXCLUDED.revision,
          input_hash=EXCLUDED.input_hash,embedding=EXCLUDED.embedding`,
        [
          node.id,
          this.role,
          this.identity,
          node.metadata.revision,
          createHash("sha256").update(input).digest("hex"),
          JSON.stringify(vector),
        ],
      );
    }
    return pending.rows.length === 50;
  }
  private async embed(text: string, signal: AbortSignal) {
    return new Promise<readonly number[]>((resolve, reject) => {
      const aborted = () => reject(new Error("Memory embedding timeout"));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      this.source.provider
        .embed(text, signal)
        .then((v) => {
          try {
            resolve(validateEmbedding(v, this.source.provider.identity));
          } catch (e) {
            reject(e);
          }
        }, reject)
        .finally(() => signal.removeEventListener("abort", aborted));
    });
  }
  async search(input: MemoryReadContext, signal: AbortSignal) {
    if (!input.query.trim()) return [];
    // Querying must not build an index or make DDL part of the retrieval deadline.
    if (!this.prepared) throw new Error("Memory vector index is rebuilding");
    const started = Date.now();
    const vector = await this.embed(
      input.query,
      AbortSignal.any([signal, AbortSignal.timeout(this.source.timeoutMs)]),
    );
    signal.throwIfAborted();
    const result = await this.db.transaction(async (tx) => {
      signal.throwIfAborted();
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, this.source.timeoutMs - (Date.now() - started))}ms`,
      ]);
      return tx.query<{
        id: string;
        metadata: unknown;
        content: string;
      }>(
        `
      SELECT n.* FROM memory_native_vectors v JOIN memory_nodes n ON n.id=v.node_id
      WHERE v.role=$1 AND v.model_identity=$2 AND v.revision=(n.metadata->>'revision')::int
        AND n.metadata->>'system'='native-v1' AND n.metadata->>'status'='active'
        AND (n.metadata->>'occurredAt')::timestamptz<=$5::timestamptz
        AND (n.metadata->>'scope'=$3 OR (n.metadata->>'scope'='shared'
          AND n.metadata->>'ownerId'=ANY($4::text[]) AND n.metadata->>'kind' IN ('person','self','expression')))
      ORDER BY v.embedding <=> $6::vector,n.id LIMIT 50`,
        [
          this.role,
          this.identity,
          input.scope,
          [...input.owners],
          input.asOf,
          JSON.stringify(vector),
        ],
      );
    });
    return result.rows.map((r) => nativeMemoryNodeSchema.parse(r));
  }
}
