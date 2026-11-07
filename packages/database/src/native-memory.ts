/**
 * 功能概述：在 native 存储内执行原子发布、历史读取、来源正规化与批次恢复。
 * 主要职责：publish 保留操作哈希及修订；合并拆分只接受当前有效输入和全新输出。
 * 当前查询使用同快照现态与局部失效闭包，历史查询服从独立提交上界。
 * 已有宿主事务中的 snapshot 实例复用同一读取边界，不重新设置事务隔离级别。
 * ingest/recover 保留 epoch 和原始账本，形成失败通过唯一后继重试；historyPage 只投影目标节点。
 * 代码库关系：实现 memory 领域端口，复用 information 与 observation 表；不引入模型或另一存储后端。
 */
import {
  memoryUpper,
  readMemoryView,
  scopedNodes,
  readMemoryInvalidations,
  currentInvalidity,
  memoryProofMetadata,
  type MemoryView,
} from "./native-memory-history.js";
import { sourceProofOwners } from "./native-memory-proof.js";
import { checkActionDependencies } from "./action-dependencies.js";
import type { ActionDependencies } from "@kaguya/sdk";
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
  canonicalMemorySourceId,
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
    CREATE TABLE IF NOT EXISTS memory_native_source_gaps (
      source_id text PRIMARY KEY REFERENCES information_atoms(information_id), status text NOT NULL, reason text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_native_batches (
      id uuid PRIMARY KEY, scope text NOT NULL, sources jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE memory_native_batches ADD COLUMN IF NOT EXISTS predecessor_id uuid;
    ALTER TABLE memory_native_batches ADD COLUMN IF NOT EXISTS retry_requested boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_native_batch_successor ON memory_native_batches(predecessor_id) WHERE predecessor_id IS NOT NULL;
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
    CREATE INDEX IF NOT EXISTS memory_native_invalidation_events ON information_atoms(information_id)
      WHERE kind='memory.native.revision.v1' AND payload ? 'invalidations';
    CREATE INDEX IF NOT EXISTS memory_native_revision_positions ON information_lifecycle(position DESC)
      WHERE kind='memory.native.revision.v1';
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
  private readonly views = new Map<string, Promise<MemoryView>>();
  private currentUpper?: Promise<string>;
  private async isCurrent(input: MemoryReadContext) {
    const upper = await (this.currentUpper ??= memoryUpper(this.db));
    return !input.cutoff || input.cutoff.publicationPosition === upper;
  }
  private async validCurrent(
    nodes: readonly NativeMemoryNode[],
    formation = false,
  ) {
    const invalid = await currentInvalidity(
      this.db,
      nodes.map((n) => n.id),
      formation,
    );
    return nodes.filter((n) => !invalid.has(n.id));
  }
  constructor(
    private readonly db: SqlDatabase,
    private readonly snapshot = false,
  ) {}
  async checkDependencies(input: ActionDependencies) {
    return this.db.transaction((tx) => checkActionDependencies(tx, input));
  }
  async cutoff(input: MemoryReadContext) {
    return input.cutoff ?? { publicationPosition: await memoryUpper(this.db) };
  }
  private async view(input: MemoryReadContext): Promise<MemoryView> {
    const upper = (await this.cutoff(input)).publicationPosition;
    const key = JSON.stringify([upper, input.scope, input.owners]);
    if (!this.views.has(key))
      this.views.set(
        key,
        readMemoryView(this.db, upper, {
          scope: input.scope,
          owners: input.owners,
        }),
      );
    return this.views.get(key)!;
  }

  async pendingEvidence(input: MemoryReadContext) {
    let address: unknown;
    try {
      const [platform, adapterId, kind, id] = JSON.parse(input.scope);
      address = {
        platform,
        adapterId,
        destination: {
          kind,
          ...(kind === "private"
            ? { userId: id }
            : kind === "group"
              ? { groupId: id }
              : id
                ? { conversationId: id }
                : {}),
        },
      };
    } catch {
      return { pendingEvidence: [], evidenceHasMore: false };
    }
    const rows = (
      await this.db.query<{
        id: string;
        text: string;
        owner_id: string;
        occurred_at: string;
        original_characters: number;
      }>(
        `SELECT a.information_id id,
      LEFT(CASE WHEN a.kind='core.message.inbound.text' THEN a.payload->>'text' ELSE '自身已经发出的消息（不代表已完成其中承诺的行动）：'||(req.payload->'message'->>'text') END,1200) text,char_length(CASE WHEN a.kind='core.message.inbound.text' THEN a.payload->>'text' ELSE '自身已经发出的消息（不代表已完成其中承诺的行动）：'||(req.payload->'message'->>'text') END) original_characters,
      COALESCE(s.source->>'ownerId',CASE WHEN a.kind='core.delivery.delivered' THEN 'self:kaguya' ELSE $2 END) owner_id,a.occurred_at FROM information_atoms a
      JOIN information_lifecycle l USING(information_id)
      LEFT JOIN memory_native_sources s ON s.id=a.information_id
      LEFT JOIN memory_native_batches b ON b.id=s.batch_id
      LEFT JOIN information_references ref ON ref.information_id=a.information_id AND ref.relation='core:status-of'
      LEFT JOIN information_atoms req ON req.information_id=ref.target_information_id AND req.kind='core.delivery.requested', memory_native_epoch e
      WHERE l.position>e.source_after AND a.occurred_at::timestamptz <= $3::timestamptz AND (b.status IS NULL OR b.status<>'completed') AND
      ((a.kind='core.message.inbound.text' AND a.payload->'source' @> $1::jsonb AND a.payload->'source'->'destination'=$1::jsonb->'destination'
        AND COALESCE(a.payload->'source'->'sender'->>'isSelf','false')<>'true'
        AND a.payload->'source'->>'senderId' IS DISTINCT FROM a.payload->'source'->>'selfId') OR
       (a.kind='core.delivery.delivered' AND a.payload->>'ok'='true' AND a.payload->>'platform'=$1::jsonb->>'platform'
        AND a.payload->>'adapterId'=$1::jsonb->>'adapterId' AND a.payload->'target'=$1::jsonb->'destination'))
      AND NOT EXISTS(SELECT 1 FROM information_atoms invalid JOIN memory_native_publications publication ON publication.information_id=invalid.information_id
        CROSS JOIN LATERAL jsonb_array_elements(invalid.payload->'invalidations') effect
        WHERE invalid.kind='memory.native.revision.v1' AND invalid.payload ? 'invalidations' AND effect->>'kind'='source-withdrawal' AND effect->>'targetId'=a.information_id)
      ORDER BY l.position DESC LIMIT 101`,
        [JSON.stringify(address), `conversation:${input.scope}`, input.asOf],
      )
    ).rows;
    return {
      pendingEvidence: rows
        .slice(0, 100)
        .filter((r) => r.text?.trim())
        .map((r) => ({
          informationId: r.id,
          text: r.text,
          ownerId: r.owner_id,
          scope: input.scope,
          occurredAt: r.occurred_at,
          truncated: r.original_characters > 1200,
          originalCharacters: r.original_characters,
        })),
      evidenceHasMore: rows.length > 100,
    };
  }
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
        "UPDATE memory_native_batches SET retry_requested=true WHERE id=$1",
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
    const view = await readMemoryInvalidations(
      this.db,
      undefined,
      rows.rows.map((r) => `person:${r.person_id}`),
      [],
    );
    return rows.rows
      .filter((r) => !view.identities.has(`person:${r.person_id}`))
      .map((r) => ({
        accountId: r.account_id,
        ownerId: `person:${r.person_id}`,
      }));
  }
  async withReadSnapshot<T>(
    run: (store: NativeMemoryStore) => Promise<T>,
  ): Promise<T> {
    if (this.snapshot) return run(this);
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
      return run(new PostgresNativeMemoryStore(readOnly, true));
    });
  }
  async ingest(source: MemorySource) {
    source = memorySourceSchema.parse(source);
    return this.db.transaction(async (tx) => {
      // 正规来源也参与历史补证；先取全局提交锁，再取会话锁，禁止迟提交填入旧 cutoff。
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      const evidence = (
        await tx.query<{ payload: Record<string, any>; kind: string }>(
          `SELECT a.payload,a.kind FROM information_atoms a JOIN information_lifecycle l USING(information_id), memory_native_epoch e WHERE a.information_id=$1 AND l.position>e.source_after`,
          [source.id],
        )
      ).rows[0];
      if (!evidence) return false;
      let address: Record<string, any>;
      if (evidence.kind === "core.message.inbound.text") {
        address = evidence.payload.source;
        if (
          source.sourceType !== "inbound" ||
          source.text !== evidence.payload.text
        )
          throw new NativeMemoryError("memory_invalid_source", 400);
      } else if (
        evidence.kind === "core.delivery.delivered" &&
        evidence.payload.ok === true
      ) {
        const sent = (
          await tx.query<{ payload: Record<string, any> }>(
            `SELECT a.payload FROM information_references r JOIN information_atoms a ON a.information_id=r.target_information_id WHERE r.information_id=$1 AND r.relation='core:status-of' AND a.kind='core.delivery.requested'`,
            [source.id],
          )
        ).rows[0]?.payload;
        address = {
          platform: evidence.payload.platform,
          adapterId: evidence.payload.adapterId,
          destination: evidence.payload.target,
        };
        if (
          !sent ||
          source.sourceType !== "delivered" ||
          JSON.stringify(sent.destination) !==
            JSON.stringify(address.destination) ||
          sent.platform !== address.platform ||
          sent.adapterId !== address.adapterId ||
          source.text !==
            `自身已经发出的消息（不代表已完成其中承诺的行动）：${sent.message?.text}`
        )
          throw new NativeMemoryError("memory_invalid_source", 400);
      } else throw new NativeMemoryError("memory_invalid_source", 400);
      const d = address.destination;
      const scope = JSON.stringify([
        address.platform,
        address.adapterId,
        d.kind,
        d.userId ?? d.groupId ?? d.conversationId ?? null,
      ]);
      if (scope !== source.scope)
        throw new NativeMemoryError("memory_invalid_source_scope", 400);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,168))", [
        `${address.platform}:${address.adapterId}:${d.kind}:${d.userId ?? d.groupId ?? d.conversationId ?? ""}`,
      ]);
      const existing = (
        await tx.query<{ source: MemorySource }>(
          "SELECT source FROM memory_native_sources WHERE id=$1",
          [source.id],
        )
      ).rows[0];
      if (existing) source = memorySourceSchema.parse(existing.source);
      if (!source.ownerId.trim())
        throw new NativeMemoryError("memory_invalid_source", 400);
      // 冻结原始账号的全部身份依赖，含已拆分身份；people() 的当前解析结果不能替代它。
      const proof = await sourceProofOwners(tx, [source.id]);
      const sourceOwners = [...proof]
        .filter(([, ids]) => ids.has(source.id))
        .map(([owner]) => owner);
      if (sourceOwners.length && !sourceOwners.includes(source.ownerId))
        sourceOwners.push(source.ownerId);
      sourceOwners.sort();
      const kind = "memory.native.source.v1",
        canonicalId = canonicalMemorySourceId(source.id);
      await tx.query(
        "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
        [kind],
      );
      if (
        !(
          await tx.query(
            "SELECT 1 FROM information_atoms WHERE information_id=$1",
            [canonicalId],
          )
        ).rowCount
      ) {
        await appendInformationAtom(
          tx,
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: canonicalId,
              kind,
              occurredAt: source.occurredAt,
              source: "memory:normalization",
              payload: {
                source: {
                  platform: address.platform,
                  adapterId: address.adapterId,
                  destination: d,
                },
                text: source.text,
                originalInformationId: source.id,
                memorySource: source,
                ...(sourceOwners.length
                  ? { sourceProofVersion: 1, sourceOwners }
                  : {}),
              },
              references: [
                { relation: "core:uses-context", informationId: source.id },
              ],
            }),
          ),
          [{ relation: "core:uses-context", required: true, multiple: false }],
          { enqueueLogProjection: false },
        );
      }
      const result = await tx.query(
        "INSERT INTO memory_native_sources(id,scope,source) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id",
        [source.id, source.scope, JSON.stringify(source)],
      );
      return result.rows.length > 0;
    });
  }
  async sourceBoundary(ids: readonly string[]) {
    const rows = (
      await this.db.query<{ information_id: string }>(
        "SELECT information_id FROM information_lifecycle WHERE information_id=ANY($1::text[]) ORDER BY position DESC",
        [ids.map(canonicalMemorySourceId)],
      )
    ).rows;
    if (rows.length !== new Set(ids).size)
      throw new NativeMemoryError("memory_source_proof_missing");
    return rows[0]!.information_id;
  }
  async successor(batchId: string): Promise<MemoryBatch | undefined> {
    return this.db.transaction(async (tx) => {
      const prior = (
        await tx.query<{
          scope: string;
          sources: MemorySource[];
          status: string;
        }>(
          "SELECT scope,sources,status FROM memory_native_batches WHERE id=$1 FOR UPDATE",
          [batchId],
        )
      ).rows[0];
      if (!prior || !["rejected", "failed"].includes(prior.status))
        return undefined;
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,71493))",
        [prior.scope],
      );
      const saved = (
        await tx.query<MemoryBatch & Record<string, unknown>>(
          "SELECT id,scope,sources FROM memory_native_batches WHERE predecessor_id=$1",
          [batchId],
        )
      ).rows[0];
      if (saved) return saved;
      const pending = (
        await tx.query(
          "SELECT 1 FROM memory_native_batches WHERE scope=$1 AND status='pending'",
          [prior.scope],
        )
      ).rowCount;
      if (pending) return undefined;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO memory_native_batches(id,scope,sources,predecessor_id) VALUES($1,$2,$3::jsonb,$4)",
        [id, prior.scope, JSON.stringify(prior.sources), batchId],
      );
      await tx.query(
        "UPDATE memory_native_sources SET batch_id=$1 WHERE id=ANY($2::text[])",
        [id, prior.sources.map((s) => s.id)],
      );
      return { id, scope: prior.scope, sources: prior.sources };
    });
  }
  async recover() {
    const stage = async (status: string) =>
      this.db.query(
        "INSERT INTO memory_native_stages(stage,status) VALUES('recovery',$1) ON CONFLICT(stage) DO UPDATE SET status=EXCLUDED.status,updated_at=now()",
        [status],
      );
    await stage("running");
    try {
      await this.recoverSources();
      await stage("idle");
    } catch (error) {
      await stage("failed");
      throw error;
    }
  }
  private async recoverSources() {
    // 扫描原账本而非前台 turn；未正规化来源及排除决定持久保留。
    let after = "0";
    for (;;) {
      const raws = (
        await this.db.query<{
          information_id: string;
          kind: string;
          payload: Record<string, any>;
          occurred_at: string;
          position: string;
        }>(
          `SELECT a.*,l.position::text FROM information_atoms a JOIN information_lifecycle l USING(information_id),memory_native_epoch e
        WHERE l.position>e.source_after AND l.position>$1::bigint AND a.kind IN ('core.message.inbound.text','core.delivery.delivered')
        AND NOT EXISTS(SELECT 1 FROM memory_native_sources s WHERE s.id=a.information_id)
        AND NOT EXISTS(SELECT 1 FROM memory_native_source_gaps g WHERE g.source_id=a.information_id AND g.status='excluded')
        ORDER BY l.position LIMIT 100`,
          [after],
        )
      ).rows;
      for (const raw of raws) {
        after = raw.position;
        try {
          const inbound = raw.kind === "core.message.inbound.text",
            p = raw.payload;
          let address = inbound
            ? p.source
            : {
                platform: p.platform,
                adapterId: p.adapterId,
                destination: p.target,
              };
          let text = inbound ? p.text : undefined;
          if (!inbound) {
            const req = (
              await this.db.query<{ payload: Record<string, any> }>(
                "SELECT a.payload FROM information_references r JOIN information_atoms a ON a.information_id=r.target_information_id WHERE r.information_id=$1 AND r.relation='core:status-of' AND a.kind='core.delivery.requested'",
                [raw.information_id],
              )
            ).rows[0]?.payload;
            if (req?.message?.text)
              text = `自身已经发出的消息（不代表已完成其中承诺的行动）：${req.message.text}`;
          }
          if (
            (!inbound && p.ok !== true) ||
            !text?.trim() ||
            (inbound &&
              (address.sender?.isSelf || address.senderId === address.selfId))
          ) {
            await this.db.query(
              "INSERT INTO memory_native_source_gaps(source_id,status,reason) VALUES($1,'excluded','non-semantic') ON CONFLICT(source_id) DO UPDATE SET status='excluded',reason='non-semantic'",
              [raw.information_id],
            );
            continue;
          }
          const d = address.destination,
            scope = JSON.stringify([
              address.platform,
              address.adapterId,
              d.kind,
              d.userId ?? d.groupId ?? d.conversationId ?? null,
            ]);
          const bindings = inbound
            ? await this.people({
                platform: address.platform,
                adapterId: address.adapterId,
                accountIds: [address.senderId],
              })
            : [];
          const owner = inbound
            ? bindings.length === 1
              ? bindings[0]!.ownerId
              : `conversation:${scope}`
            : "self:kaguya";
          const source: MemorySource = {
            id: raw.information_id,
            scope,
            ownerId: owner,
            text,
            sourceType: inbound ? "inbound" : "delivered",
            occurredAt: raw.occurred_at,
            collectedAt: new Date().toISOString(),
            participants: inbound
              ? [
                  {
                    accountId: address.senderId,
                    ownerId: bindings.length === 1 ? owner : null,
                    role: "speaker",
                    nickname: address.sender?.nickname ?? null,
                    card: address.sender?.card ?? null,
                  },
                  ...(address.mentions ?? [])
                    .filter((m: any) => m.kind === "user")
                    .map((m: any) => ({
                      accountId: m.id,
                      ownerId: null,
                      role: "mentioned",
                      nickname: null,
                      card: null,
                    })),
                  ...(address.replyTo?.senderId
                    ? [
                        {
                          accountId: address.replyTo.senderId,
                          ownerId: null,
                          role: "replied-to" as const,
                          nickname: null,
                          card: null,
                        },
                      ]
                    : []),
                ]
              : [],
            replyTo: address.replyTo
              ? {
                  platformMessageId: address.replyTo.platformMessageId,
                  senderId: address.replyTo.senderId ?? null,
                }
              : null,
          };
          await this.ingest(source);
          await this.db.query(
            "INSERT INTO memory_native_source_gaps(source_id,status,reason) VALUES($1,'normalized','ledger-recovery') ON CONFLICT(source_id) DO UPDATE SET status='normalized',reason='ledger-recovery'",
            [raw.information_id],
          );
        } catch {
          await this.db.query(
            "INSERT INTO memory_native_source_gaps(source_id,status,reason) VALUES($1,'pending','normalization-failed') ON CONFLICT(source_id) DO UPDATE SET status='pending',reason='normalization-failed'",
            [raw.information_id],
          );
        }
      }
      if (raws.length < 100) break;
    }

    let sourceAfter = "0";
    for (;;) {
      const sources = (
        await this.db.query<{ source: MemorySource; ordinal: string }>(
          `SELECT s.source,s.ordinal::text FROM memory_native_sources s WHERE s.ordinal>$1::bigint AND
        (NOT EXISTS(SELECT 1 FROM information_atoms a WHERE a.information_id='memory-native-source:'||s.id) OR NOT(s.source ?& ARRAY['sourceType','participants','replyTo'])) ORDER BY s.ordinal LIMIT 500`,
          [sourceAfter],
        )
      ).rows;
      for (const row of sources) {
        const restored = await this.db.transaction((tx) =>
          this.restoreSourceProvenance(tx, [row.source]),
        );
        await this.ingest(restored[0]!);
        sourceAfter = row.ordinal;
      }
      if (sources.length < 500) break;
    }
    const conflicts = (
      await this.db.query<{
        id: string;
        scope: string;
        context: string;
      }>(`SELECT b.id::text,b.scope,r.target_information_id context FROM memory_native_batches b
      JOIN information_atoms a ON a.kind='memory.native.formation.requested.v1' AND a.payload->>'batchId'=b.id::text
      JOIN information_references r ON r.information_id=a.information_id AND r.relation='core:context'
      WHERE b.status IN ('rejected','failed') AND NOT EXISTS(SELECT 1 FROM memory_native_batches next WHERE next.predecessor_id=b.id)
      AND (b.retry_requested OR EXISTS(SELECT 1 FROM information_atoms done WHERE done.kind='memory.native.formation.completed.v1' AND done.payload->>'batchId'=b.id::text AND done.payload->>'reason' IN ('memory_revision_conflict','memory_summary_conflict')))`)
    ).rows;
    for (const b of conflicts)
      await this.db.transaction(async (tx) => {
        const kind = "memory.native.formation.retry.v1";
        await tx.query(
          "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
          [kind],
        );
        await appendInformationAtom(
          tx,
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: randomUUID(),
              kind,
              occurredAt: new Date().toISOString(),
              source: "memory:recovery",
              payload: { batchId: b.id, scope: b.scope },
              references: [
                { relation: "core:context", informationId: b.context },
              ],
            }),
          ),
          [{ relation: "core:context", required: true, multiple: false }],
          { enqueueLogProjection: false },
        );
      });
    const completed = (
      await this.db.query<{
        id: string;
        scope: string;
        context: string;
      }>(`SELECT b.id::text,b.scope,r.target_information_id context FROM memory_native_batches b
      JOIN information_atoms a ON a.kind='memory.native.formation.requested.v1' AND a.payload->>'batchId'=b.id::text
      JOIN information_references r ON r.information_id=a.information_id AND r.relation='core:context'
      WHERE b.status='completed' AND EXISTS(SELECT 1 FROM jsonb_array_elements(b.sources) s WHERE NOT EXISTS(
        SELECT 1 FROM information_observations o WHERE o.status='completed' AND o.manifest->>'proofKind'='memory-native'
        AND o.source_ids ? ('memory-native-source:'||(s->>'id'))))
      ORDER BY b.created_at,b.id`)
    ).rows;
    for (const b of completed)
      await this.db.transaction(async (tx) => {
        const kind = "memory.native.formation.retry.v1";
        await tx.query(
          "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
          [kind],
        );
        await appendInformationAtom(
          tx,
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: randomUUID(),
              kind,
              occurredAt: new Date().toISOString(),
              source: "memory:recovery",
              payload: { batchId: b.id, scope: b.scope },
              references: [
                { relation: "core:context", informationId: b.context },
              ],
            }),
          ),
          [{ relation: "core:context", required: true, multiple: false }],
          { enqueueLogProjection: false },
        );
      });
    const scopes = (
      await this.db.query<{ scope: string; id: string }>(
        `SELECT DISTINCT ON (s.scope) s.scope,s.id FROM memory_native_sources s LEFT JOIN memory_native_batches b ON b.id=s.batch_id WHERE (s.batch_id IS NULL AND (s.source->>'collectedAt')::timestamptz<=now()-interval '60 seconds') OR b.status='pending' ORDER BY s.scope,s.ordinal`,
      )
    ).rows;
    for (const item of scopes)
      await this.db.transaction(async (tx) => {
        const ctx = (
          await tx.query<{ target_information_id: string }>(
            "SELECT target_information_id FROM information_references WHERE information_id=$1 AND relation='core:context'",
            [item.id],
          )
        ).rows[0];
        if (!ctx) return;
        const kind = "memory.native.formation.retry.v1";
        await tx.query(
          "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
          [kind],
        );
        await appendInformationAtom(
          tx,
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: randomUUID(),
              kind,
              occurredAt: new Date().toISOString(),
              source: "memory:recovery",
              payload: { batchId: item.id, scope: item.scope },
              references: [
                {
                  relation: "core:context",
                  informationId: ctx.target_information_id,
                },
              ],
            }),
          ),
          [{ relation: "core:context", required: true, multiple: false }],
          { enqueueLogProjection: false },
        );
      });
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
        if (p.invalidations?.length && p.actor !== "manual")
          throw new NativeMemoryError(
            "memory_invalidation_requires_manual",
            400,
          );
        const derivedProofOwners = new Map<
          string,
          { ownerId: string; sourceIds: string[] }[]
        >();
        const derivedVerifiedSources = new Map<string, Set<string>>();
        for (const effect of p.invalidations ?? []) {
          if (
            effect.kind === "source-withdrawal" &&
            !(
              await tx.query(
                "SELECT 1 FROM information_atoms WHERE information_id=$1",
                [effect.targetId],
              )
            ).rowCount
          )
            throw new NativeMemoryError("memory_evidence_missing", 400);
        }
        if (p.experienceOperation) {
          const op = p.experienceOperation;
          if (
            new Set(op.inputIds).size !== op.inputIds.length ||
            new Set(op.outputIds).size !== op.outputIds.length ||
            (op.kind === "merge" &&
              (op.inputIds.length < 2 || op.outputIds.length !== 1)) ||
            (op.kind === "split" &&
              (op.inputIds.length !== 1 || op.outputIds.length < 2)) ||
            (["merge", "split"].includes(op.kind) &&
              op.outputIds.some((id) => op.inputIds.includes(id)))
          )
            throw new NativeMemoryError("memory_invalid_experience", 400);
          const old = parse(
            (
              await tx.query<Row>(
                "SELECT id,metadata,content FROM memory_nodes WHERE id=ANY($1::uuid[]) FOR UPDATE",
                [op.inputIds],
              )
            ).rows,
          );
          if (
            old.length !== new Set(op.inputIds).size ||
            old.some((n) => n.metadata.kind !== "experience")
          )
            throw new NativeMemoryError("memory_invalid_experience", 400);
          if (
            ["merge", "split"].includes(op.kind) &&
            p.actor === "automatic" &&
            old.some((n) => p.expectedVersions[n.id] !== n.metadata.revision)
          )
            throw new NativeMemoryError("memory_revision_conflict");
          const outputs = op.outputIds.map(
            (id) => p.nodes.find((n) => n.node.id === id)?.node,
          );
          const scopes = new Set(old.map((n) => n.metadata.scope));
          if (
            scopes.size !== 1 ||
            outputs.some(
              (n) =>
                !n ||
                n.metadata.kind !== "experience" ||
                !scopes.has(n.metadata.scope) ||
                !old.some(
                  (prior) => prior.metadata.ownerId === n.metadata.ownerId,
                ),
            )
          )
            throw new NativeMemoryError("memory_experience_scope", 400);
          const proof = await memoryProofMetadata(tx, op.inputIds);
          const sources = new Set(proof.flatMap((n) => n.sources));
          if (["merge", "split"].includes(op.kind)) {
            // 已归档的前驱不能再次分叉；输出必须是新节点，不能覆盖已有经历。
            if (
              old.some((n) => n.metadata.status !== "active") ||
              outputs.some(
                (n) =>
                  n!.metadata.status !== "active" ||
                  p.nodes.find((item) => item.node.id === n!.id)
                    ?.expectedRevision !== 0,
              )
            )
              throw new NativeMemoryError("memory_invalid_experience", 400);
            if (
              old.some(
                (n) =>
                  !p.nodes.some(
                    (x) =>
                      x.node.id === n.id &&
                      x.node.metadata.status === "archived" &&
                      x.node.metadata.kind === n.metadata.kind &&
                      x.node.metadata.scope === n.metadata.scope &&
                      x.node.metadata.ownerId === n.metadata.ownerId &&
                      n.metadata.sourceIds.every((id) =>
                        x.node.metadata.sourceIds.includes(id),
                      ) &&
                      x.node.metadata.sourceIds.every((id) =>
                        n.metadata.sourceIds.includes(id),
                      ),
                  ),
              ) ||
              outputs.some(
                (n) =>
                  !n!.metadata.experience ||
                  !op.inputIds.every((id) =>
                    n!.metadata.experience!.predecessors.includes(id),
                  ),
              ) ||
              outputs.some(
                (n) =>
                  !n!.metadata.sourceIds.length ||
                  n!.metadata.sourceIds.some((id) => !sources.has(id)),
              ) ||
              [...sources].some(
                (id) =>
                  !outputs.some((n) => n!.metadata.sourceIds.includes(id)),
              )
            )
              throw new NativeMemoryError("memory_experience_sources", 400);
            // 输入哈希保持调用方原提案；派生证明归属随发布保存，并按各输出的明确来源分配。
            for (const output of outputs) {
              const owners = new Map<string, Set<string>>();
              for (const dependency of proof)
                for (const id of dependency.sources)
                  if (output!.metadata.sourceIds.includes(id)) {
                    if (!owners.has(dependency.owner))
                      owners.set(dependency.owner, new Set());
                    owners.get(dependency.owner)!.add(id);
                  }
              output!.metadata.experience!.proofOwners = [...owners]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([ownerId, ids]) => ({
                  ownerId,
                  sourceIds: [...ids].sort(),
                }));
              derivedVerifiedSources.set(
                output!.id,
                new Set(
                  proof.flatMap((row) =>
                    row.sources.filter(
                      (id) =>
                        !row.unproved.includes(id) &&
                        output!.metadata.sourceIds.includes(id),
                    ),
                  ),
                ),
              );
              derivedProofOwners.set(
                output!.id,
                output!.metadata.experience!.proofOwners,
              );
            }
          } else if (
            op.inputIds.length !== 1 ||
            op.outputIds.length !== 1 ||
            op.inputIds[0] !== op.outputIds[0] ||
            (op.kind === "seal" &&
              outputs[0]!.metadata.experience?.state !== "sealed") ||
            (op.kind === "reopen" &&
              outputs[0]!.metadata.experience?.state !== "open")
          )
            throw new NativeMemoryError("memory_invalid_experience", 400);
        }
        const changedIds = p.nodes.map((n) => n.node.id);
        if (new Set(changedIds).size !== changedIds.length)
          throw new NativeMemoryError("memory_duplicate_node", 400);
        const validity =
          p.actor === "automatic"
            ? await readMemoryInvalidations(
                tx,
                undefined,
                p.nodes.map((n) => n.node.metadata.ownerId),
                p.nodes.flatMap((n) => n.node.metadata.sourceIds),
              )
            : undefined;
        if (
          p.actor === "automatic" &&
          (
            await currentInvalidity(
              tx,
              [
                ...new Set([
                  ...p.nodes.map((n) => n.node.id),
                  ...Object.keys(p.expectedVersions),
                ]),
              ],
              true,
            )
          ).size
        )
          throw new NativeMemoryError("memory_source_invalidated");
        for (const { node, expectedRevision } of p.nodes) {
          if (
            validity &&
            (validity.identities.has(node.metadata.ownerId) ||
              node.metadata.sourceIds.some((id) => validity.withdrawn.has(id)))
          )
            throw new NativeMemoryError("memory_source_invalidated");
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
          const prior = previous?.success ? previous.data.metadata : undefined;
          const experience = node.metadata.experience ?? prior?.experience;
          // 每次发布校验全部当前来源，旧节点缺少证明也不能跳过；客户端映射不构成证明。
          const currentProof = await sourceProofOwners(
            tx,
            node.metadata.sourceIds,
          );
          const inherited = [
            ...(prior?.proofOwners ?? []),
            ...(prior?.experience?.proofOwners ?? []),
            ...(derivedProofOwners.get(node.id) ?? []),
          ];
          const owners = new Map<string, Set<string>>();
          for (const proof of inherited) {
            if (!owners.has(proof.ownerId))
              owners.set(proof.ownerId, new Set());
            for (const id of proof.sourceIds)
              owners.get(proof.ownerId)!.add(id);
          }
          for (const [owner, ids] of currentProof) {
            if (!owners.has(owner)) owners.set(owner, new Set());
            for (const id of ids) owners.get(owner)!.add(id);
          }
          if (
            node.metadata.sourceIds.some(
              (id) =>
                ![...currentProof.values()].some((ids) => ids.has(id)) &&
                !derivedVerifiedSources.get(node.id)?.has(id) &&
                !(prior?.proofOwners ?? []).some((p) =>
                  p.sourceIds.includes(id),
                ),
            )
          )
            throw new NativeMemoryError("memory_source_proof_missing", 400);
          // 暂时移除的来源保留映射；读取仅对当前 sourceIds 交集生效，重新加入时恢复约束。
          const proofOwners = [...owners]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([ownerId, ids]) => ({ ownerId, sourceIds: [...ids].sort() }));
          // 旧 nested 的 dormant 依赖仍保留，但移除来源不能把未验证映射升级成完整证明。
          const verifiedSources = new Set([
            ...(prior?.proofOwners ?? []).flatMap((p) => p.sourceIds),
            ...[...currentProof.values()].flatMap((ids) => [...ids]),
            ...(derivedVerifiedSources.get(node.id) ?? []),
          ]);
          const completeOwners = proofOwners.flatMap((p) => {
            const sourceIds = p.sourceIds.filter((id) =>
              verifiedSources.has(id),
            );
            return sourceIds.length ? [{ ownerId: p.ownerId, sourceIds }] : [];
          });
          delete node.metadata.proofOwners;
          if (completeOwners.length) node.metadata.proofOwners = completeOwners;
          if (experience) {
            const { proofOwners: _clientProof, ...state } = experience;
            node.metadata.experience = {
              ...state,
              ...(proofOwners.length ? { proofOwners } : {}),
            };
          }
          if (p.actor === "automatic") {
            const effects = await readMemoryInvalidations(
              tx,
              undefined,
              proofOwners
                .filter((p) =>
                  p.sourceIds.some((id) =>
                    node.metadata.sourceIds.includes(id),
                  ),
                )
                .map((p) => p.ownerId),
              node.metadata.sourceIds,
            );
            if (effects.identities.size || effects.withdrawn.size)
              throw new NativeMemoryError("memory_source_invalidated");
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
                ...(p.invalidations ? { invalidations: p.invalidations } : {}),
                ...(p.experienceOperation
                  ? { experienceOperation: p.experienceOperation }
                  : {}),
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
  private async currentForFormation(
    input: MemoryReadContext,
  ): Promise<NativeMemoryNode[]> {
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
  async forFormation(input: MemoryReadContext): Promise<NativeMemoryNode[]> {
    if (!this.snapshot)
      return [
        ...(await this.withReadSnapshot((store) => store.forFormation(input))),
      ];
    if (await this.isCurrent(input)) {
      const result = await this.currentForFormation(input);
      return this.validCurrent(result, true);
    }

    return scopedNodes(await this.view(input), input, true).filter((n) =>
      input.owners.includes(n.metadata.ownerId),
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
  private async currentPersonCandidates(input: MemoryReadContext) {
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
  async personCandidates(input: MemoryReadContext) {
    if (!this.snapshot)
      return [
        ...(await this.withReadSnapshot((store) =>
          store.personCandidates!(input),
        )),
      ];
    if (await this.isCurrent(input)) {
      const result = await this.currentPersonCandidates(input);
      const valid = new Set(
        (await this.validCurrent(result.map((r) => r.summary))).map(
          (n) => n.id,
        ),
      );
      return result.filter((r) => valid.has(r.summary.id));
    }

    if (!input.query.trim()) return [];
    const terms = memoryFuzzyTerms(input.query);
    // Shared ambiguous people are candidates, never automatic identity bindings.
    const view = await this.view(input);
    const expanded = {
      ...input,
      owners: [
        ...new Set([
          ...input.owners,
          ...[...view.nodes.values()]
            .filter((n) => n.metadata.scope === "shared")
            .map((n) => n.metadata.ownerId),
        ]),
      ],
    };
    return scopedNodes(view, expanded)
      .filter(
        (n) =>
          n.metadata.kind === "person" &&
          n.metadata.level === 0 &&
          !input.owners.includes(n.metadata.ownerId) &&
          memoryFuzzyTerms(n.metadata.aliases.join(" ") + " " + n.content).some(
            (t) => terms.includes(t),
          ),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((summary) => ({
        ownerId: summary.metadata.ownerId,
        summary,
        match: summary.metadata.aliases.some((a) => input.query.includes(a))
          ? ("alias" as const)
          : ("fuzzy" as const),
      }));
  }
  private async currentReadFixed(
    input: MemoryReadContext,
  ): Promise<NativeMemoryNode[]> {
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
  async readFixed(input: MemoryReadContext) {
    if (!this.snapshot)
      return [
        ...(await this.withReadSnapshot((store) => store.readFixed(input))),
      ];
    if (await this.isCurrent(input)) {
      const result = await this.currentReadFixed(input);
      return this.validCurrent(result, false);
    }

    return scopedNodes(await this.view(input), input).filter(
      (n) =>
        n.metadata.level === 0 && input.owners.includes(n.metadata.ownerId),
    );
  }
  private async currentCurrent(
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
  async current(input: MemoryReadContext, ids: readonly string[]) {
    if (!this.snapshot)
      return [
        ...(await this.withReadSnapshot((store) => store.current(input, ids))),
      ];
    if (await this.isCurrent(input)) {
      const result = await this.currentCurrent(input, ids);
      return this.validCurrent(result, false);
    }

    return scopedNodes(await this.view(input), input).filter((n) =>
      ids.includes(n.id),
    );
  }
  private async currentCandidates(
    input: MemoryReadContext,
  ): Promise<MemoryCandidate[]> {
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
  async candidates(input: MemoryReadContext): Promise<MemoryCandidate[]> {
    if (!this.snapshot)
      return [
        ...(await this.withReadSnapshot((store) => store.candidates(input))),
      ];
    if (await this.isCurrent(input)) {
      const result = await this.currentCandidates(input);
      const valid = new Set(
        (await this.validCurrent(result.map((r) => r.node))).map((n) => n.id),
      );
      return result.filter((r) => valid.has(r.node.id));
    }

    const nodes = scopedNodes(await this.view(input), input).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const terms = memoryTerms(input.query),
      fuzzy = memoryFuzzyTerms(input.query);
    const result: MemoryCandidate[] = [];
    const add = (channel: string, selected: NativeMemoryNode[]) =>
      selected.slice(0, 50).forEach((node, i) =>
        result.push({
          node,
          channel,
          rank: i + 1,
          indexVersion: "history-text:v1",
        }),
      );
    add(
      "explicit",
      nodes.filter((n) =>
        input.explicitIds?.some(
          (id) => n.id === id || n.metadata.sourceIds.includes(id),
        ),
      ),
    );
    add(
      "entity",
      nodes.filter((n) => input.owners.includes(n.metadata.ownerId)),
    );
    add(
      "text",
      nodes.filter((n) =>
        memoryTerms(
          [...n.metadata.aliases, ...n.metadata.tags, n.content].join(" "),
        ).some((t) => terms.includes(t)),
      ),
    );
    add(
      "fuzzy",
      nodes.filter((n) =>
        memoryFuzzyTerms(
          [...n.metadata.aliases, ...n.metadata.tags, n.content].join(" "),
        ).some((t) => fuzzy.includes(t)),
      ),
    );
    return result;
  }
  private async currentExpand(
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
      const valid = new Set(
        (
          await this.validCurrent(
            parse(
              rows.rows.map(({ id, metadata, content }) => ({
                id,
                metadata,
                content,
              })),
            ),
          )
        ).map((n) => n.id),
      );
      for (const r of rows.rows) {
        if (!valid.has(r.id)) continue;
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

  async expand(
    input: MemoryReadContext,
    ids: readonly string[],
  ): Promise<MemoryCandidate[]> {
    if (!this.snapshot)
      return [
        ...(await this.withReadSnapshot((store) => store.expand(input, ids))),
      ];
    if (await this.isCurrent(input)) {
      const result = await this.currentExpand(input, ids);
      const valid = new Set(
        (await this.validCurrent(result.map((r) => r.node))).map((n) => n.id),
      );
      return result.filter((r) => valid.has(r.node.id));
    }

    const view = await this.view(input),
      eligible = new Map(scopedNodes(view, input).map((n) => [n.id, n]));
    const paths = new Map(
      ids.filter((id) => eligible.has(id)).map((id) => [id, [id]]),
    );
    let frontier = [...paths.keys()];
    const result: MemoryCandidate[] = [];
    for (
      let depth = 0;
      depth < 4 && frontier.length && result.length < 100;
      depth++
    ) {
      const next: string[] = [];
      for (const e of view.edges) {
        if (depth > 0 && e.relation !== "summarizes") continue;
        const from = frontier.includes(e.sourceId)
          ? e.sourceId
          : frontier.includes(e.targetId)
            ? e.targetId
            : undefined;
        if (!from) continue;
        const id = from === e.sourceId ? e.targetId : e.sourceId;
        if (paths.has(id) || !eligible.has(id)) continue;
        const path = [...paths.get(from)!, id];
        paths.set(id, path);
        next.push(id);
        result.push({
          node: eligible.get(id)!,
          channel: "link",
          rank: result.length + 1,
          path,
        });
        if (result.length === 100) break;
      }
      frontier = next;
    }
    return result;
  }
  async historyPage(
    id: string,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new NativeMemoryError("memory_invalid_page", 400);
    let upper = await memoryUpper(this.db),
      before: string | null = null;
    if (options.cursor) {
      try {
        const c = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString(),
        );
        if (
          c.nodeId !== id ||
          !/^\d+$/.test(c.upper) ||
          !/^\d+$/.test(c.before) ||
          BigInt(c.upper) > BigInt(upper)
        )
          throw new Error();
        upper = c.upper;
        before = c.before;
      } catch {
        throw new NativeMemoryError("memory_invalid_cursor", 400);
      }
    }
    const rows = (
      await this.db.query<{
        information_id: string;
        position: string;
        operation_id: string;
        node: NativeMemoryNode;
        actor: string;
      }>(
        `
      SELECT p.information_id,l.position::text,p.operation_id,n.node,a.source actor
      FROM memory_native_publications p JOIN information_lifecycle l ON l.information_id=p.information_id
      JOIN information_atoms a ON a.information_id=p.information_id
      CROSS JOIN LATERAL jsonb_array_elements(p.nodes) n(node)
      WHERE n.node->>'id'=$1 AND l.position<=$2::bigint AND ($3::bigint IS NULL OR l.position<$3::bigint)
      ORDER BY l.position DESC LIMIT $4`,
        [id, upper, before, limit + 1],
      )
    ).rows;
    const items = rows.slice(0, limit),
      hasMore = rows.length > limit;
    return {
      items,
      hasMore,
      upper,
      nextCursor: hasMore
        ? Buffer.from(
            JSON.stringify({
              nodeId: id,
              upper,
              before: items.at(-1)!.position,
            }),
          ).toString("base64url")
        : null,
    };
  }
  async history(id: string): Promise<readonly unknown[]> {
    const page = await this.historyPage(id, { limit: 100 });
    return page.items.map((r) => ({
      information_id: r.information_id,
      operation_id: r.operation_id,
      nodes: [r.node],
    }));
  }
}
