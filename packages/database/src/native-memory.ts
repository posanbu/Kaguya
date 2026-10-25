/** Transactional native graph publication and scoped PostgreSQL retrieval. */
/** Transactional native graph publication and scoped PostgreSQL retrieval. */
import { randomUUID, createHash } from "node:crypto";
import {
  memoryPublicationSchema,
  nativeMemoryNodeSchema,
  nativeMemorySnapshotSchema,
  memoryTerms,
  memoryFuzzyTerms,
  memoryEditDistance,
  NATIVE_MEMORY_REVISION_KIND,
  MEMORY_ANALYZER_VERSION,
  type MemoryPublication,
  type NativeMemoryNode,
  type NativeMemoryStore,
  type MemoryReadContext,
  type BasicMemoryObservation,
  type MemoryCandidate,
  type MemoryFormationAccess,
  type MemorySource,
  type MemoryPersonBinding,
  memorySourceSchema,
  type MemoryBatch,
  type MemoryPeopleInput,
} from "@kaguya/memory";
import { informationAtomSchema, freezeInformationAtom } from "@kaguya/schema";
import { appendInformationAtom } from "./information-repository.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  return value;
}
export class NativeMemoryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export async function prepareNativeMemorySchema(tx: SqlTransaction) {
  await tx.exec(`
    CREATE TABLE IF NOT EXISTS memory_native_epoch (
      id boolean PRIMARY KEY DEFAULT true CHECK(id),
      started_at timestamptz NOT NULL DEFAULT now(),
      source_after bigint NOT NULL
    );
    INSERT INTO memory_native_epoch(id,source_after)
      SELECT true,COALESCE(max(position),0) FROM information_lifecycle ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS memory_native_sources (
      id text PRIMARY KEY, scope text NOT NULL, source jsonb NOT NULL,
      ordinal bigserial NOT NULL, batch_id uuid
    );
    CREATE TABLE IF NOT EXISTS memory_native_batches (
      id uuid PRIMARY KEY, scope text NOT NULL, sources jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_native_pending_batch
      ON memory_native_batches(scope) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS memory_native_stages (
      stage text PRIMARY KEY, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_native_summary_unique
      ON memory_nodes ((metadata->>'ownerId'), (metadata->>'scope'))
      WHERE metadata->>'system'='native-v1' AND metadata->>'status'='active'
        AND metadata->>'level'='0';
    CREATE TABLE IF NOT EXISTS memory_native_publications (
      operation_id text PRIMARY KEY,
      input_hash text NOT NULL,
      information_id text NOT NULL,
      nodes jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memory_native_search (
      node_id uuid PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE,
      revision integer NOT NULL,
      analyzer text NOT NULL,
      document tsvector NOT NULL,
      terms text[] NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_native_search_document ON memory_native_search USING gin(document);
    CREATE INDEX IF NOT EXISTS memory_native_search_terms ON memory_native_search USING gin(terms);
  `);
}
type Row = Record<string, unknown> & {
  id: string;
  metadata: unknown;
  content: string;
};
const parse = (rows: Row[]) =>
  rows.map((row) => nativeMemoryNodeSchema.parse(row));
const eligible = (alias = "n") => `${alias}.metadata->>'system'='native-v1'
  AND ${alias}.metadata->>'status'='active'
  AND (${alias}.metadata->>'occurredAt')::timestamptz <= $3::timestamptz
  AND (${alias}.metadata->>'scope'=$1 OR
    (${alias}.metadata->>'scope'='shared' AND ${alias}.metadata->>'ownerId'=ANY($2::text[])
      AND ${alias}.metadata->>'kind' IN ('person','self','expression')))`;
const params = (input: MemoryReadContext) => [
  input.scope,
  [...input.owners],
  input.asOf,
];

export class PostgresNativeMemoryStore
  implements NativeMemoryStore, MemoryFormationAccess
{
  constructor(private readonly db: SqlDatabase) {}
  async published(operationId: string) {
    return (
      await this.db.query<{ nodes: NativeMemoryNode[] }>(
        "SELECT nodes FROM memory_native_publications WHERE operation_id=$1",
        [operationId],
      )
    ).rows[0]?.nodes;
  }
  async status() {
    const counts = (
      await this.db.query<{
        queued: number;
        pending: number;
        rejected: number;
        nodes: number;
        fixed: number;
      }>(`SELECT
      (SELECT count(*)::int FROM memory_native_sources WHERE batch_id IS NULL) queued,
      (SELECT count(*)::int FROM memory_native_batches WHERE status='pending') pending,
      (SELECT count(*)::int FROM memory_native_batches WHERE status IN ('rejected','failed')) rejected,
      (SELECT count(*)::int FROM memory_nodes WHERE metadata->>'system'='native-v1' AND metadata->>'status'='active') nodes,
      (SELECT count(*)::int FROM memory_nodes WHERE metadata->>'system'='native-v1' AND metadata->>'status'='active' AND metadata->>'level'='0') fixed
    `)
    ).rows[0]!;
    const stages = (
      await this.db.query(
        "SELECT stage,status,updated_at FROM memory_native_stages ORDER BY stage",
      )
    ).rows;
    const rows = await this.db.query<{
      information_id: string;
      memory: unknown;
    }>(
      `SELECT information_id,payload->'frame'->'memory' memory FROM information_atoms WHERE kind='agent.situation.frozen' AND payload->'frame' ? 'memory' ORDER BY occurred_at DESC,information_id DESC LIMIT 10`,
    );
    const snapshots = rows.rows.map((row) => {
      const memory = nativeMemorySnapshotSchema.parse(row.memory);
      return {
        id: row.information_id,
        frozenAt: memory.frozenAt,
        status: memory.status,
        fixed: memory.fixed.length,
        recalled: memory.recalled.length,
        degraded: memory.degraded,
      };
    });
    const batches = (
      await this.db.query<{ id: string; scope: string; status: string }>(
        "SELECT id,scope,status FROM memory_native_batches WHERE status IN ('failed','rejected') ORDER BY created_at DESC LIMIT 20",
      )
    ).rows;
    return { counts, stages, snapshots, batches };
  }
  async retry(batchId: string) {
    return this.db.transaction(async (tx) => {
      const batch = (
        await tx.query<{ scope: string; status: string }>(
          "SELECT scope,status FROM memory_native_batches WHERE id=$1 FOR UPDATE",
          [batchId],
        )
      ).rows[0];
      if (!batch || !["failed", "rejected"].includes(batch.status))
        throw new NativeMemoryError("memory_batch_not_retryable");
      const context = (
        await tx.query<{ target_information_id: string }>(
          `SELECT r.target_information_id FROM information_atoms a JOIN information_references r ON r.information_id=a.information_id AND r.relation='core:context' WHERE a.kind='memory.native.formation.requested.v1' AND a.payload->>'batchId'=$1 LIMIT 1`,
          [batchId],
        )
      ).rows[0];
      if (!context) throw new NativeMemoryError("memory_batch_context_missing");
      await tx.query(
        "UPDATE memory_native_batches SET status='retried' WHERE id=$1",
        [batchId],
      );
      await tx.query(
        "UPDATE memory_native_sources SET batch_id=NULL WHERE batch_id=$1",
        [batchId],
      );
      const informationId = randomUUID(),
        kind = "memory.native.formation.retry.v1";
      await tx.query(
        "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
        [kind],
      );
      await appendInformationAtom(
        tx,
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId,
            kind,
            occurredAt: new Date().toISOString(),
            source: "memory:manual",
            payload: { batchId, scope: batch.scope },
            references: [
              {
                relation: "core:context",
                informationId: context.target_information_id,
              },
            ],
          }),
        ),
        [{ relation: "core:context", required: true, multiple: false }],
        { enqueueLogProjection: false },
      );
      return { informationId };
    });
  }
  async people(input: MemoryPeopleInput): Promise<MemoryPersonBinding[]> {
    const rows = await this.db.query<{ person_id: string; account_id: string }>(
      `
      SELECT DISTINCT a.payload->>'accountId' account_id, b.payload->>'personInformationId' person_id FROM information_atoms a
      JOIN information_references r ON r.target_information_id=a.information_id AND r.relation='core:binds'
      JOIN information_atoms b ON b.information_id=r.information_id
      WHERE a.kind='memory.identity.platform.account.entity' AND b.kind='memory.identity.platform.account.binding'
        AND a.payload->>'platform'=$1 AND a.payload->>'adapterId'=$2 AND a.payload->>'accountId'=ANY($3::text[])`,
      [input.platform, input.adapterId, input.accountIds],
    );
    return rows.rows.map((r) => ({
      accountId: r.account_id,
      ownerId: `person:${r.person_id}`,
    }));
  }
  async withReadSnapshot<T>(
    run: (store: NativeMemoryStore) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.exec(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const readOnly: SqlDatabase = {
        query: tx.query.bind(tx),
        exec: tx.exec.bind(tx),
        transaction: async () => {
          throw new Error("Read-only memory snapshot");
        },
        close: async () => {},
      };
      return run(new PostgresNativeMemoryStore(readOnly));
    });
  }
  async ingest(source: MemorySource) {
    source = memorySourceSchema.parse(source);
    const result = await this.db.query(
      `INSERT INTO memory_native_sources(id,scope,source)
      SELECT $1,$2,$3::jsonb WHERE EXISTS (
        SELECT 1 FROM information_lifecycle a,memory_native_epoch e WHERE a.information_id=$1 AND a.position>e.source_after
      ) ON CONFLICT DO NOTHING RETURNING id`,
      [source.id, source.scope, JSON.stringify(source)],
    );
    return result.rows.length > 0;
  }
  async claim(
    scope: string,
    force: boolean,
    asOf?: string,
  ): Promise<MemoryBatch | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,71493))",
        [scope],
      );
      const pending = (
        await tx.query<MemoryBatch & Record<string, unknown>>(
          "SELECT id,scope,sources FROM memory_native_batches WHERE scope=$1 AND status='pending'",
          [scope],
        )
      ).rows[0];
      if (pending) {
        const sources = await this.restoreSourceProvenance(tx, pending.sources);
        if (sources !== pending.sources)
          await tx.query(
            "UPDATE memory_native_batches SET sources=$2::jsonb WHERE id=$1",
            [pending.id, JSON.stringify(sources)],
          );
        return { ...pending, sources };
      }
      const storedSources = (
        await tx.query<{ source: MemorySource }>(
          "SELECT source FROM memory_native_sources WHERE scope=$1 AND batch_id IS NULL ORDER BY ordinal LIMIT 24 FOR UPDATE",
          [scope],
        )
      ).rows.map((r) => r.source);
      const sources = await this.restoreSourceProvenance(tx, storedSources);
      if (!sources.length) return undefined;
      const readyAt =
        Date.parse(sources[0]!.collectedAt ?? sources[0]!.occurredAt) + 60_000;
      if (
        sources.length < 8 &&
        (!force || asOf !== undefined) &&
        readyAt > Date.parse(asOf ?? new Date().toISOString())
      )
        return undefined;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO memory_native_batches(id,scope,sources) VALUES($1,$2,$3::jsonb)",
        [id, scope, JSON.stringify(sources)],
      );
      await tx.query(
        "UPDATE memory_native_sources SET batch_id=$1 WHERE id=ANY($2::text[])",
        [id, sources.map((s) => s.id)],
      );
      return { id, scope, sources };
    });
  }
  private async restoreSourceProvenance(
    tx: SqlTransaction,
    sources: MemorySource[],
  ): Promise<MemorySource[]> {
    let changed = false;
    const restored: MemorySource[] = [];
    for (const source of sources) {
      if (
        source.sourceType !== undefined ||
        source.participants !== undefined ||
        source.replyTo !== undefined
      ) {
        restored.push(memorySourceSchema.parse(source));
        continue;
      }
      // Only the historical shape is upgraded, using its immutable original atom.
      const atom = (
        await tx.query<{ kind: string; payload: Record<string, any> }>(
          "SELECT kind,payload FROM information_atoms WHERE information_id=$1",
          [source.id],
        )
      ).rows[0];
      if (
        !atom ||
        !["core.message.inbound.text", "core.delivery.delivered"].includes(
          atom.kind,
        )
      )
        throw new NativeMemoryError("memory_source_provenance_unavailable");
      const inbound = atom.kind === "core.message.inbound.text";
      const raw = atom.payload.source;
      if (inbound && (!raw || typeof raw.senderId !== "string"))
        throw new NativeMemoryError("memory_source_provenance_unavailable");
      const replyTo =
        inbound && raw.replyTo
          ? {
              platformMessageId: raw.replyTo.platformMessageId,
              senderId: raw.replyTo.senderId ?? null,
            }
          : null;
      const normalized = memorySourceSchema.parse({
        ...source,
        sourceType: inbound ? "inbound" : "delivered",
        participants: inbound
          ? [
              {
                accountId: raw.senderId,
                ownerId: source.ownerId.startsWith("person:")
                  ? source.ownerId
                  : null,
                role: "speaker",
                nickname: raw.sender?.nickname ?? null,
                card: raw.sender?.card ?? null,
              },
              ...(raw.mentions ?? [])
                .filter((m: { kind: string }) => m.kind === "user")
                .map((m: { id: string }) => ({
                  accountId: m.id,
                  ownerId: null,
                  role: "mentioned",
                  nickname: null,
                  card: null,
                })),
              ...(replyTo?.senderId
                ? [
                    {
                      accountId: replyTo.senderId,
                      ownerId: null,
                      role: "replied-to",
                      nickname: null,
                      card: null,
                    },
                  ]
                : []),
            ]
          : [],
        replyTo,
      });
      await tx.query(
        "UPDATE memory_native_sources SET source=$2::jsonb WHERE id=$1",
        [source.id, JSON.stringify(normalized)],
      );
      restored.push(normalized);
      changed = true;
    }
    return changed ? restored : sources;
  }
  async finish(id: string, status: "completed" | "rejected" | "failed") {
    await this.db.query(
      "UPDATE memory_native_batches SET status=$2 WHERE id=$1 AND status='pending'",
      [id, status],
    );
  }
  async publish(input: MemoryPublication): Promise<NativeMemoryNode[]> {
    const p = memoryPublicationSchema.parse(input);
    const hash = createHash("sha256")
      .update(JSON.stringify(canonicalJson(p)))
      .digest("hex");
    return this.db
      .transaction(async (tx) => {
        // Graph mutations serialize; summary uniqueness is also enforced independently by PostgreSQL.
        await tx.query("SELECT pg_advisory_xact_lock(7149321)");
        const saved = await tx.query<{
          input_hash: string;
          nodes: NativeMemoryNode[];
        }>(
          "SELECT input_hash,nodes FROM memory_native_publications WHERE operation_id=$1",
          [p.operationId],
        );
        if (saved.rows[0]) {
          if (saved.rows[0].input_hash !== hash)
            throw new NativeMemoryError("memory_operation_conflict");
          return saved.rows[0].nodes;
        }
        const changedIds = p.nodes.map((n) => n.node.id);
        if (new Set(changedIds).size !== changedIds.length)
          throw new NativeMemoryError("memory_duplicate_node", 400);
        for (const { node, expectedRevision } of p.nodes) {
          const current = (
            await tx.query<Row>(
              "SELECT id,metadata,content FROM memory_nodes WHERE id=$1 FOR UPDATE",
              [node.id],
            )
          ).rows[0];
          const previous = current
            ? nativeMemoryNodeSchema.safeParse(current)
            : undefined;
          if (current && !previous?.success)
            throw new NativeMemoryError("memory_legacy_node_readonly");
          if (
            (previous?.success ? previous.data.metadata.revision : 0) !==
              expectedRevision ||
            node.metadata.revision !== expectedRevision + 1
          )
            throw new NativeMemoryError("memory_revision_conflict");
          if (
            p.actor === "automatic" &&
            previous?.success &&
            previous.data.metadata.locked
          )
            throw new NativeMemoryError("memory_node_locked");
          if (
            node.metadata.scope === "shared" &&
            !["person", "self", "expression"].includes(node.metadata.kind)
          )
            throw new NativeMemoryError("memory_invalid_shared_scope", 400);
          if (p.actor === "automatic" && node.metadata.sourceIds.length === 0)
            throw new NativeMemoryError("memory_evidence_required", 400);
          if (node.metadata.sourceIds.length) {
            const evidence = await tx.query<{ information_id: string }>(
              "SELECT information_id FROM information_atoms WHERE information_id=ANY($1::text[])",
              [node.metadata.sourceIds],
            );
            if (
              new Set(evidence.rows.map((r) => r.information_id)).size !==
              new Set(node.metadata.sourceIds).size
            )
              throw new NativeMemoryError("memory_evidence_missing", 400);
            if (p.actor === "automatic") {
              const recent = await tx.query<{ information_id: string }>(
                `SELECT l.information_id FROM information_lifecycle l,
              memory_native_epoch e WHERE l.information_id=ANY($1::text[]) AND l.position>e.source_after`,
                [node.metadata.sourceIds],
              );
              if (
                new Set(recent.rows.map((r) => r.information_id)).size !==
                new Set(node.metadata.sourceIds).size
              )
                throw new NativeMemoryError(
                  "memory_evidence_before_epoch",
                  400,
                );
            }
          }
        }
        const endpointIds = [
          ...new Set(
            [...p.edges, ...p.removeEdges].flatMap((e) => [
              e.sourceId,
              e.targetId,
            ]),
          ),
        ];
        const untouchedEndpoints: NativeMemoryNode[] = [];
        for (const id of endpointIds) {
          if (changedIds.includes(id)) continue;
          const row = (
            await tx.query<Row>(
              "SELECT id,metadata,content FROM memory_nodes WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          const parsed = nativeMemoryNodeSchema.safeParse(row);
          if (!parsed.success)
            throw new NativeMemoryError("memory_invalid_edge", 400);
          if (p.expectedVersions[id] !== parsed.data.metadata.revision)
            throw new NativeMemoryError("memory_revision_conflict");
          if (p.actor === "automatic" && parsed.data.metadata.locked)
            throw new NativeMemoryError("memory_node_locked");
          untouchedEndpoints.push(parsed.data);
        }
        // Release unique-summary slots before a branch is atomically relevelled.
        await tx.query(
          `UPDATE memory_nodes SET metadata=jsonb_set(metadata,'{status}','"invalidated"')
        WHERE id=ANY($1::uuid[])`,
          [changedIds],
        );
        for (const { node } of p.nodes) {
          await tx.query(
            `INSERT INTO memory_nodes(id,metadata,content) VALUES($1,$2::jsonb,$3)
          ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata,content=EXCLUDED.content`,
            [node.id, JSON.stringify(node.metadata), node.content],
          );
          const terms = memoryFuzzyTerms(
            `${node.metadata.aliases.join(" ")} ${node.metadata.tags.join(" ")} ${node.content}`,
          );
          await tx.query(
            `INSERT INTO memory_native_search(node_id,revision,analyzer,document,terms)
          VALUES($1,$2,$3,setweight(to_tsvector('simple',$4),'A') || setweight(to_tsvector('simple',$5),'B') ||
            setweight(to_tsvector('simple',$6),'D'),$7::text[])
          ON CONFLICT(node_id) DO UPDATE SET revision=EXCLUDED.revision,analyzer=EXCLUDED.analyzer,
            document=EXCLUDED.document,terms=EXCLUDED.terms`,
            [
              node.id,
              node.metadata.revision,
              MEMORY_ANALYZER_VERSION,
              memoryTerms(node.metadata.aliases.join(" ")).join(" "),
              memoryTerms(node.metadata.tags.join(" ")).join(" "),
              memoryTerms(node.content).join(" "),
              terms,
            ],
          );
        }
        for (const edge of p.removeEdges)
          await tx.query(
            "DELETE FROM memory_edges WHERE source_id=$1 AND target_id=$2 AND relation=$3",
            [edge.sourceId, edge.targetId, edge.relation],
          );
        for (const edge of p.edges)
          await tx.query(
            `INSERT INTO memory_edges(source_id,target_id,relation,metadata) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(source_id,target_id,relation) DO UPDATE SET metadata=EXCLUDED.metadata`,
            [
              edge.sourceId,
              edge.targetId,
              edge.relation,
              JSON.stringify(edge.metadata),
            ],
          );
        const invalid = await tx.query(`SELECT 1 FROM memory_edges e
        JOIN memory_nodes a ON a.id=e.source_id JOIN memory_nodes b ON b.id=e.target_id
        WHERE (a.metadata->>'system'='native-v1' OR b.metadata->>'system'='native-v1')
        AND (a.metadata->>'system' IS DISTINCT FROM 'native-v1' OR b.metadata->>'system' IS DISTINCT FROM 'native-v1'
          OR (e.relation='summarizes' AND (a.metadata->>'level')::int >= (b.metadata->>'level')::int))
        LIMIT 1`);
        if (invalid.rows.length)
          throw new NativeMemoryError("memory_invalid_edge", 400);
        const summaryParents = new Set(
          [...p.edges, ...p.removeEdges]
            .filter((e) => e.relation === "summarizes")
            .map((e) => e.sourceId),
        );
        const touched: NativeMemoryNode[] = [];
        for (const original of untouchedEndpoints) {
          const node = {
            ...original,
            metadata: {
              ...original.metadata,
              revision: original.metadata.revision + 1,
              status: summaryParents.has(original.id)
                ? ("invalidated" as const)
                : original.metadata.status,
            },
          };
          await tx.query(
            "UPDATE memory_nodes SET metadata=$2::jsonb WHERE id=$1",
            [node.id, JSON.stringify(node.metadata)],
          );
          await tx.query(
            "UPDATE memory_native_search SET revision=$2 WHERE node_id=$1",
            [node.id, node.metadata.revision],
          );
          touched.push(node);
        }
        // Changed evidence invalidates unchanged ancestors; never inject a stale summary.
        const invalidated = await tx.query<Row>(
          `WITH RECURSIVE ancestors(id) AS (
        SELECT source_id FROM memory_edges WHERE relation='summarizes' AND target_id=ANY($1::uuid[])
        UNION SELECT e.source_id FROM memory_edges e JOIN ancestors a ON e.target_id=a.id WHERE e.relation='summarizes'
      ) UPDATE memory_nodes n SET metadata=jsonb_set(jsonb_set(n.metadata,'{status}','"invalidated"'),
        '{revision}',to_jsonb((n.metadata->>'revision')::int+1))
        WHERE n.id IN (SELECT id FROM ancestors) AND NOT(n.id=ANY($1::uuid[]))
        AND n.metadata->>'status'='active' AND n.metadata->>'system'='native-v1'
        RETURNING n.id,n.metadata,n.content`,
          [[...changedIds, ...touched.map((n) => n.id)]],
        );
        const nodes = [
          ...p.nodes.map((item) => item.node),
          ...touched,
          ...parse(invalidated.rows),
        ];
        const informationId = randomUUID();
        await tx.query(
          "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
          [NATIVE_MEMORY_REVISION_KIND],
        );
        await appendInformationAtom(
          tx,
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId,
              kind: NATIVE_MEMORY_REVISION_KIND,
              occurredAt: new Date().toISOString(),
              source: `memory:${p.actor}`,
              payload: {
                operationId: p.operationId,
                nodes,
                edges: p.edges,
                removeEdges: p.removeEdges,
              },
              references: [],
            }),
          ),
          [],
          { enqueueLogProjection: false },
        );
        await tx.query(
          `INSERT INTO memory_native_publications(operation_id,input_hash,information_id,nodes)
        VALUES($1,$2,$3,$4::jsonb)`,
          [p.operationId, hash, informationId, JSON.stringify(nodes)],
        );
        return nodes;
      })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23505"
        )
          throw new NativeMemoryError("memory_summary_conflict");
        throw error;
      });
  }
  async forFormation(input: MemoryReadContext): Promise<NativeMemoryNode[]> {
    // Full bodies are required for revision. Invalidated summaries retain their stable IDs.
    return parse(
      (
        await this.db.query<Row>(
          `SELECT n.* FROM memory_nodes n
      WHERE ${eligible().replace("AND n.metadata->>'status'='active'", "AND n.metadata->>'status' IN ('active','invalidated')")}
      AND n.metadata->>'ownerId'=ANY($2::text[]) ORDER BY (n.metadata->>'level')::int,n.id`,
          params(input),
        )
      ).rows,
    );
  }
  async ensureBasicSummaries(
    input: MemoryReadContext,
    observations: readonly BasicMemoryObservation[],
  ) {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      const store = new PostgresNativeMemoryStore({
        query: tx.query.bind(tx),
        exec: tx.exec.bind(tx),
        transaction: async (run) => run(tx),
        close: async () => {},
      });
      for (const observation of observations) {
        if (
          !input.owners.includes(observation.ownerId) ||
          Date.parse(observation.observedAt) > Date.parse(input.asOf)
        )
          continue;
        // Never replace a manual, locked, invalidated or archived summary during bootstrap.
        const existing = await tx.query(
          `SELECT id FROM memory_nodes WHERE metadata->>'system'='native-v1'
          AND metadata->>'ownerId'=$1 AND metadata->>'level'='0'
          AND metadata->>'scope' IN ($2,'shared') LIMIT 1`,
          [observation.ownerId, input.scope],
        );
        if (existing.rows.length) continue;
        const source = await tx.query<{ payload: Record<string, any> }>(
          `SELECT a.payload FROM information_atoms a JOIN information_lifecycle l USING(information_id), memory_native_epoch e
          WHERE a.information_id=$1 AND a.kind='core.message.inbound.text'
            AND l.position>e.source_after AND a.occurred_at::timestamptz <= $2::timestamptz`,
          [observation.sourceId, input.asOf],
        );
        const inbound = source.rows[0]?.payload;
        if (!inbound || !String(inbound.text ?? "").trim()) continue;
        const scope = inbound.source;
        if (
          !scope ||
          JSON.stringify([
            scope.platform,
            scope.adapterId,
            scope.destination?.kind,
            scope.destination?.userId ??
              scope.destination?.groupId ??
              scope.destination?.conversationId ??
              null,
          ]) !== input.scope
        )
          continue;
        // Only a bound speaker's actual utterance establishes a person encounter.
        if (observation.kind === "person") {
          const bindings = await store.people({
            platform: scope.platform,
            adapterId: scope.adapterId,
            accountIds: [scope.senderId],
          });
          if (!bindings.some((b) => b.ownerId === observation.ownerId))
            continue;
        } else if (observation.ownerId !== `conversation:${input.scope}`)
          continue;
        const id = randomUUID();
        await store.publish({
          operationId: `basic:${createHash("sha256")
            .update(JSON.stringify([observation.ownerId, input.scope]))
            .digest("hex")}`,
          actor: "automatic",
          nodes: [
            {
              expectedRevision: 0,
              node: {
                id,
                content:
                  observation.kind === "person"
                    ? "在此会话中有过交流。背景、偏好和交往关系尚待实际来源补充。"
                    : "此会话已有交流。群体背景和交流习惯尚待实际来源补充。",
                metadata: {
                  system: "native-v1",
                  kind: observation.kind,
                  ownerId: observation.ownerId,
                  scope: input.scope,
                  level: 0,
                  revision: 1,
                  status: "active",
                  locked: false,
                  sourceIds: [observation.sourceId],
                  aliases: observation.name ? [observation.name] : [],
                  tags: [],
                  occurredAt: observation.observedAt,
                },
              },
            },
          ],
          edges: [],
        });
      }
    });
  }
  async personCandidates(input: MemoryReadContext) {
    if (!input.query.trim()) return [];
    const rows = await this.db.query<Row>(
      `SELECT n.* FROM memory_nodes n
      JOIN memory_native_search s ON s.node_id=n.id AND s.revision=(n.metadata->>'revision')::int
      WHERE n.metadata->>'system'='native-v1' AND n.metadata->>'kind'='person'
        AND n.metadata->>'level'='0' AND n.metadata->>'status'='active'
        AND n.metadata->>'scope' IN ($1,'shared')
        AND (n.metadata->>'occurredAt')::timestamptz <= $3::timestamptz
        AND NOT (n.metadata->>'ownerId'=ANY($2::text[])) AND s.terms && $4::text[]
      ORDER BY cardinality(ARRAY(SELECT unnest(s.terms) INTERSECT SELECT unnest($4::text[]))) DESC,n.id LIMIT 5`,
      [...params(input), memoryFuzzyTerms(input.query)],
    );
    return parse(rows.rows).map((summary) => ({
      ownerId: summary.metadata.ownerId,
      summary,
      match: summary.metadata.aliases.some((a) => input.query.includes(a))
        ? ("alias" as const)
        : ("fuzzy" as const),
    }));
  }
  async readFixed(input: MemoryReadContext): Promise<NativeMemoryNode[]> {
    return parse(
      (
        await this.db.query<Row>(
          `SELECT n.* FROM memory_nodes n WHERE ${eligible()}
      AND n.metadata->>'level'='0' AND n.metadata->>'ownerId'=ANY($2::text[]) ORDER BY n.id`,
          params(input),
        )
      ).rows,
    );
  }
  async current(
    input: MemoryReadContext,
    ids: readonly string[],
  ): Promise<NativeMemoryNode[]> {
    return parse(
      (
        await this.db.query<Row>(
          `SELECT n.* FROM memory_nodes n WHERE ${eligible()} AND n.id=ANY($4::uuid[])`,
          [...params(input), ids],
        )
      ).rows,
    );
  }
  async candidates(input: MemoryReadContext): Promise<MemoryCandidate[]> {
    const terms = memoryTerms(input.query);
    const rows = await this.db.query<Row & { channel: string; rank: number }>(
      `
      WITH eligible AS (SELECT n.* FROM memory_nodes n WHERE ${eligible()}),
      explicit AS (SELECT n.*, 'explicit'::text channel,1.0 score FROM eligible n
        WHERE n.id::text=ANY($4::text[]) OR n.metadata->'sourceIds' ?| $4::text[] ORDER BY n.id LIMIT 50),
      graph AS (SELECT n.*, 'entity'::text channel,1.0 score FROM eligible n
        WHERE n.metadata->>'ownerId'=ANY($2::text[]) ORDER BY n.id LIMIT 50),
      lexical AS (SELECT n.*, 'text'::text channel,ts_rank_cd(s.document,plainto_tsquery('simple',$5))::double precision score FROM eligible n JOIN memory_native_search s ON n.id=s.node_id
        WHERE s.revision=(n.metadata->>'revision')::int AND s.document @@ plainto_tsquery('simple',$5)
        ORDER BY ts_rank_cd(s.document,plainto_tsquery('simple',$5)) DESC,n.id LIMIT 50),
      fuzzy AS (SELECT n.*, 'fuzzy'::text channel,cardinality(ARRAY(SELECT unnest(s.terms) INTERSECT SELECT unnest($6::text[])))::double precision score FROM eligible n JOIN memory_native_search s ON n.id=s.node_id
        WHERE s.revision=(n.metadata->>'revision')::int AND s.terms && $6::text[]
        ORDER BY cardinality(ARRAY(SELECT unnest(s.terms) INTERSECT SELECT unnest($6::text[]))) DESC,n.id LIMIT 50)
      SELECT *, row_number() OVER(PARTITION BY channel ORDER BY score DESC,id) AS rank FROM
      (SELECT * FROM explicit UNION ALL SELECT * FROM graph UNION ALL SELECT * FROM lexical UNION ALL SELECT * FROM fuzzy) results`,
      [
        ...params(input),
        input.explicitIds ?? [],
        terms.join(" "),
        memoryFuzzyTerms(input.query),
      ],
    );
    const fuzzy = rows.rows
      .filter((r) => r.channel === "fuzzy")
      .map((r) => {
        const n = nativeMemoryNodeSchema.parse({
          id: r.id,
          metadata: r.metadata,
          content: r.content,
        });
        const words = memoryTerms([...n.metadata.aliases, n.content].join(" "));
        const distance = Math.min(
          3,
          ...terms.flatMap((t) =>
            words.slice(0, 128).map((w) => memoryEditDistance(t, w)),
          ),
        );
        return { r, distance };
      })
      .sort(
        (a, b) =>
          a.distance - b.distance || Number(a.r.rank) - Number(b.r.rank),
      );
    fuzzy.forEach(({ r }, i) => {
      r.rank = i + 1;
    });
    return rows.rows.map((r) => ({
      node: nativeMemoryNodeSchema.parse({
        id: r.id,
        metadata: r.metadata,
        content: r.content,
      }),
      channel: r.channel,
      rank: Number(r.rank),
    }));
  }
  async expand(
    input: MemoryReadContext,
    ids: readonly string[],
  ): Promise<MemoryCandidate[]> {
    const seeds = (await this.current(input, ids)).map((n) => n.id);
    const paths = new Map(seeds.map((id) => [id, [id]]));
    let frontier = [...seeds];
    const result: MemoryCandidate[] = [];
    for (
      let depth = 0;
      depth < 4 && frontier.length && result.length < 100;
      depth++
    ) {
      const rows = await this.db.query<Row & { from_id: string }>(
        `
        SELECT n.*,CASE WHEN e.source_id=ANY($4::uuid[]) THEN e.source_id ELSE e.target_id END from_id
        FROM memory_edges e JOIN memory_nodes n ON n.id=CASE
          WHEN e.source_id=ANY($4::uuid[]) THEN e.target_id ELSE e.source_id END
        WHERE (e.source_id=ANY($4::uuid[]) OR e.target_id=ANY($4::uuid[]))
          AND ${eligible()} AND ($5::int=0 OR e.relation='summarizes')
          AND NOT(n.id=ANY($6::uuid[])) ORDER BY n.id,e.source_id,e.target_id LIMIT $7`,
        [
          ...params(input),
          frontier,
          depth,
          [...paths.keys()],
          100 - result.length,
        ],
      );
      frontier = [];
      for (const r of rows.rows) {
        if (paths.has(r.id)) continue;
        const path = [...(paths.get(r.from_id) ?? []), r.id];
        paths.set(r.id, path);
        frontier.push(r.id);
        result.push({
          node: nativeMemoryNodeSchema.parse({
            id: r.id,
            metadata: r.metadata,
            content: r.content,
          }),
          channel: "link",
          rank: result.length + 1,
          path,
        });
      }
    }
    return result;
  }

  async history(id: string): Promise<readonly unknown[]> {
    return (
      await this.db.query(
        `SELECT information_id,created_at,nodes FROM memory_native_publications
      WHERE nodes @> $1::jsonb ORDER BY created_at DESC LIMIT 100`,
        [JSON.stringify([{ id }])],
      )
    ).rows;
  }
}
