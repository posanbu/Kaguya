/**
 * 功能概述：实现 Reliable DAG 的 PostgreSQL 执行基础，独立于不可变业务 ledger。
 * 主要职责：configureSubscriptions 启停稳定订阅且不 backfill；claim 使用 SKIP LOCKED 与期限 token；
 * ack/retry/release 使用 fencing；appendOnce/appendTerminal 将唯一槽和 atom 原子提交；exhaust 原子封口。
 * 代码库关系：InformationRepository 注入事务内 append/read 函数，本类不绕过引用校验；Core/Runner 经端口调用。
 * 输入输出与副作用：执行表可变而业务 atom 不可变，失败整笔回滚；指标只有计数和时间，不保存异常或正文。
 */
import { randomUUID } from "node:crypto";
import type {
  DeepReadonly,
  InformationAtom,
  InformationId,
} from "@kaguya/schema";
import type {
  DurableSubscriptionDefinition,
  InformationAppendOptions,
  InformationClaim,
  InformationCommitResult,
  InformationExecutionHealth,
  InformationReferenceExpectation,
  ReliableInformationLedger,
} from "@kaguya/engine";
import { InformationClaimLostError } from "@kaguya/engine";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

type Append = (
  tx: SqlTransaction,
  atom: DeepReadonly<InformationAtom>,
  expectations: readonly InformationReferenceExpectation[],
  options?: InformationAppendOptions,
) => Promise<void>;
type Read = (
  tx: SqlTransaction,
  id: InformationId,
) => Promise<DeepReadonly<InformationAtom> | undefined>;

export class ReliableInformationRepository implements ReliableInformationLedger {
  constructor(
    private readonly db: SqlDatabase,
    private readonly append: Append,
    private readonly read: Read,
  ) {}

  async configureSubscriptions(
    subscriptions: readonly DurableSubscriptionDefinition[],
  ): Promise<void> {
    const ids = new Set<string>();
    for (const s of subscriptions) {
      identity(s.subscriptionId);
      if (ids.has(s.subscriptionId))
        throw new Error("Duplicate durable subscription");
      ids.add(s.subscriptionId);
    }
    await this.db.transaction(async (tx) => {
      // 单 Runtime 的完整 activation 集合；原有未 ack 记录保留，重新启用不扫描历史。
      await tx.query("UPDATE information_subscriptions SET enabled = false");
      for (const s of subscriptions) {
        const result = await tx.query(
          `INSERT INTO information_subscriptions(subscription_id, kind, enabled) VALUES ($1,$2,true)
           ON CONFLICT(subscription_id) DO UPDATE SET enabled = true
           WHERE information_subscriptions.kind = EXCLUDED.kind RETURNING subscription_id`,
          [s.subscriptionId, s.kind],
        );
        if (!result.rowCount)
          throw new Error("Durable subscription identity changed kind");
      }
    });
  }

  async claim(
    subscriptionId: string,
    leaseMs: number,
  ): Promise<InformationClaim | undefined> {
    milliseconds(leaseMs, false);
    const token = randomUUID();
    const result = await this.db.query<{
      information_id: string;
      attempts: number;
      lease_until: string;
    }>(
      `WITH candidate AS (
         SELECT d.subscription_id, d.information_id FROM information_deliveries d
         JOIN information_subscriptions s USING (subscription_id)
         WHERE d.subscription_id = $1 AND s.enabled
           AND ((d.state = 'pending' AND d.available_at <= clock_timestamp())
             OR (d.state = 'claimed' AND d.lease_until <= clock_timestamp()))
         ORDER BY d.created_at, d.information_id FOR UPDATE OF d SKIP LOCKED LIMIT 1
       ) UPDATE information_deliveries d SET state = 'claimed', token = $2,
           attempts = d.attempts + 1, lease_until = clock_timestamp() + $3 * interval '1 millisecond'
       FROM candidate c WHERE d.subscription_id = c.subscription_id AND d.information_id = c.information_id
       RETURNING d.information_id, d.attempts, d.lease_until::text`,
      [subscriptionId, token, leaseMs],
    );
    const row = result.rows[0];
    return (
      row && {
        subscriptionId,
        informationId: row.information_id as InformationId,
        token,
        attempt: row.attempts,
        leaseUntil: row.lease_until,
      }
    );
  }

  ack(claim: InformationClaim): Promise<boolean> {
    return this.updateClaim(
      claim,
      "state = 'acked', token = NULL, lease_until = NULL",
    );
  }
  retry(claim: InformationClaim, delayMs: number): Promise<boolean> {
    milliseconds(delayMs, true);
    return this.updateClaim(
      claim,
      "state = 'pending', token = NULL, lease_until = NULL, available_at = clock_timestamp() + $4 * interval '1 millisecond'",
      [delayMs],
    );
  }
  release(claim: InformationClaim): Promise<boolean> {
    return this.updateClaim(
      claim,
      "state = 'pending', token = NULL, lease_until = NULL, attempts = GREATEST(0, attempts - 1), available_at = clock_timestamp()",
    );
  }
  private async updateClaim(
    claim: InformationClaim,
    assignments: string,
    values: readonly unknown[] = [],
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE information_deliveries SET ${assignments}
      WHERE subscription_id = $1 AND information_id = $2 AND token = $3
        AND state = 'claimed' AND lease_until > clock_timestamp()`,
      [claim.subscriptionId, claim.informationId, claim.token, ...values],
    );
    return result.rowCount === 1;
  }
  async health(): Promise<InformationExecutionHealth> {
    const r = await this.db.query<{
      pending: string;
      retry: string;
      exhausted: string;
      age: string;
    }>(
      `SELECT count(*) FILTER (WHERE state IN ('pending','claimed'))::text AS pending,
        count(*) FILTER (WHERE ((state = 'pending' AND attempts > 0) OR (state = 'claimed' AND attempts > 1)))::text AS retry,
        count(*) FILTER (WHERE state = 'exhausted')::text AS exhausted,
        COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at) FILTER (WHERE state IN ('pending','claimed')))) * 1000, 0)::text AS age
       FROM information_deliveries`,
    );
    const row = r.rows[0]!;
    return {
      pending: Number(row.pending),
      retry: Number(row.retry),
      exhausted: Number(row.exhausted),
      oldestPendingAgeMs: Math.max(0, Number(row.age)),
    };
  }
  appendOnce(
    operation: string,
    key: string,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
    guard?: InformationClaim,
  ): Promise<InformationCommitResult> {
    return this.commit(
      "operation",
      operation,
      key,
      atom,
      expectations,
      options,
      guard,
    );
  }

  /**
   * Commit an operation while the caller owns an already-open transaction.
   * Scheduler projections use this boundary so the atom, slot, and mutable
   * arm row share one commit point.
   */
  appendOnceInTransaction(
    tx: SqlTransaction,
    operation: string,
    key: string,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
  ): Promise<InformationCommitResult> {
    identity(operation);
    if (!key || key.length > 4096)
      throw new Error("Invalid information operation key");
    return this.commitInTransaction(
      tx,
      "operation",
      operation,
      key,
      atom,
      expectations,
      options,
    );
  }
  appendTerminal(
    group: string,
    subject: InformationId,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
    guard?: InformationClaim,
  ): Promise<InformationCommitResult> {
    return this.commit(
      "terminal",
      group,
      subject,
      atom,
      expectations,
      options,
      guard,
    );
  }

  /** See `appendOnceInTransaction`; this variant races a terminal slot. */
  appendTerminalInTransaction(
    tx: SqlTransaction,
    group: string,
    subject: InformationId,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
  ): Promise<InformationCommitResult> {
    identity(group);
    return this.commitInTransaction(
      tx,
      "terminal",
      group,
      subject,
      atom,
      expectations,
      options,
    );
  }
  private async commit(
    type: string,
    namespace: string,
    key: string,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
    guard?: InformationClaim,
  ): Promise<InformationCommitResult> {
    identity(namespace);
    if (!key || key.length > 4096)
      throw new Error("Invalid information operation key");
    return this.db.transaction(async (tx) => {
      if (guard) await assertClaimInTransaction(tx, guard);
      if (type === "terminal" && !(await this.read(tx, key as InformationId)))
        throw new Error("Terminal subject does not exist");
      const result = await this.commitInTransaction(
        tx,
        type,
        namespace,
        key,
        atom,
        expectations,
        options,
      );
      // 再检期限，避免在长事务内过期后仍提交结果。
      if (guard) await assertClaimInTransaction(tx, guard);
      return result;
    });
  }
  private async commitInTransaction(
    tx: SqlTransaction,
    type: string,
    namespace: string,
    key: string,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions,
  ): Promise<InformationCommitResult> {
    // DEFERRABLE FK 允许先竞争唯一槽，再在同一事务写 atom；失败不会占住槽。
    const inserted = await tx.query(
      `INSERT INTO information_commit_slots(slot_type,namespace,key,information_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING information_id`,
      [type, namespace, key, atom.informationId],
    );
    if (inserted.rowCount === 1) {
      await this.append(tx, atom, expectations, options);
      return { atom, created: true };
    }
    const slot = await tx.query<{ information_id: string }>(
      "SELECT information_id FROM information_commit_slots WHERE slot_type=$1 AND namespace=$2 AND key=$3",
      [type, namespace, key],
    );
    const winner = await this.read(
      tx,
      slot.rows[0]!.information_id as InformationId,
    );
    if (!winner)
      throw new Error("Committed information slot is missing its atom");
    return { atom: winner, created: false };
  }
  async exhaust(
    claim: InformationClaim,
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await assertClaimInTransaction(tx, claim);
      await this.commitInTransaction(
        tx,
        "terminal",
        `execution.${claim.subscriptionId}`,
        claim.informationId,
        atom,
        expectations,
        {},
      );
      await assertClaimInTransaction(tx, claim);
      const updated = await tx.query(
        "UPDATE information_deliveries SET state='exhausted',token=NULL,lease_until=NULL WHERE subscription_id=$1 AND information_id=$2 AND token=$3 AND lease_until > clock_timestamp()",
        [claim.subscriptionId, claim.informationId, claim.token],
      );
      claim.signal?.throwIfAborted();
      if (updated.rowCount !== 1) throw new InformationClaimLostError();
      return true;
    });
  }
}
export async function assertClaimInTransaction(
  tx: SqlTransaction,
  claim: InformationClaim,
): Promise<void> {
  claim.signal?.throwIfAborted();
  const row = await tx.query(
    `SELECT token FROM information_deliveries WHERE subscription_id=$1 AND information_id=$2
    AND token=$3 AND state='claimed' AND lease_until > clock_timestamp() FOR UPDATE`,
    [claim.subscriptionId, claim.informationId, claim.token],
  );
  claim.signal?.throwIfAborted();
  if (row.rowCount !== 1) throw new InformationClaimLostError();
}
function identity(value: string): void {
  if (
    !/^[a-z][a-z0-9._:-]{0,399}$/.test(value) ||
    (!value.includes(".") && !value.includes(":"))
  )
    throw new Error("Expected stable namespaced execution identity");
}
function milliseconds(value: number, zero: boolean): void {
  if (
    !Number.isSafeInteger(value) ||
    value < (zero ? 0 : 1) ||
    value > 86_400_000
  )
    throw new Error("Invalid execution duration");
}
