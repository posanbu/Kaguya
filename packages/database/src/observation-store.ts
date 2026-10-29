/**
 * 功能概述：在同场景提交锁下冻结按注册顺序排列的有界证据，维护消费者独立成功进度。
 * freezeNext 按操作键分配连续页并保存完整清单；finish 合并已成功段，前段失败时后段完成不会跨过缺口。
 * discover/pending 分别提供接收边界和待办；defer/supersede 留下审计记录，恢复不依赖在线广播。
 * finish 将完成投影与进度原子提交，成功事实先由消费者持久登记；fail 仅记录受控错误码，read/progress 提供恢复与检视。
 * 代码库关系：复用 InformationRepository 的 scope advisory lock 和 lifecycle.position；经 SDK capability 暴露。
 * 输入输出与副作用：执行参数化 SQL 与行锁；stream 契约不可静默更改，来源页上限只推进实际冻结上界。
 */
import { randomUUID } from "node:crypto";
import {
  z,
  legacyHeartbeatScope,
  sceneIdentity,
  informationIdSchema,
} from "@kaguya/schema";
import {
  observationFreezeSchema,
  observationManifestSchema,
  type ObservationManifest,
  observationInputSchema,
  ObservationConflictError,
  type ObservationAccess,
  type ObservationInput,
  type ObservationFreezeInput,
  type ObservationSnapshot,
  type ObservationProgress,
} from "@kaguya/sdk";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

type SnapshotRow = {
  observation_id: string;
  scene_id: string;
  consumer_id: string;
  policy_version: string;
  contract: ObservationInput;
  after_position: string;
  through_position: string;
  source_ids: string[];
  context_ids: string[];
  recorded_at: string;
  status: ObservationSnapshot["status"];
  result_information_id: string | null;
  error_code: string | null;
  has_more: boolean;
  operation_key: string | null;
  manifest: ObservationSnapshot["manifest"];
  complete: boolean;
  received_through: string;
  deferred_until: string | null;
  replacement_observation_id: string | null;
};
const snapshotSelect = `SELECT o.observation_id,p.scene_id,p.consumer_id,p.policy_version,p.contract,
  o.after_position::text,o.through_position::text,o.source_ids,o.context_ids,o.recorded_at::text,
  o.status,o.result_information_id,o.error_code,o.has_more,o.operation_key,o.manifest,o.complete,
  COALESCE(o.received_through,o.through_position)::text AS received_through,
  o.deferred_until::text,o.replacement_observation_id FROM information_observations o
  JOIN information_observation_progress p USING(stream_id)`;
function snapshot(row: SnapshotRow): ObservationSnapshot {
  const address = Object.freeze({
    ...row.contract.address,
    destination: Object.freeze(row.contract.address.destination),
  });
  const contract = Object.freeze({
    ...row.contract,
    address,
    kinds: Object.freeze(row.contract.kinds),
  });
  return Object.freeze({
    contract,
    operationKey: row.operation_key,
    manifest: row.manifest ? deepFreeze(row.manifest) : null,
    complete: row.complete,
    receivedThroughPosition: row.received_through,
    deferredUntil: row.deferred_until
      ? new Date(row.deferred_until).toISOString()
      : null,
    replacementObservationId: row.replacement_observation_id,
    hasMore: row.has_more,
    observationId: row.observation_id,
    sceneId: row.scene_id,
    consumerId: row.consumer_id,
    policyVersion: row.policy_version,
    address,
    afterPosition: row.after_position,
    throughPosition: row.through_position,
    sourceInformationIds: Object.freeze(row.source_ids),
    contextInformationIds: Object.freeze(row.context_ids),
    recordedAt: new Date(row.recorded_at).toISOString(),
    status: row.status,
    resultInformationId: row.result_information_id,
    errorCode: row.error_code,
  });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function normalize(raw: ObservationInput): ObservationInput {
  const input = observationInputSchema.parse(raw);
  return { ...input, kinds: [...new Set(input.kinds)].sort() };
}
function identity(input: ObservationInput): string {
  return JSON.stringify([
    sceneIdentity(input.address),
    input.consumerId,
    input.policyVersion,
    input.senderId ?? null,
  ]);
}
export class PostgresObservationStore implements ObservationAccess {
  constructor(private readonly db: SqlDatabase) {}
  async freezeNext(
    raw: ObservationFreezeInput,
  ): Promise<ObservationSnapshot | undefined> {
    const input = observationFreezeSchema.parse(raw);
    const contract = normalize({
      consumerId: input.consumerId,
      policyVersion: input.policyVersion,
      address: input.address,
      kinds: input.kinds,
      resultKind: input.resultKind,
      ...(input.startAfterInformationId
        ? { startAfterInformationId: input.startAfterInformationId }
        : {}),
      ...(input.senderId ? { senderId: input.senderId } : {}),
    });
    const filter = {
      ...input.address,
      ...(input.senderId ? { senderId: input.senderId } : {}),
    };
    const sceneId = sceneIdentity(input.address),
      streamId = identity(contract);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,168))", [
        legacyHeartbeatScope(input.address),
      ]);
      await this.initialize(tx, contract);
      const open = await tx.query<SnapshotRow>(
        snapshotSelect +
          (input.operationKey
            ? ` WHERE o.stream_id=$1 AND o.operation_key=$2`
            : ` WHERE o.stream_id=$1 AND o.status <> 'completed' AND o.replacement_observation_id IS NULL ORDER BY o.after_position LIMIT 1`),
        input.operationKey ? [streamId, input.operationKey] : [streamId],
      );
      if (open.rows[0]) return snapshot(open.rows[0]);
      const progress = await tx.query<{
        allocated_through: string;
        discovered_through: string;
      }>(
        `SELECT allocated_through::text,discovered_through::text FROM information_observation_progress WHERE stream_id=$1`,
        [streamId],
      );
      let upper: string | null = progress.rows[0]!.discovered_through;
      if (input.throughInformationId) {
        const bound = await tx.query<{ position: string }>(
          `SELECT l.position::text FROM information_lifecycle l
          JOIN information_atoms a USING(information_id) WHERE l.information_id=$1 AND a.payload->'source' @> $2::jsonb
            AND a.payload->'source'->'destination'=$3::jsonb AND l.kind=ANY($4::text[])`,
          [
            input.throughInformationId,
            JSON.stringify(filter),
            JSON.stringify(input.address.destination),
            contract.kinds,
          ],
        );
        if (!bound.rows[0]) throw new ObservationConflictError();
        upper = bound.rows[0].position;
      }
      const sources = await tx.query<{
        information_id: string;
        position: string;
      }>(
        `SELECT l.information_id,l.position::text FROM information_lifecycle l JOIN information_atoms a USING(information_id)
         WHERE l.scope_key=$1 AND l.kind=ANY($2::text[]) AND l.position>$3::bigint
           AND ($4::bigint IS NULL OR l.position<=$4::bigint) AND a.payload->'source' @> $5::jsonb
           AND a.payload->'source'->'destination'=$7::jsonb
         ORDER BY l.position ASC LIMIT $6`,
        [
          legacyHeartbeatScope(input.address),
          contract.kinds,
          progress.rows[0]!.allocated_through,
          upper,
          JSON.stringify(filter),
          input.limit + 1,
          JSON.stringify(input.address.destination),
        ],
      );
      if (!sources.rows.length) return undefined;
      let page = sources.rows.slice(0, input.limit);
      // 来源集合来自持久 turn；正文缺失仍保留不完整页，不能借调用方清单越过缺口。
      const available = input.manifest
        ? await this.validateManifest(tx, contract, input.manifest)
        : undefined;
      if (available) {
        const first = available.has(page[0]!.information_id);
        const boundary = page.findIndex(
          (row) => available.has(row.information_id) !== first,
        );
        if (boundary > 0) page = page.slice(0, boundary);
      }
      const complete =
        !available || page.every((row) => available.has(row.information_id));
      // 补充版本必须显式属于同地址与 sender 范围；引用链不能替代读取范围校验。
      if (input.contextInformationIds.length) {
        const contexts = await tx.query<{ information_id: string }>(
          `SELECT a.information_id FROM information_atoms a
          WHERE a.information_id=ANY($1::text[]) AND a.payload->'source' @> $2::jsonb
            AND a.payload->'source'->'destination'=$3::jsonb`,
          [
            input.contextInformationIds,
            JSON.stringify(filter),
            JSON.stringify(input.address.destination),
          ],
        );
        if (
          new Set(contexts.rows.map((r) => r.information_id)).size !==
          new Set(input.contextInformationIds).size
        )
          throw new ObservationConflictError();
      }
      const id = randomUUID();
      await tx.query(
        `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,operation_key,manifest,received_through,complete)
        VALUES($1,$2,$3::bigint,$4::bigint,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,$10::bigint,$11)`,
        [
          id,
          streamId,
          progress.rows[0]!.allocated_through,
          page.at(-1)!.position,
          JSON.stringify(page.map((r) => r.information_id)),
          JSON.stringify([...new Set(input.contextInformationIds)]),
          sources.rows.length > page.length,
          input.operationKey ?? null,
          input.manifest ? JSON.stringify(input.manifest) : null,
          upper,
          complete,
        ],
      );
      await tx.query(
        `UPDATE information_observation_progress SET allocated_through=$2::bigint,revision=revision+1 WHERE stream_id=$1`,
        [streamId, page.at(-1)!.position],
      );
      return (await this.readIn(tx, id))!;
    });
  }
  /** 核对调用方摘要与已落账 turn/frame；不读取当前 Memory，也不重写原证据。 */
  private async validateManifest(
    tx: SqlTransaction,
    contract: ObservationSnapshot["contract"],
    manifest: ObservationManifest,
  ): Promise<Set<string>> {
    const filter = {
      ...contract.address,
      ...(contract.senderId ? { senderId: contract.senderId } : {}),
    };
    const proof = await tx.query<{ payload: unknown; position: string }>(
      `SELECT t.payload,b.position::text FROM information_atoms f
      JOIN information_atoms t ON t.information_id=f.payload->>'turnInformationId'
      JOIN information_atoms r ON r.information_id=t.payload->>'claimInformationId'
      JOIN information_lifecycle b ON b.information_id=t.payload->>'observedThroughInformationId'
      JOIN information_atoms a ON a.information_id=b.information_id
      JOIN information_lifecycle c ON c.information_id=f.information_id
      WHERE f.information_id=$1 AND r.information_id=$2 AND c.information_id=$3
        AND f.payload->'frame'=$4::jsonb AND b.position<c.position
        AND t.payload->'source' @> $5::jsonb AND t.payload->'source'->'destination'=$6::jsonb
        AND a.payload->'source' @> $5::jsonb AND a.payload->'source'->'destination'=$6::jsonb
        AND b.kind=ANY($7::text[])`,
      [
        manifest.frozenInformationId,
        manifest.runInformationId,
        manifest.knowledgeCutoff.informationId,
        JSON.stringify(manifest.content),
        JSON.stringify(filter),
        JSON.stringify(contract.address.destination),
        contract.kinds,
      ],
    );
    const parsed = z
      .object({
        inputs: z.array(
          z.object({
            informationId: z.string(),
            text: z.string(),
            source: z.record(z.string(), z.json()),
          }),
        ),
      })
      .safeParse(proof.rows[0]?.payload);
    if (!parsed.success) throw new ObservationConflictError();
    const inputs = parsed.data.inputs;
    const canonical = (ids: readonly string[]) =>
      JSON.stringify([...ids].sort());
    if (
      new Set(inputs.map((i) => i.informationId)).size !== inputs.length ||
      canonical(inputs.map((i) => i.informationId)) !==
        canonical(manifest.sourceInformationIds)
    )
      throw new ObservationConflictError();
    const sources = await tx.query(
      `SELECT a.information_id FROM jsonb_array_elements($1::jsonb) item
      JOIN information_atoms a ON a.information_id=item->>'informationId'
      JOIN information_lifecycle l ON l.information_id=a.information_id
      WHERE a.payload->'source'=item->'source' AND a.payload->>'text'=item->>'text'
        AND a.payload->'source' @> $2::jsonb AND a.payload->'source'->'destination'=$3::jsonb
        AND l.kind=ANY($4::text[]) AND l.position<=$5::bigint`,
      [
        JSON.stringify(inputs),
        JSON.stringify(filter),
        JSON.stringify(contract.address.destination),
        contract.kinds,
        proof.rows[0]!.position,
      ],
    );
    if (sources.rowCount !== inputs.length)
      throw new ObservationConflictError();
    const node = z.object({
      id: z.string(),
      metadata: z.object({ revision: z.number().int().positive() }),
    });
    const content = z
      .object({
        background: z.object({
          evidence: z.array(z.object({ id: z.string() })),
        }),
        memory: z
          .object({
            fixed: z.array(node),
            recalled: z.array(z.object({ node })).optional(),
            personCandidates: z.array(z.object({ summary: node })).optional(),
          })
          .optional(),
      })
      .safeParse(manifest.content);
    if (!content.success) throw new ObservationConflictError();
    const memory = content.data.memory;
    const revisions = new Map<string, number>();
    for (const n of [
      ...(memory?.fixed ?? []),
      ...(memory?.recalled ?? []).map((r) => r.node),
      ...(memory?.personCandidates ?? []).map((p) => p.summary),
    ]) {
      if (revisions.has(n.id) && revisions.get(n.id) !== n.metadata.revision)
        throw new ObservationConflictError();
      revisions.set(n.id, n.metadata.revision);
    }
    const normalized = (nodes: readonly { id: string; revision: number }[]) =>
      JSON.stringify([...nodes].sort((a, b) => a.id.localeCompare(b.id)));
    if (
      normalized([...revisions].map(([id, revision]) => ({ id, revision }))) !==
      normalized(manifest.knowledgeCutoff.memoryRevisions)
    )
      throw new ObservationConflictError();
    const evidence = new Set(content.data.background.evidence.map((e) => e.id));
    return new Set(
      inputs.map((i) => i.informationId).filter((id) => evidence.has(id)),
    );
  }
  async finish(id: string, result: string): Promise<ObservationSnapshot> {
    informationIdSchema.parse(result);
    return this.db.transaction(async (tx) => {
      const lock = await tx.query<{ stream_id: string }>(
        `SELECT stream_id FROM information_observations WHERE observation_id=$1`,
        [id],
      );
      if (!lock.rows[0]) throw new ObservationConflictError();
      await tx.query(
        `SELECT stream_id FROM information_observation_progress WHERE stream_id=$1 FOR UPDATE`,
        [lock.rows[0].stream_id],
      );
      const current = (await this.readIn(tx, id))!;
      if (current.status === "completed") {
        if (current.resultInformationId !== result)
          throw new ObservationConflictError();
        return current;
      }
      // Kind 与快照身份都必须匹配；各消费者不能借用另一个观察的完成事实。
      const resultAtom = await tx.query(
        `SELECT information_id FROM information_atoms WHERE information_id=$1
          AND kind=$2 AND payload->>'observationId'=$3`,
        [result, current.contract.resultKind, id],
      );
      if (!resultAtom.rowCount) throw new ObservationConflictError();
      // 成功依据必须直接引用全部来源和补充版本，不能用任意旧原子确认范围。
      const evidence = await tx.query<{ target_information_id: string }>(
        `SELECT target_information_id FROM information_references WHERE information_id=$1`,
        [result],
      );
      const refs = new Set(evidence.rows.map((r) => r.target_information_id));
      if (
        ![
          ...current.sourceInformationIds,
          ...current.contextInformationIds,
          ...(current.manifest
            ? [
                current.manifest.runInformationId,
                current.manifest.frozenInformationId,
              ]
            : []),
        ].every((source) => refs.has(source))
      )
        throw new ObservationConflictError();
      if (!current.complete || current.replacementObservationId)
        throw new ObservationConflictError();
      await tx.query(
        `UPDATE information_observations SET status='completed',result_information_id=$2,error_code=NULL,deferred_until=NULL WHERE observation_id=$1`,
        [id, result],
      );
      // Only adjacent successful ranges can extend the continuous watermark.
      const head = await tx.query<{ through_position: string }>(
        `SELECT through_position::text FROM information_observation_progress WHERE stream_id=$1`,
        [lock.rows[0].stream_id],
      );
      let through = head.rows[0]!.through_position;
      let latest: string | null = null;
      for (;;) {
        const next = await tx.query<{
          observation_id: string;
          through_position: string;
        }>(
          `SELECT observation_id,through_position::text FROM information_observations WHERE stream_id=$1 AND after_position=$2::bigint AND status='completed'`,
          [lock.rows[0].stream_id, through],
        );
        if (!next.rows[0]) break;
        through = next.rows[0].through_position;
        latest = next.rows[0].observation_id;
      }
      await tx.query(
        `UPDATE information_observation_progress SET through_position=$2::bigint,
        latest_observation_id=COALESCE($3,latest_observation_id),revision=revision+1 WHERE stream_id=$1`,
        [lock.rows[0].stream_id, through, latest],
      );
      return (await this.readIn(tx, id))!;
    });
  }
  private async initialize(tx: SqlTransaction, input: ObservationInput) {
    const streamId = identity(input);
    await tx.query(
      `INSERT INTO information_scenes(scene_id,address,legacy_scope_key) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING`,
      [
        sceneIdentity(input.address),
        JSON.stringify(input.address),
        legacyHeartbeatScope(input.address),
      ],
    );
    let start = "0";
    if (input.startAfterInformationId) {
      const bound = await tx.query<{ position: string }>(
        `SELECT position::text FROM information_lifecycle WHERE information_id=$1`,
        [input.startAfterInformationId],
      );
      if (!bound.rows[0]) throw new ObservationConflictError();
      start = bound.rows[0].position;
    }
    await tx.query(
      `INSERT INTO information_observation_progress(stream_id,scene_id,consumer_id,policy_version,contract,through_position,allocated_through,discovered_through)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::bigint,$6::bigint,$6::bigint) ON CONFLICT DO NOTHING`,
      [
        streamId,
        sceneIdentity(input.address),
        input.consumerId,
        input.policyVersion,
        JSON.stringify(input),
        start,
      ],
    );
    const check = await tx.query<{ matches: boolean }>(
      `SELECT contract=$2::jsonb AS matches FROM information_observation_progress WHERE stream_id=$1 FOR UPDATE`,
      [streamId, JSON.stringify(input)],
    );
    if (!check.rows[0]?.matches) throw new ObservationConflictError();
    const filter = {
      ...input.address,
      ...(input.senderId ? { senderId: input.senderId } : {}),
    };
    await tx.query(
      `UPDATE information_observation_progress SET discovered_through=GREATEST(discovered_through,COALESCE((
      SELECT max(l.position) FROM information_lifecycle l JOIN information_atoms a USING(information_id)
      WHERE l.scope_key=$2 AND l.kind=ANY($3::text[]) AND a.payload->'source' @> $4::jsonb
      AND a.payload->'source'->'destination'=$5::jsonb),0)) WHERE stream_id=$1`,
      [
        streamId,
        legacyHeartbeatScope(input.address),
        input.kinds,
        JSON.stringify(filter),
        JSON.stringify(input.address.destination),
      ],
    );
  }
  async discover(raw: ObservationInput): Promise<ObservationProgress> {
    const input = normalize(raw);
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,168))", [
        legacyHeartbeatScope(input.address),
      ]);
      await this.initialize(tx, input);
    });
    return (await this.progress(input))!;
  }
  async pending(
    raw: ObservationInput,
  ): Promise<readonly ObservationSnapshot[]> {
    const input = normalize(raw);
    await this.progress(input); // rejects changed contracts
    return (
      await this.db.query<SnapshotRow>(
        snapshotSelect +
          ` WHERE o.stream_id=$1 AND o.status <> 'completed' AND o.replacement_observation_id IS NULL ORDER BY o.after_position`,
        [identity(input)],
      )
    ).rows.map(snapshot);
  }
  async defer(
    id: string,
    until: string,
    scheduleInformationId: string,
  ): Promise<void> {
    if (!Number.isFinite(Date.parse(until)))
      throw new ObservationConflictError();
    await this.db.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE information_observations SET deferred_until=$2::timestamptz,schedule_information_id=$3
        WHERE observation_id=$1 AND status <> 'completed' RETURNING observation_id`,
        [id, until, scheduleInformationId],
      );
      if (!changed.rowCount) throw new ObservationConflictError();
      await tx.query(
        `INSERT INTO information_observation_attempts(observation_id,event,detail) VALUES($1,'deferred',$2::jsonb)`,
        [id, JSON.stringify({ until, scheduleInformationId })],
      );
    });
  }
  async replace(
    id: string,
    operationKey: string,
    raw: ObservationManifest,
  ): Promise<ObservationSnapshot> {
    const manifest = observationManifestSchema.parse(raw);
    if (!operationKey || operationKey.length > 1000)
      throw new ObservationConflictError();
    return this.db.transaction(async (tx) => {
      const row = await tx.query<{ stream_id: string }>(
        `SELECT stream_id FROM information_observations WHERE observation_id=$1`,
        [id],
      );
      if (!row.rows[0]) throw new ObservationConflictError();
      const streamId = row.rows[0].stream_id;
      await tx.query(
        `SELECT 1 FROM information_observation_progress WHERE stream_id=$1 FOR UPDATE`,
        [streamId],
      );
      const replay = await tx.query<SnapshotRow>(
        snapshotSelect + ` WHERE o.stream_id=$1 AND o.operation_key=$2`,
        [streamId, operationKey],
      );
      if (replay.rows[0]) return snapshot(replay.rows[0]);
      const previous = (await this.readIn(tx, id))!;
      if (
        previous.status === "completed" ||
        previous.replacementObservationId ||
        !previous.sourceInformationIds.every((source) =>
          manifest.sourceInformationIds.includes(source),
        )
      )
        throw new ObservationConflictError();
      const available = await this.validateManifest(
        tx,
        previous.contract,
        manifest,
      );
      if (
        !previous.sourceInformationIds.every((source) => available.has(source))
      )
        throw new ObservationConflictError();
      const replacement = randomUUID();
      await tx.query(
        `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,operation_key,manifest,received_through,complete)
        SELECT $2,stream_id,after_position,through_position,source_ids,context_ids,has_more,$3,$4::jsonb,received_through,true FROM information_observations WHERE observation_id=$1`,
        [id, replacement, operationKey, JSON.stringify(manifest)],
      );
      await tx.query(
        `UPDATE information_observations SET replacement_observation_id=$2 WHERE observation_id=$1`,
        [id, replacement],
      );
      await tx.query(
        `INSERT INTO information_observation_attempts(observation_id,event,detail) VALUES($1,'superseded',$2::jsonb)`,
        [id, JSON.stringify({ replacement })],
      );
      return (await this.readIn(tx, replacement))!;
    });
  }
  async supersede(id: string, replacement: string): Promise<void> {
    if (id === replacement) throw new ObservationConflictError();
    await this.db.transaction(async (tx) => {
      const owner = await tx.query<{ stream_id: string }>(
        `SELECT stream_id FROM information_observations WHERE observation_id=$1`,
        [id],
      );
      if (!owner.rows[0]) throw new ObservationConflictError();
      await tx.query(
        `SELECT 1 FROM information_observation_progress WHERE stream_id=$1 FOR UPDATE`,
        [owner.rows[0].stream_id],
      );
      const changed = await tx.query(
        `UPDATE information_observations o SET replacement_observation_id=$2
        FROM information_observations r WHERE o.observation_id=$1 AND r.observation_id=$2 AND o.status <> 'completed'
        AND r.stream_id=o.stream_id AND r.after_position<=o.after_position AND r.through_position>=o.through_position
        AND r.replacement_observation_id IS NULL AND (o.replacement_observation_id IS NULL OR o.replacement_observation_id=$2)
        RETURNING o.observation_id`,
        [id, replacement],
      );
      if (!changed.rowCount) throw new ObservationConflictError();
      await tx.query(
        `INSERT INTO information_observation_attempts(observation_id,event,detail) VALUES($1,'superseded',$2::jsonb)`,
        [id, JSON.stringify({ replacement })],
      );
    });
  }
  async fail(id: string, errorCode: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(errorCode))
      throw new ObservationConflictError();
    await this.db.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE information_observations SET
        status=CASE WHEN status='completed' THEN status ELSE 'failed' END,
        error_code=CASE WHEN status='completed' THEN error_code ELSE $2 END
        WHERE observation_id=$1 RETURNING status`,
        [id, errorCode],
      );
      if (!changed.rowCount) throw new ObservationConflictError();
      if (changed.rows[0]?.status !== "completed")
        await tx.query(
          `INSERT INTO information_observation_attempts(observation_id,event,detail) VALUES($1,'failed',$2::jsonb)`,
          [id, JSON.stringify({ errorCode })],
        );
    });
  }

  async read(id: string): Promise<ObservationSnapshot | undefined> {
    return this.readIn(this.db, id);
  }
  private async readIn(
    tx: SqlTransaction,
    id: string,
  ): Promise<ObservationSnapshot | undefined> {
    const rows = await tx.query<SnapshotRow>(
      snapshotSelect + ` WHERE o.observation_id=$1`,
      [id],
    );
    return rows.rows[0] ? snapshot(rows.rows[0]) : undefined;
  }
  async progress(
    raw: ObservationInput,
  ): Promise<ObservationProgress | undefined> {
    const input = normalize(raw);
    const result = await this.db.query<{
      scene_id: string;
      consumer_id: string;
      policy_version: string;
      contract: ObservationInput;
      matches: boolean;
      through_position: string;
      through_information_id: string | null;
      discovered_through: string;
      allocated_through: string;
      revision: number;
      latest_observation_id: string | null;
    }>(
      `SELECT scene_id,consumer_id,policy_version,contract,contract=$2::jsonb AS matches,through_position::text,latest_observation_id,discovered_through::text,allocated_through::text,revision,
      (SELECT information_id FROM information_lifecycle WHERE position=p.through_position) AS through_information_id
      FROM information_observation_progress p WHERE stream_id=$1`,
      [identity(input), JSON.stringify(input)],
    );
    const row = result.rows[0];
    if (row && !row.matches) throw new ObservationConflictError();
    return row
      ? {
          sceneId: row.scene_id,
          consumerId: row.consumer_id,
          policyVersion: row.policy_version,
          address: row.contract.address,
          throughPosition: row.through_position,
          throughInformationId: row.through_information_id,
          discoveredThroughPosition: row.discovered_through,
          allocatedThroughPosition: row.allocated_through,
          revision: row.revision,
          latestObservationId: row.latest_observation_id,
        }
      : undefined;
  }
}
