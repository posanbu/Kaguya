/**
 * inspectReceipt 复用正式回执证明校验，仅读已认证管理端提供的只读事务，不签发执行授权或加行锁。
 * register/readReceipt 可复用宿主已持有的事务，供原生工具绑定与 Memory 桥接在同锁下最终验证。
 * 功能概述：持久保存行动身份、授权、取消、执行 claim 和回执，原子裁决副作用开始资格。
 * 主要职责：register 固定参数；admit 在 Memory 锁→action 行之后重验依据和授权；
 * finish 追加结果/核对事实，unknown 可澄清；intervene/invalidateRun/revoke 保留停止来源。
 * 代码库关系：Runtime ActionExecutor 独占 provider I/O，模块只能经 SDK 端口访问；
 * prepareActionSchema 增量建表，所有事实通过标准 appendInformationAtom 进入持久订阅/outbox。
 * prepareDelivery 保留失效 observation 的原身份，禁止降级 legacy；消息有效期从持久入队时刻计算。
 * 消息桥接可登记已经失效的宿主 intent，再由 admission 保存拒绝证据；普通工具 register 仍立即拒绝。
 * 输入输出与副作用：事务使用 READ COMMITTED，外部调用在提交后；lease 失效拒绝旧提交，
 * canInvoke 在调用前重新校验授权、冻结依赖与期限；started 恢复只产生 unknown，不重发。
 * 唯一事实与稳定操作身份不承诺外部 exactly-once。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  actionDecisionSchema,
  observationManifestSchema,
  type ActionDependencies,
  actionIntentSchema,
  actionOutcomeSchema,
  type ActionIntent,
  type ActionView,
  type ActionOutcome,
  type ActionReceipt,
  type ActionIntervention,
} from "@kaguya/sdk";
import { freezeInformationAtom, informationAtomSchema } from "@kaguya/schema";
import { type InformationClaim } from "@kaguya/engine";
import { assertClaimInTransaction } from "./reliable-repository.js";
import { loadActionProofContext } from "./action-proof-context.js";
import { checkActionDependencies } from "./action-dependencies.js";
import { continuityDeliveryProof } from "./continuity-delivery-proof.js";
import { appendInformationAtom } from "./information-repository.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

export function actionDigest(value: unknown): string {
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update("kaguya-action-canonical-json-v1\n")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function actionBasisDigest(
  i: Pick<
    ActionIntent,
    "runInformationId" | "decisionInformationId" | "dependencies"
  >,
) {
  return actionDigest({
    runInformationId: i.runInformationId,
    decisionInformationId: i.decisionInformationId,
    dependencies: i.dependencies,
  });
}
export function actionExecutionDigest(input: ActionIntent) {
  const {
    authorizationId: _id,
    authorizationVersion: _version,
    ...spec
  } = actionIntentSchema.parse(input);
  return actionDigest(spec);
}
export interface ActionAuthorization {
  executionDigest: string;
  id: string;
  scope: string;
  version: number;
  providerId: string;
  executor: string;
  targetDigest: string;
  argumentsDigest: string;
  operationId: string;
  basisDigest: string;
  expiresAt: string;
  causeInformationId: string;
}
export interface ActionClaim {
  intentId: string;
  attemptId: string;
  token: string;
}
type Row = Record<string, unknown> & {
  intent_id: string;
  input: ActionIntent;
  digest: string;
  state: ActionView["state"];
  attempt_id: string | null;
  started_id: string | null;
  receipt_id: string | null;
  cancellation_id: string | null;
  token: string | null;
  live: boolean;
  legacy_delivery: boolean;
};
const view = (r: Row): ActionView => ({
  intentId: r.intent_id,
  intent: r.input,
  digest: r.digest,
  state: r.state,
  attemptId: r.attempt_id,
  startedInformationId: r.started_id,
  receiptId: r.receipt_id,
  cancellationId: r.cancellation_id,
});
const select =
  "SELECT *,lease_until>clock_timestamp() live FROM information_action_heads";

export async function prepareActionSchema(db: SqlDatabase) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(249)");
    await tx.exec(`CREATE TABLE IF NOT EXISTS information_action_authorizations (
      id text PRIMARY KEY, input jsonb NOT NULL, revoked_id text REFERENCES information_atoms(information_id));
      CREATE TABLE IF NOT EXISTS information_action_runs (run_id text PRIMARY KEY REFERENCES information_atoms(information_id),scope text NOT NULL,invalidated_id text REFERENCES information_atoms(information_id));
      CREATE TABLE IF NOT EXISTS information_action_heads (
        intent_id text PRIMARY KEY REFERENCES information_atoms(information_id), operation_id text NOT NULL UNIQUE,
        input jsonb NOT NULL,digest text NOT NULL,state text NOT NULL,
        attempt_id text,started_id text REFERENCES information_atoms(information_id),receipt_id text REFERENCES information_atoms(information_id),
        cancellation_id text REFERENCES information_atoms(information_id),token text,lease_until timestamptz,
        legacy_delivery boolean NOT NULL DEFAULT false);
      CREATE INDEX IF NOT EXISTS information_action_recovery ON information_action_heads(state,lease_until);
      CREATE TABLE IF NOT EXISTS information_action_receipts (
        receipt_id text PRIMARY KEY REFERENCES information_atoms(information_id),intent_id text NOT NULL REFERENCES information_action_heads(intent_id),
        receipt_key text NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS information_action_outbox (
        intent_id text PRIMARY KEY REFERENCES information_action_heads(intent_id),started_id text NOT NULL REFERENCES information_atoms(information_id),
        acknowledged boolean NOT NULL DEFAULT false);`);
  });
}

export class PostgresActionStore {
  constructor(private readonly db: SqlDatabase) {}
  private async transaction<T>(run: (tx: SqlTransaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      return run(tx);
    });
  }
  private async row(
    tx: SqlTransaction,
    id: string,
    scope: string,
    lock = true,
  ) {
    const r = (
      await tx.query<Row>(
        select + " WHERE intent_id=$1" + (lock ? " FOR UPDATE" : ""),
        [id],
      )
    ).rows[0];
    if (!r || r.input.scope !== scope)
      throw new Error("action-not-found-or-denied");
    return r;
  }
  private async fact(
    tx: SqlTransaction,
    kind: string,
    payload: unknown,
    refs: string[],
    id: string = randomUUID(),
  ) {
    await tx.query(
      "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
      [kind],
    );
    const atom = freezeInformationAtom(
      informationAtomSchema.parse({
        informationId: id,
        kind,
        occurredAt: new Date().toISOString(),
        source: "runtime:action",
        payload,
        references: [...new Set(refs)].map((informationId) => ({
          relation: "core:uses-context",
          informationId,
        })),
      }),
    );
    await appendInformationAtom(tx, atom, [
      { relation: "core:uses-context", required: false, multiple: true },
    ]);
    return id;
  }
  /** 宿主授权入口不在 ActionAccess 中；模型只能引用已经存在的精确 grant。 */
  async authorize(input: ActionAuthorization) {
    if (
      !Number.isSafeInteger(input.version) ||
      input.version < 1 ||
      !Number.isFinite(Date.parse(input.expiresAt))
    )
      throw new Error("invalid-action-authorization");
    await this.transaction(async (tx) => {
      const old = (
        await tx.query<{ input: ActionAuthorization }>(
          "SELECT input FROM information_action_authorizations WHERE id=$1",
          [input.id],
        )
      ).rows[0];
      if (old) {
        if (actionDigest(old.input) !== actionDigest(input))
          throw new Error("authorization-conflict");
        return;
      }
      await this.fact(
        tx,
        "core.action.authorized.v1",
        input,
        [input.causeInformationId],
        input.id,
      );
      await tx.query(
        "INSERT INTO information_action_authorizations(id,input) VALUES($1,$2::jsonb)",
        [input.id, JSON.stringify(input)],
      );
    });
  }
  async revoke(id: string, causeInformationId: string) {
    await this.transaction(async (tx) => {
      const r = (
        await tx.query<{ revoked_id: string | null }>(
          "SELECT revoked_id FROM information_action_authorizations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!r) throw new Error("authorization-not-found");
      if (r.revoked_id) return;
      const fact = await this.fact(
        tx,
        "core.action.authorization.revoked.v1",
        { authorizationId: id },
        [id, causeInformationId],
      );
      await tx.query(
        "UPDATE information_action_authorizations SET revoked_id=$2 WHERE id=$1",
        [id, fact],
      );
    });
  }
  async invalidateRun(
    runInformationId: string,
    scope: string,
    causeInformationId: string,
  ) {
    await this.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO information_action_runs(run_id,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [runInformationId, scope],
      );
      const run = (
        await tx.query<{ scope: string; invalidated_id: string | null }>(
          "SELECT * FROM information_action_runs WHERE run_id=$1 FOR UPDATE",
          [runInformationId],
        )
      ).rows[0]!;
      if (run.scope !== scope) throw new Error("run-scope-denied");
      if (!run.invalidated_id) {
        const fact = await this.fact(
          tx,
          "core.action.run.invalidated.v1",
          { runInformationId, scope },
          [runInformationId, causeInformationId],
        );
        await tx.query(
          "UPDATE information_action_runs SET invalidated_id=$2 WHERE run_id=$1",
          [runInformationId, fact],
        );
      }
    });
  }
  async runValidity(runInformationId: string, scope: string) {
    const r = (
      await this.db.query<{ scope: string; invalidated_id: string | null }>(
        "SELECT scope,invalidated_id FROM information_action_runs WHERE run_id=$1",
        [runInformationId],
      )
    ).rows[0];
    if (r && r.scope !== scope) throw new Error("run-scope-denied");
    return {
      valid: !r?.invalidated_id,
      causeInformationId: r?.invalidated_id ?? null,
    };
  }
  private async authorized(
    tx: SqlTransaction,
    i: ActionIntent,
    checkCurrentEligibility = true,
  ) {
    const r = (
      await tx.query<{
        input: ActionAuthorization;
        revoked_id: string | null;
        live: boolean;
      }>(
        "SELECT *, (input->>'expiresAt')::timestamptz>clock_timestamp() live FROM information_action_authorizations WHERE id=$1",
        [i.authorizationId],
      )
    ).rows[0];
    return (
      !!r &&
      (!checkCurrentEligibility || (!r.revoked_id && r.live)) &&
      r.input.executionDigest === actionExecutionDigest(i) &&
      r.input.scope === i.scope &&
      r.input.version === i.authorizationVersion &&
      r.input.providerId === i.providerId &&
      r.input.executor === i.executor &&
      r.input.targetDigest === actionDigest(i.target) &&
      r.input.argumentsDigest === actionDigest(i.arguments) &&
      r.input.operationId === i.operationId &&
      r.input.basisDigest === actionBasisDigest(i)
    );
  }
  private async controlAuthorized(
    tx: SqlTransaction,
    i: ActionIntent,
    authorizationId: string,
  ) {
    const a = (
      await tx.query<{ input: ActionAuthorization }>(
        "SELECT input FROM information_action_authorizations WHERE id=$1",
        [authorizationId],
      )
    ).rows[0];
    return (
      !!a &&
      (await this.authorized(tx, {
        ...i,
        authorizationId,
        authorizationVersion: a.input.version,
      }))
    );
  }
  private async basis(tx: SqlTransaction, i: ActionIntent) {
    const o = (
      await tx.query<{ manifest: any; scene_id: string; contract: any }>(
        "SELECT o.manifest,p.scene_id,p.contract FROM information_observations o JOIN information_observation_progress p USING(stream_id) WHERE observation_id=$1",
        [i.dependencies.observationId],
      )
    ).rows[0];
    if (
      !o ||
      o.manifest?.proofKind === "memory-native" ||
      o.manifest?.runInformationId !== i.runInformationId ||
      o.scene_id !== i.sceneId
    )
      throw new Error("action-observation-mismatch");
    const d = o.contract.address.destination;
    const scope = JSON.stringify([
      o.contract.address.platform,
      o.contract.address.adapterId,
      d.kind,
      d.userId ?? d.groupId ?? d.conversationId ?? null,
    ]);
    if (scope !== i.scope) throw new Error("action-scope-denied");
    const decision = (
      await tx.query<{ kind: string; payload: any }>(
        `SELECT a.kind,a.payload FROM information_atoms a WHERE a.information_id=$1 AND EXISTS(
       SELECT 1 FROM information_references WHERE information_id=a.information_id AND target_information_id=ANY($2::text[]))`,
        [
          i.decisionInformationId,
          [i.runInformationId, o.manifest.frozenInformationId],
        ],
      )
    ).rows[0];
    if (
      !decision ||
      !["agent.light.decision.completed", "agent.action.decision.v1"].includes(
        decision.kind,
      )
    )
      throw new Error("action-decision-unproved");
    if (decision.kind === "agent.light.decision.completed") {
      if (
        i.domain !== "message" ||
        decision.payload.action?.action !== "message"
      )
        throw new Error("action-decision-domain-mismatch");
    } else {
      const parsed = actionDecisionSchema.safeParse(decision.payload);
      if (
        !parsed.success ||
        parsed.data.observationId !== i.dependencies.observationId ||
        parsed.data.domain !== i.domain
      )
        throw new Error("action-decision-domain-mismatch");
    }
  }
  async register(
    raw: ActionIntent,
    guard?: InformationClaim,
    transaction?: SqlTransaction,
  ) {
    return this.registerInternal(raw, false, guard, transaction);
  }
  private async registerInternal(
    raw: ActionIntent,
    legacy: boolean,
    guard?: InformationClaim,
    transaction?: SqlTransaction,
    deferEligibilityToAdmission = false,
  ) {
    const input = actionIntentSchema.parse(raw),
      digest = actionDigest(input);
    const run = async (tx: SqlTransaction) => {
      const old = (
        await tx.query<Row>(select + " WHERE operation_id=$1 FOR UPDATE", [
          input.operationId,
        ])
      ).rows[0];
      if (old) {
        if (old.digest !== digest) throw new Error("action-operation-conflict");
        return view(old);
      }
      if (guard) await assertClaimInTransaction(tx, guard);
      if (!legacy) await this.basis(tx, input);
      if (!(await this.authorized(tx, input, !deferEligibilityToAdmission)))
        throw new Error("action-authorization-denied");
      await tx.query(
        "INSERT INTO information_action_runs(run_id,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [input.runInformationId, input.scope],
      );
      const run = (
        await tx.query<{ scope: string; invalidated_id: string | null }>(
          "SELECT * FROM information_action_runs WHERE run_id=$1",
          [input.runInformationId],
        )
      ).rows[0]!;
      if (
        (!deferEligibilityToAdmission && run.invalidated_id) ||
        run.scope !== input.scope
      )
        throw new Error("action-run-invalidated");
      const intentId = await this.fact(tx, "core.action.intent.v1", input, [
        input.runInformationId,
        input.decisionInformationId,
        input.authorizationId,
      ]);
      await tx.query(
        "INSERT INTO information_action_heads(intent_id,operation_id,input,digest,state,legacy_delivery) VALUES($1,$2,$3::jsonb,$4,'queued',$5)",
        [intentId, input.operationId, JSON.stringify(input), digest, legacy],
      );
      if (guard) await assertClaimInTransaction(tx, guard);
      return view(await this.row(tx, intentId, input.scope));
    };
    return transaction ? run(transaction) : this.transaction(run);
  }
  async read(id: string, scope: string) {
    return view(await this.row(this.db, id, scope, false));
  }
  /** 宿主在授权前固定真实输出的模型上下文；后续工具步骤复用本入口。 */
  async dependenciesFor(
    observationId: string,
    evidenceInformationId: string,
  ): Promise<ActionDependencies> {
    const row = (
      await this.db.query<{ manifest: unknown }>(
        "SELECT manifest FROM information_observations WHERE observation_id=$1",
        [observationId],
      )
    ).rows[0];
    const manifest = observationManifestSchema.parse(row?.manifest);
    const proof = await loadActionProofContext(
      this.db,
      manifest,
      evidenceInformationId,
    );
    return {
      observationId,
      evidenceInformationId,
      memoryRevisions: proof.memoryRevisions,
      sourceInformationIds: proof.sourceInformationIds,
    };
  }
  /** 仅处理已过期的持久 attempt；不调用 provider，也不碰仍有效的执行 claim。 */
  async recoverExpired() {
    for (;;) {
      const count = await this.transaction(async (tx) => {
        const rows = (
          await tx.query<Row>(
            select +
              " WHERE state IN ('started','cancel_requested') AND lease_until<=clock_timestamp() LIMIT 1000 FOR UPDATE",
          )
        ).rows;
        for (const r of rows)
          await this.record(
            tx,
            r,
            {
              status: "unknown",
              evidence: "unconfirmed",
              result: { reason: "execution-lease-lost" },
              artifacts: [],
              truncated: false,
            },
            false,
          );
        return rows.length;
      });
      if (count < 1000) return;
    }
  }
  async deliveryResult(requestId: string) {
    const r = (
      await this.db.query<Row>(select + " WHERE operation_id=$1", [
        `delivery:${requestId}`,
      ])
    ).rows[0];
    if (!r?.receipt_id) return undefined;
    const atom = (
      await this.db.query<{ payload: { outcome: ActionOutcome } }>(
        "SELECT payload FROM information_atoms WHERE information_id=$1",
        [r.receipt_id],
      )
    ).rows[0];
    return atom?.payload.outcome;
  }
  /** 仅供 Runtime 已完成目标授权后的消息桥接。参数从持久 request 重读，调用方不能传正文。 */
  async prepareDelivery(
    requestId: string,
    guard?: InformationClaim,
  ): Promise<ActionView> {
    const old = (
      await this.db.query<Row>(select + " WHERE operation_id=$1", [
        `delivery:${requestId}`,
      ])
    ).rows[0];
    if (old) return view(old);
    const request = (
      await this.db.query<{
        payload: any;
        occurred_at: string;
        queued_at: string | null;
      }>(
        `SELECT a.payload,a.occurred_at,d.created_at::text queued_at FROM information_atoms a
        LEFT JOIN information_deliveries d ON d.information_id=a.information_id AND d.subscription_id='kaguya.runtime.delivery'
        WHERE a.information_id=$1 AND a.kind='core.delivery.requested'`,
        [requestId],
      )
    ).rows[0];
    if (!request) throw new Error("delivery-request-missing");
    const p = request.payload;
    const context = (
      await this.db.query<{ target_information_id: string }>(
        "SELECT target_information_id FROM information_references WHERE information_id=$1 AND relation='core:context'",
        [requestId],
      )
    ).rows[0];
    if (!context) throw new Error("delivery-context-missing");
    const continuity = await continuityDeliveryProof(this.db, requestId);
    const o = continuity
      ? (
          await this.db.query<{
            observation_id: string;
            manifest: any;
            scene_id: string;
            contract: any;
          }>(
            `SELECT o.observation_id,o.manifest,p.scene_id,p.contract FROM information_observations o JOIN information_observation_progress p USING(stream_id) WHERE o.observation_id=$1 AND p.consumer_id='agent.continuity'`,
            [continuity.input.dependencies.observationId],
          )
        ).rows[0]
      : p.turn
        ? (
            await this.db.query<{
              observation_id: string;
              manifest: any;
              scene_id: string;
              contract: any;
            }>(
              `SELECT o.observation_id,o.manifest,p.scene_id,p.contract FROM information_observations o JOIN information_observation_progress p USING(stream_id)
       WHERE o.manifest->>'runInformationId'=$1 AND p.consumer_id='agent.situation' ORDER BY (o.replacement_observation_id IS NULL),o.through_position LIMIT 1`,
              [p.turn.claimInformationId],
            )
          ).rows[0]
        : undefined;
    const source = o?.contract.address ?? {
      platform: p.platform,
      adapterId: p.adapterId,
      destination: p.destination,
    };
    const d = source.destination;
    const scope = JSON.stringify([
      source.platform,
      source.adapterId,
      d.kind,
      d.userId ?? d.groupId ?? d.conversationId ?? null,
    ]);
    const decision =
      continuity?.input.decisionInformationId ??
      (o
        ? (
            await this.db.query<{ information_id: string }>(
              `SELECT a.information_id FROM information_atoms a JOIN information_references r USING(information_id) WHERE a.kind='agent.light.decision.completed' AND r.target_information_id=$1 AND r.relation='core:status-of'`,
              [o.manifest.runInformationId],
            )
          ).rows[0]?.information_id
        : context.target_information_id);
    if (!decision) throw new Error("delivery-decision-missing");
    const authorizationId = `action-delivery-authorization:${requestId}`;
    const prior = (
      await this.db.query<{ input: ActionAuthorization }>(
        "SELECT input FROM information_action_authorizations WHERE id=$1",
        [authorizationId],
      )
    ).rows[0];
    const deadline =
      prior?.input.expiresAt ??
      new Date(
        Date.parse(request.queued_at ?? request.occurred_at) + 300000,
      ).toISOString();
    const target = {
      adapterId: p.adapterId,
      platform: p.platform,
      destination: p.destination,
    };
    const basis = {
      runInformationId:
        o?.manifest.runInformationId ??
        p.turn?.claimInformationId ??
        context.target_information_id,
      decisionInformationId: decision,
      dependencies: {
        observationId: o?.observation_id ?? `legacy:${requestId}`,
        memoryRevisions: o?.manifest.knowledgeCutoff.memoryRevisions ?? [],
        sourceInformationIds: [
          ...new Set<string>([
            ...(o?.manifest.sourceInformationIds ?? []),
            ...(
              (o?.manifest.content.memory?.pendingEvidence ?? []) as {
                informationId: string;
              }[]
            ).map((e) => e.informationId),
          ]),
        ],
      },
    };
    if (o)
      basis.dependencies = await this.dependenciesFor(
        o.observation_id,
        requestId,
      );
    const intent: ActionIntent = {
      operationId: `delivery:${requestId}`,
      ...basis,
      scope,
      sceneId: o?.scene_id ?? `legacy:${scope}`,
      authorizationId,
      authorizationVersion: 1,
      domain: "message",
      providerId: "runtime.message",
      providerVersion: "1",
      executor: "runtime:delivery",
      toolName: "sendMessage",
      target,
      arguments: p.message,
      dependsOn: [],
      deadline,
    };
    await this.authorize({
      executionDigest: actionExecutionDigest(intent),
      operationId: intent.operationId,
      basisDigest: actionBasisDigest(basis),
      id: authorizationId,
      scope,
      version: 1,
      providerId: intent.providerId,
      executor: intent.executor,
      targetDigest: actionDigest(target),
      argumentsDigest: actionDigest(p.message),
      expiresAt: deadline,
      causeInformationId: requestId,
    });
    return this.registerInternal(intent, !o, guard, undefined, true);
  }
  async admit(
    id: string,
    scope: string,
    leaseMs: number,
    guard?: InformationClaim,
  ): Promise<{ view: ActionView; claim?: ActionClaim }> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000)
      throw new Error("invalid-action-lease");
    return this.transaction(async (tx) => {
      const r = await this.row(tx, id, scope);
      if (guard) await assertClaimInTransaction(tx, guard);
      if (r.state !== "queued") {
        if (["started", "cancel_requested"].includes(r.state) && !r.live)
          await this.record(
            tx,
            r,
            {
              status: "unknown",
              evidence: "unconfirmed",
              result: { reason: "execution-lease-lost" },
              artifacts: [],
              truncated: false,
            },
            false,
          );
        return { view: view(await this.row(tx, id, scope)) };
      }
      if (!r.legacy_delivery) await this.basis(tx, r.input);
      const run = (
        await tx.query<{ invalidated_id: string | null }>(
          "SELECT invalidated_id FROM information_action_runs WHERE run_id=$1",
          [r.input.runInformationId],
        )
      ).rows[0]!;
      const proof = r.legacy_delivery
        ? { valid: true, reasons: [] }
        : await checkActionDependencies(tx, r.input.dependencies);
      const dependencies = (
        await tx.query<{
          intent_id: string;
          state: string;
          input: ActionIntent;
        }>(
          "SELECT intent_id,state,input FROM information_action_heads WHERE intent_id=ANY($1::text[])",
          [r.input.dependsOn],
        )
      ).rows;
      const reason = !(await this.nativeRunActive(tx, id))
        ? "native-run-stopped"
        : run.invalidated_id
          ? "run-invalidated"
          : !(await this.authorized(tx, r.input))
            ? "authorization-denied"
            : !proof.valid
              ? "dependency-invalid"
              : Date.parse(r.input.deadline) <= Date.now()
                ? "deadline-expired"
                : r.input.dependsOn.some(
                      (id) =>
                        !dependencies.some(
                          (d) =>
                            d.intent_id === id &&
                            d.state === "succeeded" &&
                            d.input.scope === scope,
                        ),
                    )
                  ? "action-dependency-unsatisfied"
                  : null;
      if (reason) {
        await this.record(
          tx,
          r,
          {
            status: "rejected",
            evidence: "not-executed",
            result: { reason, dependencies: proof.reasons },
            artifacts: [],
            truncated: false,
          },
          false,
        );
        return { view: view(await this.row(tx, id, scope)) };
      }
      const attemptId = randomUUID(),
        token = randomUUID();
      const started = await this.fact(
        tx,
        "core.action.started.v1",
        {
          intentId: id,
          attemptId,
          digest: r.digest,
          operationId: r.input.operationId,
        },
        [id],
      );
      await tx.query(
        "UPDATE information_action_heads SET state='started',attempt_id=$2,started_id=$3,token=$4,lease_until=clock_timestamp()+$5*interval '1 millisecond' WHERE intent_id=$1",
        [id, attemptId, started, token, leaseMs],
      );
      await tx.query(
        "INSERT INTO information_action_outbox(intent_id,started_id) VALUES($1,$2)",
        [id, started],
      );
      if (guard) await assertClaimInTransaction(tx, guard);
      return {
        view: view(await this.row(tx, id, scope)),
        claim: { intentId: id, attemptId, token },
      };
    });
  }
  private async nativeRunActive(tx: SqlTransaction, intentId: string) {
    const operation = (
      await tx.query<{ operation_id: string }>(
        "SELECT operation_id FROM information_action_heads WHERE intent_id=$1",
        [intentId],
      )
    ).rows[0]?.operation_id;
    if (operation?.startsWith("delivery:")) {
      const proof = await continuityDeliveryProof(
        tx,
        operation.slice("delivery:".length),
      );
      if (proof && !proof.valid) return false;
    }
    const stopped = (
      await tx.query<{ stopped: boolean }>(
        `SELECT EXISTS(
      SELECT 1 FROM information_native_tool_calls c JOIN information_native_tool_runs r USING(run_id)
      LEFT JOIN information_continuity_activities ca ON ca.id=r.spec->'continuity'->>'activityId'
      LEFT JOIN information_continuity_agents ag ON ag.agent_id=r.spec->'continuity'->>'agentId'
      WHERE c.intent_id=$1 AND (r.stopped_id IS NOT NULL OR (r.spec->>'deadline')::timestamptz<=clock_timestamp()
        OR (r.spec ? 'continuity' AND (ca.id IS NULL OR ag.agent_id IS NULL OR ag.policy->>'enabled'<>'true' OR ca.state<>'active'
          OR ca.value->>'requestedState' IS NOT NULL OR ca.value->>'reevaluationRequired'='true')))) stopped`,
        [intentId],
      )
    ).rows[0]!;
    return !stopped.stopped;
  }
  private assertClaim(r: Row, claim: ActionClaim) {
    if (!r.live || r.attempt_id !== claim.attemptId || r.token !== claim.token)
      throw new Error("action-claim-lost");
  }
  /** Memory 内部效果与发布同锁复核；provider 不能靠旧 DTO 越过取消或授权撤回。 */
  async assertEffectAllowed(
    input: {
      intentId: string;
      attemptId: string;
      digest: string;
      intent: ActionIntent;
    },
    tx: SqlTransaction,
    checkDependencies = true,
  ) {
    const r = await this.row(tx, input.intentId, input.intent.scope);
    const run = (
      await tx.query<{ invalidated_id: string | null }>(
        "SELECT invalidated_id FROM information_action_runs WHERE run_id=$1",
        [r.input.runInformationId],
      )
    ).rows[0];
    if (
      r.state !== "started" ||
      !r.live ||
      r.attempt_id !== input.attemptId ||
      r.digest !== input.digest ||
      actionDigest(input.intent) !== r.digest ||
      run?.invalidated_id ||
      !(await this.nativeRunActive(tx, r.intent_id)) ||
      !(await this.authorized(tx, r.input)) ||
      Date.parse(r.input.deadline) <= Date.now() ||
      (checkDependencies &&
        !(await checkActionDependencies(tx, r.input.dependencies)).valid)
    )
      throw new Error("action-effect-denied");
  }
  async canInvoke(claim: ActionClaim, scope: string) {
    return this.transaction(async (tx) => {
      const r = await this.row(tx, claim.intentId, scope);
      this.assertClaim(r, claim);
      const run = (
        await tx.query<{ invalidated_id: string | null }>(
          "SELECT invalidated_id FROM information_action_runs WHERE run_id=$1",
          [r.input.runInformationId],
        )
      ).rows[0];
      return (
        r.state === "started" &&
        !run?.invalidated_id &&
        (await this.nativeRunActive(tx, r.intent_id)) &&
        (r.legacy_delivery ||
          (await checkActionDependencies(tx, r.input.dependencies)).valid) &&
        (await this.authorized(tx, r.input)) &&
        (await this.row(tx, claim.intentId, scope)).live &&
        Date.parse(r.input.deadline) > Date.now()
      );
    });
  }
  private async record(
    tx: SqlTransaction,
    r: Row,
    outcome: ActionOutcome,
    reconcile: boolean,
  ) {
    const receiptKey = `${r.intent_id}:${r.attempt_id ?? "admission"}:${reconcile}:${actionDigest(outcome)}`;
    const old = (
      await tx.query<{ receipt_id: string }>(
        "SELECT receipt_id FROM information_action_receipts WHERE receipt_key=$1",
        [receiptKey],
      )
    ).rows[0];
    if (old) return old.receipt_id;
    const payload = {
      intentId: r.intent_id,
      intent: r.input,
      attemptId: r.attempt_id,
      startedInformationId: r.started_id,
      reconcilesReceiptId: reconcile ? r.receipt_id : null,
      outcome,
      resultHash: actionDigest({
        result: outcome.result,
        artifacts: outcome.artifacts,
      }),
    };
    const id = await this.fact(
      tx,
      reconcile ? "core.action.reconciled.v1" : "core.action.result.v1",
      payload,
      [
        r.intent_id,
        ...(r.started_id ? [r.started_id] : []),
        ...(reconcile && r.receipt_id ? [r.receipt_id] : []),
      ],
    );
    await tx.query(
      "INSERT INTO information_action_receipts(receipt_id,intent_id,receipt_key) VALUES($1,$2,$3)",
      [id, r.intent_id, receiptKey],
    );
    // 迟到取消不能覆盖已核实成功。所有相反回执仍追加保存，供核对与 Inspection 检查。
    const retained = r.receipt_id
      ? (
          await tx.query<{ payload: { outcome: ActionOutcome } }>(
            "SELECT payload FROM information_atoms WHERE information_id=$1",
            [r.receipt_id],
          )
        ).rows[0]?.payload.outcome
      : undefined;
    const strength = (o: ActionOutcome) =>
      o.status === "succeeded"
        ? 4
        : o.status === "partial"
          ? 3
          : o.status === "cancelled" && o.evidence === "effect-verified"
            ? 3
            : o.status === "cancelled" || o.status === "rejected"
              ? 2
              : 1;
    if (!retained || strength(outcome) >= strength(retained))
      await tx.query(
        "UPDATE information_action_heads SET state=$2,receipt_id=$3 WHERE intent_id=$1",
        [r.intent_id, outcome.status, id],
      );
    return id;
  }
  private validateOutcome(r: Row, outcome: ActionOutcome) {
    if (
      (outcome.status === "rejected" && outcome.evidence !== "not-executed") ||
      (outcome.status === "unknown" && outcome.evidence !== "unconfirmed") ||
      (outcome.status === "cancelled" &&
        !["not-executed", "effect-verified"].includes(outcome.evidence))
    )
      throw new Error("action-outcome-evidence-mismatch");
    for (const artifact of outcome.artifacts)
      if (
        artifact.scope !== r.input.scope ||
        artifact.actionId !== r.intent_id ||
        artifact.generation !== r.input.environment?.generation
      )
        throw new Error("action-artifact-mismatch");
  }
  async finish(
    claim: ActionClaim,
    scope: string,
    raw: ActionOutcome,
    reconcile = false,
    guard?: InformationClaim,
  ) {
    const outcome = actionOutcomeSchema.parse(raw);

    return this.transaction(async (tx) => {
      const r = await this.row(tx, claim.intentId, scope);
      this.assertClaim(r, claim);
      if (guard) await assertClaimInTransaction(tx, guard);
      this.validateOutcome(r, outcome);
      await this.record(tx, r, outcome, reconcile);
      if (guard) await assertClaimInTransaction(tx, guard);
      this.assertClaim(await this.row(tx, claim.intentId, scope), claim);
      return view(await this.row(tx, claim.intentId, scope));
    });
  }
  async intervene(input: ActionIntervention, replacementIntentId?: string) {
    return this.transaction(async (tx) => {
      const r = await this.row(tx, input.intentId, input.scope);
      if (
        !(await this.controlAuthorized(
          tx,
          r.input,
          input.controlAuthorizationId,
        ))
      )
        throw new Error("action-control-denied");
      if (replacementIntentId)
        await this.row(tx, replacementIntentId, input.scope);
      if (!r.cancellation_id) {
        const id = await this.fact(
          tx,
          "core.action.cancel.requested.v1",
          {
            intentId: r.intent_id,
            replacementIntentId: replacementIntentId ?? null,
          },
          [
            r.intent_id,
            input.causeInformationId,
            ...(replacementIntentId ? [replacementIntentId] : []),
          ],
        );
        await tx.query(
          "UPDATE information_action_heads SET cancellation_id=$2 WHERE intent_id=$1",
          [r.intent_id, id],
        );
        if (r.state === "queued") {
          await this.record(
            tx,
            r,
            {
              status: "cancelled",
              evidence: "not-executed",
              result: { reason: "cancelled-before-start" },
              artifacts: [],
              truncated: false,
            },
            false,
          );
          if (replacementIntentId)
            await tx.query(
              "UPDATE information_action_heads SET state='superseded' WHERE intent_id=$1",
              [r.intent_id],
            );
        } else if (r.state === "started")
          await tx.query(
            "UPDATE information_action_heads SET state='cancel_requested' WHERE intent_id=$1",
            [r.intent_id],
          );
      }
      return view(await this.row(tx, r.intent_id, input.scope));
    });
  }
  async confirmCancellation(
    input: ActionIntervention,
    attemptId: string,
    raw: ActionOutcome,
  ) {
    const outcome = actionOutcomeSchema.parse(raw);
    if (
      !["cancelled", "partial", "unknown"].includes(outcome.status) ||
      (outcome.status === "cancelled" &&
        !["effect-verified", "not-executed"].includes(outcome.evidence))
    )
      throw new Error("invalid-cancellation-evidence");
    return this.transaction(async (tx) => {
      const r = await this.row(tx, input.intentId, input.scope);
      if (
        !r.cancellation_id ||
        r.attempt_id !== attemptId ||
        !(await this.controlAuthorized(
          tx,
          r.input,
          input.controlAuthorizationId,
        ))
      )
        throw new Error("action-control-denied");
      this.validateOutcome(r, outcome);
      await this.record(tx, r, outcome, false);
      return view(await this.row(tx, input.intentId, input.scope));
    });
  }
  async claimReconciliation(
    id: string,
    scope: string,
    leaseMs: number,
    controlAuthorizationId: string,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000)
      throw new Error("invalid-action-lease");
    return this.transaction(async (tx) => {
      const r = await this.row(tx, id, scope);
      if (!(await this.controlAuthorized(tx, r.input, controlAuthorizationId)))
        throw new Error("action-reconciliation-denied");
      if (
        !r.attempt_id ||
        !["unknown", "partial", "cancel_requested", "started"].includes(
          r.state,
        ) ||
        r.live
      )
        return undefined;
      const token = randomUUID();
      await tx.query(
        "UPDATE information_action_heads SET token=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE intent_id=$1",
        [id, token, leaseMs],
      );
      return { intentId: id, attemptId: r.attempt_id, token };
    });
  }
  async release(claim: ActionClaim, scope: string) {
    await this.transaction(async (tx) => {
      const r = await this.row(tx, claim.intentId, scope);
      if (r.token === claim.token)
        await tx.query(
          "UPDATE information_action_heads SET lease_until=clock_timestamp() WHERE intent_id=$1",
          [r.intent_id],
        );
    });
  }
  async acknowledge(id: string, scope: string) {
    await this.transaction(async (tx) => {
      const r = await this.row(tx, id, scope);
      if (!r.receipt_id) throw new Error("action-result-unconfirmed");
      await tx.query(
        "UPDATE information_action_outbox SET acknowledged=true WHERE intent_id=$1",
        [id],
      );
    });
  }
  async pending() {
    return (
      await this.db.query<Row>(
        select +
          " WHERE state IN ('queued','started','cancel_requested','unknown','partial') ORDER BY intent_id LIMIT 1000",
      )
    ).rows.map(view);
  }
  async readReceipt(
    receiptId: string,
    scope: string,
    authorizationId: string,
    transaction?: SqlTransaction,
  ): Promise<ActionReceipt> {
    if (typeof authorizationId !== "string" || !authorizationId)
      throw new Error("receipt-not-found-or-denied");
    const run = (tx: SqlTransaction) =>
      this.receiptProof(tx, receiptId, scope, authorizationId);
    return transaction ? run(transaction) : this.transaction(run);
  }
  /** Management-only proof read. The caller owns authentication and a READ ONLY transaction. */
  async inspectReceipt(
    receiptId: string,
    scope: string,
    transaction: SqlTransaction,
  ): Promise<ActionReceipt> {
    return this.receiptProof(transaction, receiptId, scope);
  }
  private async receiptProof(
    tx: SqlTransaction,
    receiptId: string,
    scope: string,
    authorizationId?: string,
  ): Promise<ActionReceipt> {
    const p = (
      await tx.query<{
        payload: any;
        position: string;
        occurred_at: string;
        kind: string;
        indexed_intent_id: string;
      }>(
        `SELECT a.payload,l.position::text,a.occurred_at,a.kind,r.intent_id indexed_intent_id FROM information_action_receipts r JOIN information_atoms a ON a.information_id=r.receipt_id JOIN information_lifecycle l ON l.information_id=a.information_id WHERE r.receipt_id=$1`,
        [receiptId],
      )
    ).rows[0];
    if (!p) throw new Error("receipt-not-found-or-denied");
    if (
      !["core.action.result.v1", "core.action.reconciled.v1"].includes(
        p.kind,
      ) ||
      p.indexed_intent_id !== p.payload.intentId
    )
      throw new Error("receipt-proof-invalid");
    const r = await this.row(
      tx,
      p.payload.intentId,
      scope,
      authorizationId !== undefined,
    );
    if (
      (authorizationId !== undefined &&
        !(await this.controlAuthorized(tx, r.input, authorizationId))) ||
      actionDigest(p.payload.intent) !== r.digest
    )
      throw new Error("receipt-not-found-or-denied");
    const outcome = actionOutcomeSchema.parse(p.payload.outcome);
    if (
      p.payload.resultHash !==
        actionDigest({
          result: outcome.result,
          artifacts: outcome.artifacts,
        }) ||
      p.payload.startedInformationId !== r.started_id ||
      p.payload.attemptId !== r.attempt_id
    )
      throw new Error("receipt-proof-invalid");
    this.validateOutcome(r, outcome);
    const original = (
      await tx.query<{ payload: unknown }>(
        "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.action.intent.v1'",
        [r.intent_id],
      )
    ).rows[0];
    const refs = (
      await tx.query<{ target_information_id: string }>(
        "SELECT target_information_id FROM information_references WHERE information_id=$1 AND relation='core:uses-context' AND target_information_id=ANY($2::text[])",
        [receiptId, [r.intent_id, ...(r.started_id ? [r.started_id] : [])]],
      )
    ).rows.map((ref) => ref.target_information_id);
    if (
      !original ||
      actionDigest(original.payload) !== r.digest ||
      !refs.includes(r.intent_id) ||
      (r.started_id && !refs.includes(r.started_id))
    )
      throw new Error("receipt-proof-invalid");
    if (r.started_id) {
      const started = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.action.started.v1'",
          [r.started_id],
        )
      ).rows[0];
      if (
        !started ||
        started.payload.intentId !== r.intent_id ||
        started.payload.attemptId !== r.attempt_id ||
        started.payload.digest !== r.digest ||
        started.payload.operationId !== r.input.operationId
      )
        throw new Error("receipt-proof-invalid");
    }
    return {
      ...p.payload,
      outcome,
      receiptId,
      registeredPosition: p.position,
      recordedAt: p.occurred_at,
    };
  }
}
