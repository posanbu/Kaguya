/**
 * 功能概述：为跨领域 Inspection 提供有界、无行锁的只读事务，不创建事实或推进消费者。
 * withInspectionRead 在同一 repeatable-read 快照读取上界和投影；InspectionReader 的列表使用
 * 不可变身份分页，当前状态另由调用方标注读取时间。fact/related 只读已有 Information 引用。
 * 代码库关系：server 的领域投影调用本端口；复用 observation/native-tool/action/native Memory 原表。
 * 输入输出与副作用：仅参数化 SELECT 和只读事务设置，无回填、租约、运行恢复或外部调用。
 */
import { createHash } from "node:crypto";
import { PostgresActionStore } from "./action-store.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

export type InspectionRow = Record<string, any>;
export interface InspectionBoundary {
  position: string;
  recordedAt: string;
}
export interface InspectionFact {
  id: string;
  kind: string;
  at: string;
  position: string;
  payload: InspectionRow;
  references: { relation: string; informationId: string }[];
}
const factColumns = `a.information_id id,a.kind,a.occurred_at at,l.position::text position,a.payload,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',r.relation,'informationId',r.target_information_id))
    FROM (SELECT relation,target_information_id FROM information_references WHERE information_id=a.information_id ORDER BY relation,target_information_id LIMIT 101) r),'[]'::jsonb) "references"`;
// Same host-derived scope used by native Memory and action. Legacy display keys are not authorization keys.
const observationScope = `jsonb_build_array(p.contract->'address'->>'platform',p.contract->'address'->>'adapterId',
  p.contract->'address'->'destination'->>'kind',COALESCE(p.contract->'address'->'destination'->>'userId',
  p.contract->'address'->'destination'->>'groupId',p.contract->'address'->'destination'->>'conversationId'))`;
const directoryLimit = 500;
const directoryKinds: Record<string, string> = {
  runs: "agent.heavy.tool.run.v1",
  actions: "core.action.intent.v1",
  "gui-tasks": "agent.gui.task.requested.v1",
};
export class InspectionReader {
  private readonly directories = new Map<
    string,
    { ids: string[]; stamp: string; truncated: boolean }
  >();
  constructor(
    readonly tx: SqlTransaction,
    readonly boundary: InspectionBoundary,
    private readonly actions: PostgresActionStore,
  ) {}
  async rows(
    sql: string,
    args: readonly unknown[] = [],
  ): Promise<InspectionRow[]> {
    return (await this.tx.query(sql, args)).rows;
  }
  async fact(id: string): Promise<InspectionFact | undefined> {
    return (
      await this.tx.query<InspectionFact & InspectionRow>(
        `SELECT ${factColumns} FROM information_atoms a JOIN information_lifecycle l USING(information_id)
       WHERE a.information_id=$1 AND l.position<=$2::bigint`,
        [id, this.boundary.position],
      )
    ).rows[0];
  }
  async facts(
    kinds: string[],
    scope: string,
    before: string | null,
    limit: number,
  ) {
    const binding = Object.keys(directoryKinds).find(
      (k) => directoryKinds[k] === kinds[0],
    );
    const window = binding
      ? await this.directory(binding, scope, null)
      : undefined;
    return (
      await this.tx.query<InspectionFact & InspectionRow>(
        `SELECT ${factColumns} FROM information_atoms a JOIN information_lifecycle l USING(information_id)
       WHERE a.information_id=ANY($6::text[]) AND a.kind=ANY($1::text[]) AND COALESCE(a.payload->>'scope',a.payload->'spec'->>'scope',a.payload->'intent'->>'scope')=$2
       AND l.position<=$3::bigint AND ($4::bigint IS NULL OR l.position<$4::bigint)
       ORDER BY l.position DESC LIMIT $5`,
        [
          kinds,
          scope,
          this.boundary.position,
          before,
          limit,
          window?.ids ?? [],
        ],
      )
    ).rows;
  }
  async related(id: string, kinds: string[], relation: string, limit = 101) {
    return (
      await this.tx.query<InspectionFact & InspectionRow>(
        `SELECT ${factColumns} FROM information_atoms a JOIN information_lifecycle l USING(information_id)
       WHERE a.kind=ANY($1::text[]) AND l.position<=$2::bigint AND EXISTS
       (SELECT 1 FROM information_references r WHERE r.information_id=a.information_id AND r.target_information_id=$3 AND r.relation=$4)
       ORDER BY l.position DESC LIMIT $5`,
        [kinds, this.boundary.position, id, relation, limit],
      )
    ).rows;
  }
  async observations(
    scope: string,
    consumer: string | null,
    before: string | null,
    limit: number,
    id?: string,
  ) {
    let jsonScope: string | null = null;
    try {
      jsonScope = JSON.stringify(JSON.parse(scope));
    } catch {
      /* Non-chat scopes cannot address a chat observation. */
    }
    const window =
      id === undefined
        ? await this.directory("observations", scope, consumer)
        : undefined;
    return this.rows(
      `SELECT o.*,o.after_position::text,o.through_position::text,o.received_through::text,
      o.recorded_at::text,o.deferred_until::text,p.scene_id,p.consumer_id,p.policy_version,p.contract
      FROM information_observations o JOIN information_observation_progress p USING(stream_id)
      WHERE ($7::text[] IS NULL OR o.observation_id=ANY($7::text[])) AND ${observationScope}=$1::jsonb AND ($2::text IS NULL OR p.consumer_id=$2)
      AND o.recorded_at<=$3::timestamptz AND ($4::text IS NULL OR o.observation_id<$4)
      AND ($6::text IS NULL OR o.observation_id=$6) ORDER BY o.observation_id DESC LIMIT $5`,
      [
        jsonScope,
        consumer,
        this.boundary.recordedAt,
        before,
        limit,
        id ?? null,
        window?.ids ?? null,
      ],
    );
  }
  async progress(
    scope: string,
    consumer: string | null,
    before: string | null,
    limit: number,
  ) {
    const window = await this.directory("progress", scope, consumer);
    return this.rows(
      `SELECT p.stream_id,p.scene_id,p.consumer_id,p.policy_version,p.contract,p.revision,
      p.through_position::text,p.discovered_through::text,p.allocated_through::text,p.latest_observation_id,
      (SELECT count(*)::text FROM information_observations o WHERE o.stream_id=p.stream_id
        AND o.replacement_observation_id IS NULL AND o.status<>'completed') open_count
      FROM information_observation_progress p JOIN information_scenes s USING(scene_id)
      WHERE p.stream_id=ANY($6::text[]) AND ${observationScope}=$1::jsonb AND ($2::text IS NULL OR p.consumer_id=$2)
      AND s.created_at<=$3::timestamptz AND ($4::text IS NULL OR p.stream_id<$4)
      ORDER BY p.stream_id DESC LIMIT $5`,
      [scope, consumer, this.boundary.recordedAt, before, limit, window!.ids],
    );
  }
  async directory(binding: string, scope: string, consumer: string | null) {
    const key = JSON.stringify([binding, scope, consumer]);
    const cached = this.directories.get(key);
    if (cached) return cached;
    let rows: InspectionRow[];
    if (binding === "observations")
      rows = await this.rows(
        `SELECT o.observation_id id
      FROM information_observations o JOIN information_observation_progress p USING(stream_id)
      WHERE ${observationScope}=$1::jsonb AND ($2::text IS NULL OR p.consumer_id=$2) AND o.recorded_at<=$3::timestamptz
      ORDER BY o.recorded_at DESC,o.observation_id DESC LIMIT $4`,
        [scope, consumer, this.boundary.recordedAt, directoryLimit + 1],
      );
    else if (binding === "progress")
      rows = await this.rows(
        `SELECT p.stream_id id FROM information_observation_progress p
      WHERE ${observationScope}=$1::jsonb AND ($2::text IS NULL OR p.consumer_id=$2)
      ORDER BY p.stream_id DESC LIMIT $3`,
        [scope, consumer, directoryLimit + 1],
      );
    else {
      const kind = directoryKinds[binding];
      if (!kind) return undefined;
      rows = await this.rows(
        `SELECT a.information_id id FROM information_atoms a JOIN information_lifecycle l USING(information_id)
        WHERE a.kind=$1 AND COALESCE(a.payload->>'scope',a.payload->'spec'->>'scope',a.payload->'intent'->>'scope')=$2 AND l.position<=$3::bigint
        ORDER BY l.position DESC LIMIT $4`,
        [kind, scope, this.boundary.position, directoryLimit + 1],
      );
    }
    const result = {
      ids: rows.slice(0, directoryLimit).map((r) => r.id as string),
      truncated: rows.length > directoryLimit,
      stamp: createHash("sha256")
        .update(JSON.stringify(rows.map((r) => r.id)))
        .digest("hex"),
    };
    this.directories.set(key, result);
    return result;
  }
  async holes(stream: string) {
    return this.rows(
      `SELECT observation_id,after_position::text,through_position::text,status,error_code,complete,
      deferred_until::text FROM information_observations WHERE stream_id=$1 AND replacement_observation_id IS NULL
      AND status<>'completed' ORDER BY after_position,observation_id LIMIT 101`,
      [stream],
    );
  }
  async attempts(id: string) {
    return this.rows(
      `SELECT ordinal::text,event,detail,recorded_at::text FROM information_observation_attempts
      WHERE observation_id=$1 ORDER BY ordinal DESC LIMIT 101`,
      [id],
    );
  }
  async run(id: string, scope: string) {
    return (
      await this.rows(
        `SELECT run_id,spec,origin_key,context_id,stopped_id,steps_count,calls_count,output_bytes
      FROM information_native_tool_runs WHERE run_id=$1 AND spec->>'scope'=$2`,
        [id, scope],
      )
    )[0];
  }
  async steps(id: string) {
    return this.rows(
      `SELECT step_index,frozen_id,request_id,dispatched_id FROM information_native_tool_steps
      WHERE run_id=$1 ORDER BY step_index LIMIT 33`,
      [id],
    );
  }
  async calls(id: string) {
    return this.rows(
      `SELECT step_index,call_index,call_id,completed_id,call,intent_id,result_id
      FROM information_native_tool_calls WHERE run_id=$1 ORDER BY step_index,call_index LIMIT 129`,
      [id],
    );
  }
  async action(id: string, scope: string) {
    return (
      await this.rows(
        `SELECT intent_id,input,state,attempt_id,started_id,receipt_id,cancellation_id
      FROM information_action_heads WHERE intent_id=$1 AND input->>'scope'=$2`,
        [id, scope],
      )
    )[0];
  }
  async receipt(id: string, scope: string) {
    try {
      const receipt = await this.actions.inspectReceipt(id, scope, this.tx);
      return BigInt(receipt.registeredPosition) <=
        BigInt(this.boundary.position)
        ? receipt
        : undefined;
    } catch (error) {
      if (
        error instanceof Error &&
        (/^(receipt-|action-not-found|action-outcome-|action-artifact-)/.test(
          error.message,
        ) ||
          error.name === "ZodError")
      )
        return undefined;
      throw error;
    }
  }
  async receipts(id: string) {
    return (
      await this.tx.query<InspectionFact & InspectionRow>(
        `SELECT ${factColumns} FROM information_action_receipts r JOIN information_atoms a ON a.information_id=r.receipt_id
       JOIN information_lifecycle l ON l.information_id=a.information_id
       WHERE r.intent_id=$1 AND l.position<=$2::bigint ORDER BY l.position DESC LIMIT 101`,
        [id, this.boundary.position],
      )
    ).rows;
  }
  async cancellation(originKey: string) {
    return (
      await this.tx.query<InspectionFact & InspectionRow>(
        `SELECT ${factColumns} FROM information_atoms a JOIN information_lifecycle l USING(information_id)
       WHERE a.kind IN ('agent.heavy.tool.origin.cancelled.v1','agent.heavy.tool.cancel.forwarded.v1')
       AND a.payload->>'originKey'=$1 AND l.position<=$2::bigint ORDER BY l.position LIMIT 3`,
        [originKey, this.boundary.position],
      )
    ).rows;
  }
  async revisions(
    id: string,
    upper: string,
    before: string | null,
    limit: number,
  ) {
    return this.rows(
      `SELECT p.information_id,l.position::text,item node FROM memory_native_publications p
      JOIN information_lifecycle l ON l.information_id=p.information_id
      CROSS JOIN LATERAL jsonb_array_elements(p.nodes) item
      WHERE item->>'id'=$1 AND l.position<=$2::bigint AND ($3::bigint IS NULL OR l.position<$3::bigint)
      ORDER BY l.position DESC LIMIT $4`,
      [id, upper, before, limit],
    );
  }
}
export async function withInspectionRead<T>(
  db: SqlDatabase,
  run: (reader: InspectionReader) => Promise<T>,
  requested?: InspectionBoundary,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const current = (
      await tx.query<{ position: string; recordedAt: string }>(
        `SELECT COALESCE(max(position),0)::text position,clock_timestamp()::text "recordedAt" FROM information_lifecycle`,
      )
    ).rows[0]!;
    return run(
      new InspectionReader(
        tx,
        requested ?? current,
        new PostgresActionStore(db),
      ),
    );
  });
}
export {
  readMemoryView,
  readMemoryInvalidations,
} from "./native-memory-history.js";
export { persistedSourceProofOwners } from "./native-memory-proof.js";
