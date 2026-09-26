/**
 * 功能概述：在同场景提交锁下冻结按注册顺序排列的有界证据，维护消费者独立成功进度。
 * freezeNext 串行保留每个 stream 唯一开放快照；重试复用来源/上下文，不按发生时间丢弃迟到消息。
 * finish 将完成投影与进度原子提交，成功事实先由消费者持久登记；fail 仅记录受控错误码，read/progress 提供恢复与检视。
 * 代码库关系：复用 InformationRepository 的 scope advisory lock 和 lifecycle.position；经 SDK capability 暴露。
 * 输入输出与副作用：执行参数化 SQL 与行锁；stream 契约不可静默更改，来源页上限只推进实际冻结上界。
 */
import { randomUUID } from "node:crypto";
import {
  legacyHeartbeatScope,
  sceneIdentity,
  informationIdSchema,
} from "@kaguya/schema";
import {
  observationFreezeSchema,
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
};
const snapshotSelect = `SELECT o.observation_id,p.scene_id,p.consumer_id,p.policy_version,p.contract,
  o.after_position::text,o.through_position::text,o.source_ids,o.context_ids,o.recorded_at::text,
  o.status,o.result_information_id,o.error_code,o.has_more FROM information_observations o
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
      await tx.query(
        `INSERT INTO information_scenes(scene_id,address,legacy_scope_key) VALUES($1,$2::jsonb,$3)
        ON CONFLICT(scene_id) DO NOTHING`,
        [
          sceneId,
          JSON.stringify(input.address),
          legacyHeartbeatScope(input.address),
        ],
      );
      await tx.query(
        `INSERT INTO information_observation_progress(stream_id,scene_id,consumer_id,policy_version,contract)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(stream_id) DO NOTHING`,
        [
          streamId,
          sceneId,
          input.consumerId,
          input.policyVersion,
          JSON.stringify(contract),
        ],
      );
      const progress = await tx.query<{
        through_position: string;
        matches: boolean;
      }>(
        `SELECT through_position::text,contract=$2::jsonb AS matches FROM information_observation_progress WHERE stream_id=$1 FOR UPDATE`,
        [streamId, JSON.stringify(contract)],
      );
      if (!progress.rows[0]?.matches) throw new ObservationConflictError();
      const open = await tx.query<SnapshotRow>(
        snapshotSelect + ` WHERE o.stream_id=$1 AND o.status <> 'completed'`,
        [streamId],
      );
      if (open.rows[0]) return snapshot(open.rows[0]);
      let upper: string | null = null;
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
          progress.rows[0].through_position,
          upper,
          JSON.stringify(filter),
          input.limit + 1,
          JSON.stringify(input.address.destination),
        ],
      );
      if (!sources.rows.length) return undefined;
      const page = sources.rows.slice(0, input.limit);
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
        `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more)
        VALUES($1,$2,$3::bigint,$4::bigint,$5::jsonb,$6::jsonb,$7)`,
        [
          id,
          streamId,
          progress.rows[0].through_position,
          page.at(-1)!.position,
          JSON.stringify(page.map((r) => r.information_id)),
          JSON.stringify([...new Set(input.contextInformationIds)]),
          sources.rows.length > input.limit,
        ],
      );
      return (await this.readIn(tx, id))!;
    });
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
        ].every((source) => refs.has(source))
      )
        throw new ObservationConflictError();
      const advanced = await tx.query(
        `UPDATE information_observation_progress SET through_position=$2::bigint,latest_observation_id=$3
        WHERE stream_id=$1 AND through_position=$4::bigint RETURNING stream_id`,
        [
          lock.rows[0].stream_id,
          current.throughPosition,
          id,
          current.afterPosition,
        ],
      );
      if (!advanced.rowCount) throw new ObservationConflictError();
      await tx.query(
        `UPDATE information_observations SET status='completed',result_information_id=$2,error_code=NULL WHERE observation_id=$1`,
        [id, result],
      );
      return (await this.readIn(tx, id))!;
    });
  }
  async fail(id: string, errorCode: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(errorCode))
      throw new ObservationConflictError();
    const changed = await this.db.query(
      `UPDATE information_observations SET
        status=CASE WHEN status='completed' THEN status ELSE 'failed' END,
        error_code=CASE WHEN status='completed' THEN error_code ELSE $2 END
        WHERE observation_id=$1 RETURNING observation_id`,
      [id, errorCode],
    );
    if (!changed.rowCount) throw new ObservationConflictError();
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
      latest_observation_id: string | null;
    }>(
      `SELECT scene_id,consumer_id,policy_version,contract,contract=$2::jsonb AS matches,through_position::text,latest_observation_id FROM information_observation_progress WHERE stream_id=$1`,
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
          latestObservationId: row.latest_observation_id,
        }
      : undefined;
  }
}
