/**
 * 持续 Agent 的执行投影。事务先追加 Information，再更新可重建投影。
 * 操作 ID 固定请求，版本检查防止丢更新。一个 Agent 共用主活动槽和每日预算。
 */
import { randomUUID } from "node:crypto";
import {
  activitySchema,
  continuityPolicySchema,
  subjectiveStateSchema,
  environmentResourceSchema,
  internalSourceSchema,
  type Activity,
  type ActivityCreate,
  type ActivityChange,
  type ContinuityAccess,
  type ContinuityOperation,
  type ContinuityPolicy,
  type ContinuityView,
  type CurrentState,
  type EnvironmentResource,
  type InternalSource,
  type ActionExecution,
} from "@kaguya/sdk";
import {
  freezeInformationAtom,
  informationAtomSchema,
  nativeMemorySnapshotSchema,
  activityChangeSchema,
  type NativeMemorySnapshot,
  type ContinuityHost,
} from "@kaguya/schema";
import { appendInformationAtom } from "./information-repository.js";
import { actionDigest, PostgresActionStore } from "./action-store.js";
import {
  continuityDeliveryProof,
  continuityTextHash,
  type ContinuityDeliveryInput,
} from "./continuity-delivery-proof.js";
import { sourceProofOwners } from "./native-memory-proof.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

export async function prepareContinuitySchema(db: SqlDatabase) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(323327)");
    await tx.exec(`CREATE TABLE IF NOT EXISTS information_continuity_agents (
      agent_id text PRIMARY KEY, revision integer NOT NULL, policy jsonb NOT NULL,
      policy_id text NOT NULL REFERENCES information_atoms(information_id), state jsonb,
      context_id text NOT NULL REFERENCES information_atoms(information_id),
      main_activity_id text, chat_run_id text REFERENCES information_atoms(information_id));
      CREATE TABLE IF NOT EXISTS information_continuity_operations (
        agent_id text NOT NULL, operation_id text NOT NULL, digest text NOT NULL, result jsonb NOT NULL,
        PRIMARY KEY(agent_id,operation_id));
      CREATE TABLE IF NOT EXISTS information_continuity_activities (
        id text PRIMARY KEY, agent_id text NOT NULL REFERENCES information_continuity_agents(agent_id),
        scope text NOT NULL, state text NOT NULL, value jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS information_continuity_open ON information_continuity_activities(agent_id,state,scope,id);
      CREATE TABLE IF NOT EXISTS information_continuity_budget (
        agent_id text NOT NULL REFERENCES information_continuity_agents(agent_id), day text NOT NULL,
        used integer NOT NULL, PRIMARY KEY(agent_id,day));
      CREATE TABLE IF NOT EXISTS information_continuity_resources (
        id text PRIMARY KEY REFERENCES information_atoms(information_id), agent_id text NOT NULL,
        scope text NOT NULL, value jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS information_continuity_resources_scope ON information_continuity_resources(agent_id,scope,id);`);
    await tx.exec(`CREATE TABLE IF NOT EXISTS information_continuity_delivery_plans (
      completed_id text PRIMARY KEY REFERENCES information_atoms(information_id), agent_id text NOT NULL,
      activity_id text NOT NULL REFERENCES information_continuity_activities(id), scope text NOT NULL,
      information_id text NOT NULL REFERENCES information_atoms(information_id),
      origin_intent_id text UNIQUE REFERENCES information_action_heads(intent_id), input jsonb);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS information_continuity_tool_runs ON information_native_tool_runs ((spec->'continuity'->>'activityId')) WHERE spec ? 'continuity';
      CREATE INDEX IF NOT EXISTS information_action_run_receipts ON information_action_heads ((input->>'runInformationId'),(input->>'scope'));
      CREATE INDEX IF NOT EXISTS information_continuity_activity_versions ON information_atoms ((payload->'activity'->>'id'),(payload->'activity'->>'revision')) WHERE kind='agent.continuity.activity.v1';
      CREATE INDEX IF NOT EXISTS information_continuity_delivery_activity ON information_continuity_delivery_plans(activity_id);`);
  });
}

type Head = {
  agent_id: string;
  revision: number;
  policy: ContinuityPolicy;
  policy_id: string;
  context_id: string;
  state: CurrentState | null;
  main_activity_id: string | null;
  chat_run_id: string | null;
};
const terminal = new Set<Activity["state"]>([
  "completed",
  "abandoned",
  "failed",
]);
export const continuityDay = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

export class PostgresContinuityStore implements ContinuityAccess {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly host?: (
      scope: string,
    ) => Omit<ContinuityHost, "environments">,
  ) {}

  private async operation<T>(
    agentId: string,
    operationId: string,
    input: unknown,
    run: (tx: SqlTransaction) => Promise<T>,
  ): Promise<T> {
    if (!agentId.trim() || !operationId.trim() || operationId.length > 1000)
      throw new Error("invalid-operation");
    return this.db.transaction(async (tx) => {
      // Also used by action admission and Memory dependency changes. Never hold over I/O.
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,323327))",
        [agentId],
      );
      const { expectedRevision: _revision, ...identity } = input as Record<
        string,
        unknown
      >;
      const digest = actionDigest(identity);
      const old = (
        await tx.query<{ digest: string; result: T }>(
          "SELECT digest,result FROM information_continuity_operations WHERE agent_id=$1 AND operation_id=$2",
          [agentId, operationId],
        )
      ).rows[0];
      if (old) {
        if (old.digest !== digest) throw new Error("operation-conflict");
        return old.result;
      }
      const result = await run(tx);
      await tx.query(
        "INSERT INTO information_continuity_operations(agent_id,operation_id,digest,result) VALUES($1,$2,$3,$4::jsonb)",
        [agentId, operationId, digest, JSON.stringify(result)],
      );
      return result;
    });
  }
  private async head(tx: SqlTransaction, agentId: string): Promise<Head> {
    const head = (
      await tx.query<Head>(
        "SELECT * FROM information_continuity_agents WHERE agent_id=$1",
        [agentId],
      )
    ).rows[0];
    if (!head) throw new Error("continuity-not-configured");
    return head;
  }
  private version(actual: number, expected: number) {
    if (actual !== expected) throw new Error("revision-conflict");
  }
  private async fact(
    tx: SqlTransaction,
    kind: string,
    payload: unknown,
    refs: readonly string[],
    informationId: string = randomUUID(),
    contextId?: string,
  ) {
    await tx.query(
      "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
      [kind],
    );
    const atom = freezeInformationAtom(
      informationAtomSchema.parse({
        informationId,
        kind,
        occurredAt: this.now().toISOString(),
        source: "runtime:continuity",
        payload,
        references: [...new Set(refs)]
          .map((informationId) => ({
            relation: "core:uses-context",
            informationId,
          }))
          .concat(
            contextId
              ? [{ relation: "core:context", informationId: contextId }]
              : [],
          ),
      }),
    );
    await appendInformationAtom(tx, atom, [
      { relation: "core:uses-context", required: false, multiple: true },
      { relation: "core:context", required: false, multiple: false },
    ]);
    return informationId;
  }
  async configure(
    input: ContinuityOperation & { policy: ContinuityPolicy; basis: string[] },
  ) {
    const policy = continuityPolicySchema.parse(input.policy);
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "configure", ...input },
      async (tx) => {
        const old = (
          await tx.query<Head>(
            "SELECT * FROM information_continuity_agents WHERE agent_id=$1",
            [input.agentId],
          )
        ).rows[0];
        this.version(old?.revision ?? 0, input.expectedRevision);
        // 时区切换重算新当地日期的实际调用，同时保守继承旧日期已用额度。
        const newDay = continuityDay(this.now(), policy.timeZone);
        const carry =
          old && old.policy.timeZone !== policy.timeZone
            ? Math.max(
                (
                  await tx.query<{ used: number }>(
                    "SELECT used FROM information_continuity_budget WHERE agent_id=$1 AND day=ANY($2::text[])",
                    [
                      input.agentId,
                      [newDay, continuityDay(this.now(), old.policy.timeZone)],
                    ],
                  )
                ).rows.reduce((n, r) => Math.max(n, r.used), 0),
                Number(
                  (
                    await tx.query<{ used: string }>(
                      `SELECT count(*) used FROM information_atoms WHERE kind='agent.continuity.budget.v1' AND payload->>'agentId'=$1
            AND payload->>'allowed'='true' AND (occurred_at::timestamptz AT TIME ZONE $2)::date=$3::date`,
                      [input.agentId, policy.timeZone, newDay],
                    )
                  ).rows[0]!.used,
                ),
              )
            : null;
        const revision = (old?.revision ?? 0) + 1;
        const contextId =
          old?.context_id ??
          (await this.fact(tx, "core.runtime.context", {}, []));
        const policyId = await this.fact(
          tx,
          "agent.continuity.policy.v1",
          {
            agentId: input.agentId,
            revision,
            policy,
            ...(carry !== null
              ? { budgetCarry: { day: newDay, used: carry } }
              : {}),
          },
          [contextId, ...input.basis, ...(old ? [old.policy_id] : [])],
        );
        await tx.query(
          `INSERT INTO information_continuity_agents(agent_id,revision,policy,policy_id,context_id) VALUES($1,$2,$3::jsonb,$4,$5)
        ON CONFLICT(agent_id) DO UPDATE SET revision=$2,policy=$3::jsonb,policy_id=$4`,
          [
            input.agentId,
            revision,
            JSON.stringify(policy),
            policyId,
            contextId,
          ],
        );
        if (carry !== null)
          await tx.query(
            "INSERT INTO information_continuity_budget(agent_id,day,used) VALUES($1,$2,$3) ON CONFLICT(agent_id,day) DO UPDATE SET used=GREATEST(information_continuity_budget.used,excluded.used)",
            [input.agentId, newDay, carry],
          );
        let aggregateRevision = revision;
        if (old && old.policy.enabled !== policy.enabled) {
          const activities = (
            await tx.query<{ value: Activity }>(
              "SELECT value FROM information_continuity_activities WHERE agent_id=$1 AND state=ANY($2::text[])",
              [input.agentId, ["active", "paused"]],
            )
          ).rows;
          let main = old.main_activity_id;
          for (const { value: a } of activities) {
            if (
              (!policy.enabled && (a.state !== "active" || a.requestedState)) ||
              (policy.enabled && (a.suspension !== "disabled" || a.inFlight))
            )
              continue;
            const next = activitySchema.parse({
              ...a,
              revision: a.revision + 1,
              informationId: randomUUID(),
              updatedAt: this.now().toISOString(),
              state: policy.enabled
                ? "waiting"
                : a.inFlight
                  ? a.state
                  : "paused",
              requestedState: !policy.enabled && a.inFlight ? "paused" : null,
              suspension: policy.enabled ? null : "disabled",
              reason: policy.enabled
                ? "已重新启用，从保存点继续"
                : "已停用自主运行，保留保存点",
            });
            await this.fact(
              tx,
              "agent.continuity.activity.v1",
              {
                agentId: input.agentId,
                activity: next,
                policyChange: policyId,
              },
              [a.informationId, policyId],
              next.informationId,
            );
            await tx.query(
              "UPDATE information_continuity_activities SET state=$2,value=$3::jsonb WHERE id=$1",
              [a.id, next.state, JSON.stringify(next)],
            );
            if (main === a.id && (!policy.enabled || next.state !== "active"))
              main = null;
            aggregateRevision++;
          }
          await tx.query(
            "UPDATE information_continuity_agents SET revision=$2,main_activity_id=$3 WHERE agent_id=$1",
            [input.agentId, aggregateRevision, main],
          );
        }
        return aggregateRevision;
      },
    );
  }
  async evaluate(
    input: ContinuityOperation & {
      scope: string;
      subjective: CurrentState["subjective"];
      basis: string[];
    },
  ): Promise<CurrentState> {
    const subjective = subjectiveStateSchema.parse(input.subjective);
    if (!input.basis.length) throw new Error("missing-appraisal-basis");
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "evaluate", ...input },
      async (tx) => {
        const head = await this.head(tx, input.agentId);
        this.version(head.revision, input.expectedRevision);
        const state: CurrentState = {
          revision: (head.state?.revision ?? 0) + 1,
          informationId: randomUUID(),
          policyVersion: head.policy.version,
          scope: input.scope,
          evaluatedAt: this.now().toISOString(),
          expiresAt: new Date(
            this.now().getTime() + head.policy.subjectiveTtlMs,
          ).toISOString(),
          subjective,
          basis: input.basis,
        };
        await this.fact(
          tx,
          "agent.continuity.state.v1",
          { agentId: input.agentId, state },
          [...input.basis, head.policy_id],
          state.informationId,
        );
        await tx.query(
          "UPDATE information_continuity_agents SET revision=revision+1,state=$2::jsonb WHERE agent_id=$1",
          [input.agentId, JSON.stringify(state)],
        );
        return state;
      },
    );
  }
  async create(
    input: ContinuityOperation & { activity: ActivityCreate },
  ): Promise<Activity> {
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "create", ...input },
      async (tx) => {
        const head = await this.head(tx, input.agentId);
        this.version(head.revision, input.expectedRevision);
        const a = input.activity;
        const activity = activitySchema.parse({
          ...a,
          agentId: input.agentId,
          revision: 1,
          informationId: randomUUID(),
          state: "candidate",
          reason: "",
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
          nextCheckAt: a.nextCheckAt ?? null,
          nextStep: a.nextStep ?? "",
          completedSteps: [],
          checkpointReceiptIds: [],
          artifacts: [],
          memoryDependencies: a.memoryDependencies ?? [],
          personIds: a.personIds ?? [],
          acceptedBy: a.acceptedBy ?? null,
          acceptedFrom: a.acceptedFrom ?? null,
          externalResult: "unknown",
          deliveryIds: [],
          feedbackIds: [],
          fulfillment: a.kind === "commitment" ? "pending" : "unknown",
          reevaluationRequired: false,
          inFlight: null,
          requestedState: null,
          suspension: null,
          interruptedBy: null,
        });
        if (activity.kind === "commitment") {
          const decision = (
            await tx.query<{ kind: string; payload: any }>(
              "SELECT kind,payload FROM information_atoms WHERE information_id=$1",
              [activity.acceptedBy],
            )
          ).rows[0];
          const choice = decision?.payload.output?.continuity;
          const request = (
            await tx.query<{ payload: any; source: string }>(
              "SELECT payload,source FROM information_atoms WHERE information_id=$1 AND kind='core.message.inbound.text'",
              [activity.acceptedFrom],
            )
          ).rows[0];
          if (
            decision?.kind !== "core.model.task.completed" ||
            decision.payload.taskId !== "agent.heavy.respond" ||
            !["defer", "accept"].includes(choice?.kind) ||
            choice?.requestId !== activity.acceptedFrom ||
            choice.title !== activity.title ||
            choice.goal !== activity.goal ||
            !decision.payload.contextInformationIds?.includes(
              activity.acceptedFrom,
            ) ||
            !activity.sources.includes(activity.acceptedFrom!) ||
            !request ||
            request.source !== "runtime:ingress" ||
            JSON.stringify([
              request.payload.source.platform,
              request.payload.source.adapterId,
              request.payload.source.destination.kind,
              request.payload.source.destination.userId ??
                request.payload.source.destination.groupId ??
                request.payload.source.destination.conversationId ??
                null,
            ]) !== activity.scope
          )
            throw new Error("unproven-acceptance");
        }
        if (activity.personIds.length) {
          const owners = await sourceProofOwners(tx, activity.sources);
          if (activity.personIds.some((id) => !owners.has(id)))
            throw new Error("activity-person-unproved");
        }
        await this.fact(
          tx,
          "agent.continuity.activity.v1",
          { agentId: input.agentId, activity },
          [
            ...activity.sources,
            ...(activity.acceptedBy ? [activity.acceptedBy] : []),
          ],
          activity.informationId,
        );
        await tx.query(
          "INSERT INTO information_continuity_activities(id,agent_id,scope,state,value) VALUES($1,$2,$3,$4,$5::jsonb)",
          [
            activity.id,
            input.agentId,
            activity.scope,
            activity.state,
            JSON.stringify(activity),
          ],
        );
        await tx.query(
          "UPDATE information_continuity_agents SET revision=revision+1 WHERE agent_id=$1",
          [input.agentId],
        );
        return activity;
      },
    );
  }
  async change(
    input: ContinuityOperation & {
      activityId: string;
      change: ActivityChange;
      basis: string[];
    },
  ): Promise<Activity> {
    activityChangeSchema.parse(input.change);
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "change", ...input },
      async (tx) => {
        const head = await this.head(tx, input.agentId);
        const old = (
          await tx.query<{ value: Activity }>(
            "SELECT value FROM information_continuity_activities WHERE agent_id=$1 AND id=$2",
            [input.agentId, input.activityId],
          )
        ).rows[0]?.value;
        if (!old) throw new Error("activity-not-found");
        const change = input.change;
        const appendDelivery =
          Object.keys(change).length === 1 &&
          !!change.deliveryIds?.length &&
          input.operationId === `delivery:${change.deliveryIds[0]}`;
        if (!appendDelivery && old.revision !== input.expectedRevision) {
          const prior = input.operationId.endsWith(":result")
            ? (
                await tx.query<{ payload: { activity: Activity } }>(
                  "SELECT payload FROM information_atoms WHERE kind='agent.continuity.activity.v1' AND payload->'activity'->>'id'=$1 AND payload->'activity'->>'revision'=$2 LIMIT 1",
                  [old.id, String(input.expectedRevision)],
                )
              ).rows[0]?.payload.activity
            : undefined;
          const comparable = (a: Activity) => {
            const {
              deliveryIds: _d,
              revision: _r,
              informationId: _i,
              updatedAt: _t,
              ...value
            } = a;
            return value;
          };
          if (
            !prior ||
            actionDigest(comparable(prior)) !== actionDigest(comparable(old))
          )
            throw new Error("revision-conflict");
        }
        if (
          terminal.has(old.state) &&
          change.state &&
          change.state !== old.state
        )
          throw new Error("terminal-activity");
        const requestState =
          change.state &&
          ["paused", "waiting", "abandoned"].includes(change.state) &&
          old.inFlight
            ? change.state
            : null;
        if (
          change.state &&
          change.state !== "active" &&
          old.inFlight &&
          !requestState
        )
          throw new Error("safe-boundary-required");
        if (change.state === "active") {
          if (!head.policy.enabled) throw new Error("autonomy-disabled");
          if (head.chat_run_id) throw new Error("main-slot-busy");
          const day = continuityDay(this.now(), head.policy.timeZone);
          const used =
            (
              await tx.query<{ used: number }>(
                "SELECT used FROM information_continuity_budget WHERE agent_id=$1 AND day=$2",
                [input.agentId, day],
              )
            ).rows[0]?.used ?? 0;
          if (used >= head.policy.dailyModelCalls)
            throw new Error("autonomous-budget-exhausted");
          if (old.reevaluationRequired && change.reevaluationRequired !== false)
            throw new Error("reevaluation-required");
          if (head.main_activity_id && head.main_activity_id !== old.id)
            throw new Error("main-slot-busy");
        }
        let rebase: Partial<Activity> = {};
        if (old.reevaluationRequired && change.reevaluationRequired === false) {
          const choices = (
            await tx.query<{
              information_id: string;
              payload: any;
              frozen: any;
              source_id: string;
            }>(
              `SELECT c.information_id,c.payload,f.payload frozen,f.information_id source_id
            FROM information_atoms c JOIN information_atoms f ON f.information_id=c.payload->>'sourceInformationId' AND f.kind='agent.continuity.frozen.v1' AND f.source='runtime:continuity'
            WHERE c.information_id=ANY($1::text[]) AND c.kind='core.model.task.completed' AND c.payload->>'taskId'='agent.continuity.choose'`,
              [input.basis],
            )
          ).rows;
          const selected = choices.find(
            (c) =>
              c.payload.output?.action === "continue" &&
              c.payload.output.activityId === old.id &&
              c.frozen.view?.activities?.some(
                (a: any) =>
                  a.id === old.id && a.informationId === old.informationId,
              ),
          );
          if (!selected) throw new Error("reevaluation-unproved");
          const memory = nativeMemorySnapshotSchema.parse(
            selected.frozen.memory,
          );
          if (memory.scope !== old.scope)
            throw new Error("memory-scope-mismatch");
          const output = selected.payload.output;
          rebase = {
            sources: [
              ...new Set([
                selected.information_id,
                selected.source_id,
                ...(old.kind === "commitment"
                  ? [old.acceptedBy!, old.acceptedFrom!]
                  : []),
              ]),
            ],
            memoryDependencies: [
              ...memory.fixed,
              ...memory.recalled.map((r) => r.node),
            ].map((n) => ({ id: n.id, revision: n.metadata.revision })),
            title: output.title?.trim() || old.title,
            goal: output.goal?.trim() || old.goal,
            nextStep: output.nextStep?.trim() || old.nextStep,
          };
        }
        if (change.deliveryIds?.length) {
          const linked = await tx.query<{ id: string }>(
            `WITH RECURSIVE chain(root,id,depth) AS (
          SELECT id,id,0 FROM unnest($1::text[]) id UNION ALL SELECT c.root,r.target_information_id,c.depth+1 FROM chain c JOIN information_references r ON r.information_id=c.id WHERE r.relation='core:caused-by' AND c.depth<16)
          SELECT DISTINCT c.root id FROM chain c JOIN information_continuity_delivery_plans p ON p.completed_id=c.id
          JOIN information_atoms a ON a.information_id=c.root WHERE p.agent_id=$2 AND p.activity_id=$3 AND a.kind=ANY($4::text[])`,
            [
              change.deliveryIds,
              input.agentId,
              old.id,
              ["core.delivery.delivered", "core.delivery.failed"],
            ],
          );
          if (linked.rowCount !== new Set(change.deliveryIds).size)
            throw new Error("delivery-binding-unproved");
        }
        const union = (key: "artifacts" | "deliveryIds" | "feedbackIds") => [
          ...new Set([...old[key], ...(change[key] ?? [])]),
        ];
        const activity = activitySchema.parse({
          ...old,
          ...change,
          ...rebase,
          ...(input.operationId.startsWith("control:")
            ? { suspension: null, interruptedBy: null }
            : {}),
          ...(requestState
            ? { state: old.state, requestedState: requestState }
            : {}),
          artifacts: union("artifacts"),
          deliveryIds: union("deliveryIds"),
          feedbackIds: union("feedbackIds"),
          informationId: randomUUID(),
          revision: old.revision + 1,
          updatedAt: this.now().toISOString(),
        });
        if (activity.fulfillment === "fulfilled") {
          const delivered = await tx.query(
            "SELECT 1 FROM information_atoms WHERE information_id=ANY($1::text[]) AND kind='core.delivery.delivered' AND payload->>'ok'='true'",
            [activity.deliveryIds],
          );
          const feedback = await tx.query(
            "SELECT 1 FROM information_atoms WHERE information_id=ANY($1::text[]) AND kind='core.message.inbound.text'",
            [activity.feedbackIds],
          );
          if (!delivered.rowCount || !feedback.rowCount)
            throw new Error("unproven-fulfillment");
        }
        await this.fact(
          tx,
          "agent.continuity.activity.v1",
          { agentId: input.agentId, operationId: input.operationId, activity },
          [
            old.informationId,
            ...input.basis,
            ...union("deliveryIds"),
            ...union("feedbackIds"),
          ],
          activity.informationId,
        );
        await tx.query(
          "UPDATE information_continuity_activities SET state=$3,value=$4::jsonb WHERE agent_id=$1 AND id=$2",
          [input.agentId, old.id, activity.state, JSON.stringify(activity)],
        );
        await tx.query(
          "UPDATE information_continuity_agents SET revision=revision+1,main_activity_id=$2 WHERE agent_id=$1",
          [
            input.agentId,
            activity.state === "active"
              ? old.id
              : head.main_activity_id === old.id
                ? null
                : head.main_activity_id,
          ],
        );
        return activity;
      },
    );
  }
  async charge(input: {
    agentId: string;
    operationId: string;
    purpose: "appraisal" | "choice" | "execution" | "retry";
    basis: string[];
  }) {
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "charge", ...input },
      async (tx) => {
        const head = await this.head(tx, input.agentId);
        const day = continuityDay(this.now(), head.policy.timeZone);
        const used =
          (
            await tx.query<{ used: number }>(
              "SELECT used FROM information_continuity_budget WHERE agent_id=$1 AND day=$2",
              [input.agentId, day],
            )
          ).rows[0]?.used ?? 0;
        const allowed =
          head.policy.enabled && used < head.policy.dailyModelCalls;
        const remaining = Math.max(
          0,
          head.policy.dailyModelCalls - used - Number(allowed),
        );
        const informationId = await this.fact(
          tx,
          "agent.continuity.budget.v1",
          {
            ...input,
            day,
            timeZone: head.policy.timeZone,
            policyVersion: head.policy.version,
            allowed,
            remaining,
          },
          [head.policy_id, ...input.basis],
        );
        if (allowed)
          await tx.query(
            "INSERT INTO information_continuity_budget(agent_id,day,used) VALUES($1,$2,1) ON CONFLICT(agent_id,day) DO UPDATE SET used=information_continuity_budget.used+1",
            [input.agentId, day],
          );
        return { allowed, informationId, remaining };
      },
    );
  }
  async internalSource(input: { operationId: string; source: InternalSource }) {
    const source = internalSourceSchema.parse(input.source);
    const { occurredAt: _at, basis: _basis, ...seedIdentity } = source;
    const { occurredAt: _decisionAt, ...decisionIdentity } = source;
    return this.operation(
      source.agentId,
      input.operationId,
      {
        kind: "internal",
        ...input,
        source:
          source.type === "persona-seed"
            ? seedIdentity
            : source.type === "internal-choice"
              ? decisionIdentity
              : source,
      },
      async (tx) => {
        if (Date.parse(source.occurredAt) > this.now().getTime())
          throw new Error("future-internal-source");
        const basis = await tx.query<{
          kind: string;
          source: string;
          payload: any;
          occurred_at: string;
        }>(
          "SELECT kind,source,payload,occurred_at::text FROM information_atoms WHERE information_id=ANY($1::text[])",
          [source.basis],
        );
        if (basis.rows.length !== new Set(source.basis).size)
          throw new Error("missing-internal-basis");
        if (source.type === "internal-choice") {
          const decision = basis.rows.find(
            (b) =>
              b.kind === "core.model.task.completed" &&
              b.payload.taskId === "agent.continuity.choose",
          );
          const choice = decision?.payload.output;
          const frozen = decision
            ? (
                await tx.query<{ payload: any }>(
                  "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='agent.continuity.frozen.v1'",
                  [decision.payload.sourceInformationId],
                )
              ).rows[0]?.payload
            : undefined;
          const address = frozen?.source;
          if (
            !decision ||
            !choice ||
            source.text !==
              `${choice.reason}。选择：${choice.action}。下一步：${choice.nextStep}` ||
            !address ||
            JSON.stringify([
              address.platform,
              address.adapterId,
              address.destination.kind,
              address.destination.userId ??
                address.destination.groupId ??
                address.destination.conversationId ??
                null,
            ]) !== source.scope
          )
            throw new Error("unproven-internal-choice");
          source.occurredAt = new Date(decision.occurred_at).toISOString();
        }
        if (
          source.type === "experience" &&
          !basis.rows.some((b) =>
            [
              "agent.continuity.activity.v1",
              "core.action.result.v1",
              "core.action.reconciled.v1",
            ].includes(b.kind),
          )
        )
          throw new Error("unproven-experience");
        const related = [
          ...new Set(
            basis.rows
              .filter(
                (b) =>
                  b.kind === "agent.continuity.activity.v1" &&
                  b.payload.activity?.scope === source.scope,
              )
              .flatMap((b) => b.payload.activity.personIds as string[]),
          ),
        ];
        if (
          source.relatedPersonIds?.some((id) => !related.includes(id)) ||
          (source.type !== "experience" && source.relatedPersonIds?.length)
        )
          throw new Error("internal-person-unproved");
        if (source.type === "experience" && related.length)
          source.relatedPersonIds = related;
        if (
          source.type === "capability-evidence" &&
          !basis.rows.some(
            (b) =>
              ["core.action.result.v1", "core.action.reconciled.v1"].includes(
                b.kind,
              ) &&
              b.payload.outcome?.status === "succeeded" &&
              !["fenced", "unconfirmed"].includes(
                b.payload.outcome?.environmentValidation,
              ) &&
              b.payload.intent?.scope === source.scope,
          )
        )
          throw new Error("unproven-capability-evidence");
        return {
          informationId: await this.fact(
            tx,
            "agent.continuity.internal-source.v1",
            source,
            source.basis,
          ),
          source,
        };
      },
    );
  }
  async resource(input: {
    agentId: string;
    operationId: string;
    resource: EnvironmentResource;
  }) {
    const resource = environmentResourceSchema.parse(input.resource);
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "resource", ...input },
      async (tx) => {
        if (
          (resource.role === "verification") !== !!resource.verifies ||
          Date.parse(resource.readAt) > this.now().getTime()
        )
          throw new Error("invalid-resource-observation");
        const receipt = await new PostgresActionStore(this.db).inspectReceipt(
          resource.actionReceiptId,
          resource.scope,
          tx,
        );
        if (
          receipt.outcome.status !== "succeeded" ||
          ["fenced", "unconfirmed"].includes(
            receipt.outcome.environmentValidation ?? "",
          )
        )
          throw new Error("unproven-resource");
        if (
          !resource.artifactId ||
          !receipt.outcome.artifacts.some(
            (a) =>
              a.id === resource.artifactId &&
              a.hash === resource.contentHash &&
              a.scope === resource.scope,
          )
        )
          throw new Error("resource-hash-mismatch");
        if (resource.verifies) {
          const original = (
            await tx.query<{ value: EnvironmentResource }>(
              "SELECT value FROM information_continuity_resources WHERE id=$1 AND agent_id=$2",
              [resource.verifies, input.agentId],
            )
          ).rows[0]?.value;
          if (
            !original ||
            original.scope !== resource.scope ||
            original.contentHash !== resource.contentHash ||
            original.actionReceiptId === resource.actionReceiptId
          )
            throw new Error("verification-mismatch");
        }
        const informationId = await this.fact(
          tx,
          "agent.continuity.resource.v1",
          { agentId: input.agentId, resource },
          [
            resource.actionReceiptId,
            ...(resource.verifies ? [resource.verifies] : []),
          ],
          resource.id,
        );
        await tx.query(
          "INSERT INTO information_continuity_resources(id,agent_id,scope,value) VALUES($1,$2,$3,$4::jsonb)",
          [
            informationId,
            input.agentId,
            resource.scope,
            JSON.stringify(resource),
          ],
        );
        return informationId;
      },
    );
  }
  async planDelivery(input: {
    agentId: string;
    operationId: string;
    activityId: string;
    scope: string;
    completedInformationId: string;
  }) {
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "plan-delivery", ...input },
      async (tx) => {
        const a = (
          await tx.query<{ value: Activity }>(
            "SELECT value FROM information_continuity_activities WHERE id=$1 AND agent_id=$2 AND scope=$3",
            [input.activityId, input.agentId, input.scope],
          )
        ).rows[0]?.value;
        const c = (
          await tx.query<{ payload: any }>(
            "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.model.task.completed'",
            [input.completedInformationId],
          )
        ).rows[0]?.payload;
        if (
          !a ||
          a.kind !== "commitment" ||
          ["abandoned", "failed"].includes(a.state) ||
          a.reevaluationRequired ||
          c?.taskId !== "agent.heavy.respond" ||
          c.output?.continuity?.kind !== "deliver" ||
          c.output.continuity.activityId !== a.id
        )
          throw new Error("delivery-plan-unproved");
        const informationId = await this.fact(
          tx,
          "agent.continuity.delivery-plan.v1",
          input,
          [a.informationId, input.completedInformationId],
        );
        await tx.query(
          "INSERT INTO information_continuity_delivery_plans(completed_id,agent_id,activity_id,scope,information_id) VALUES($1,$2,$3,$4,$5)",
          [
            input.completedInformationId,
            input.agentId,
            a.id,
            a.scope,
            informationId,
          ],
        );
        return informationId;
      },
    );
  }
  /** 仅供受批准的宿主工具，模型不能指定目标、决策 ID 或权限。 */
  async prepareAutonomousDelivery(
    execution: ActionExecution,
  ): Promise<ContinuityDeliveryInput> {
    const { intent, intentId } = execution;
    const activityId = String(intent.arguments.activityId ?? "");
    return this.operation(
      "kaguya",
      `autonomous-delivery:${intentId}`,
      { intentId, intent },
      async (tx) => {
        const row = (
          await tx.query<{
            value: Activity;
            completed_id: string;
            spec: any;
            payload: any;
            original: unknown;
            attempt_id: string | null;
          }>(
            `SELECT a.value,c.completed_id,r.spec,m.payload,h.input original,h.attempt_id
        FROM information_native_tool_calls c JOIN information_native_tool_runs r ON r.run_id=c.run_id JOIN information_action_heads h ON h.intent_id=c.intent_id
        JOIN information_atoms m ON m.information_id=c.completed_id JOIN information_continuity_activities a ON a.id=r.spec->'continuity'->>'activityId'
        WHERE c.intent_id=$1 AND r.spec->'continuity'->>'agentId'='kaguya' AND r.spec->>'scope'=$2`,
            [intentId, intent.scope],
          )
        ).rows[0];
        const a = row?.value;
        const resources = intent.arguments.resourceIds;
        if (
          !row ||
          actionDigest(row.original) !== actionDigest(intent) ||
          row.attempt_id !== execution.attemptId ||
          !a ||
          a.id !== activityId ||
          a.kind !== "commitment" ||
          a.state !== "active" ||
          a.requestedState ||
          a.reevaluationRequired ||
          a.fulfillment === "declined" ||
          intent.providerId !== "core.continuity" ||
          intent.toolName !== "activity.deliver" ||
          typeof intent.arguments.text !== "string" ||
          !intent.arguments.text.trim() ||
          intent.arguments.text.length > 16000 ||
          !Array.isArray(resources) ||
          resources.some(
            (id) => typeof id !== "string" || !a.artifacts.includes(id),
          )
        )
          throw new Error("autonomous-delivery-unproved");
        const prior = await tx.query(
          `SELECT 1 FROM information_continuity_delivery_plans p JOIN information_action_heads h ON h.intent_id=p.origin_intent_id
        WHERE p.activity_id=$1 AND h.state=ANY($2::text[]) LIMIT 1`,
          [
            a.id,
            ["started", "cancel_requested", "unknown", "partial", "succeeded"],
          ],
        );
        if (prior.rowCount)
          throw new Error("commitment-delivery-already-submitted");
        const accepted = (
          await tx.query<{ payload: any }>(
            "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.message.inbound.text' AND source='runtime:ingress'",
            [a.acceptedFrom],
          )
        ).rows[0]?.payload;
        const address = accepted?.source;
        if (
          !address ||
          JSON.stringify([
            address.platform,
            address.adapterId,
            address.destination.kind,
            address.destination.userId ??
              address.destination.groupId ??
              address.destination.conversationId ??
              null,
          ]) !== intent.scope
        )
          throw new Error("autonomous-delivery-scope-denied");
        const decisionInformationId = await this.fact(
          tx,
          "agent.action.decision.v1",
          {
            observationId: intent.dependencies.observationId,
            domain: "message",
            reason: "accepted-commitment-delivery",
            policyVersion: "continuity-delivery.v1",
          },
          [intent.runInformationId, row.completed_id],
        );
        const input: ContinuityDeliveryInput = {
          originIntentId: intentId,
          completedInformationId: row.completed_id,
          contextInformationId: row.payload.contextInformationId,
          activityId,
          scope: intent.scope,
          decisionInformationId,
          dependencies: intent.dependencies,
          textHash: continuityTextHash(intent.arguments.text),
          address: {
            platform: address.platform,
            adapterId: address.adapterId,
            destination: address.destination,
          },
        };
        const informationId = await this.fact(
          tx,
          "agent.continuity.delivery-plan.v1",
          { ...input, resourceIds: resources },
          [
            a.informationId,
            row.completed_id,
            intentId,
            decisionInformationId,
            ...(resources as string[]),
          ],
        );
        await tx.query(
          "INSERT INTO information_continuity_delivery_plans(completed_id,agent_id,activity_id,scope,information_id,origin_intent_id,input) VALUES($1,'kaguya',$2,$3,$4,$5,$6::jsonb)",
          [
            row.completed_id,
            activityId,
            intent.scope,
            informationId,
            intentId,
            JSON.stringify(input),
          ],
        );
        return input;
      },
    );
  }
  async deliveryAuthorization(requestId: string) {
    return continuityDeliveryProof(this.db, requestId);
  }
  async autonomousDeliveryRequest(intentId: string): Promise<string | null> {
    const r = (
      await this.db.query<{ information_id: string }>(
        `SELECT req.information_id FROM information_atoms assistant
      JOIN information_references ref ON ref.target_information_id=assistant.information_id AND ref.relation='core:caused-by'
      JOIN information_atoms req ON req.information_id=ref.information_id AND req.kind='core.delivery.requested'
      WHERE assistant.kind='core.message.assistant.text' AND assistant.source='runtime:continuity' AND assistant.payload->>'originatingModuleInstanceId'=$1 LIMIT 2`,
        [`continuity.runtime:${intentId}`],
      )
    ).rows;
    if (r.length > 1) throw new Error("ambiguous-continuity-delivery");
    return r[0]?.information_id ?? null;
  }
  async observeDelivery(input: {
    agentId: string;
    deliveryInformationId: string;
  }) {
    const plans = (
      await this.db.query<{ activity_id: string; scope: string; payload: any }>(
        `WITH RECURSIVE chain(id,depth) AS (
      SELECT $1::text,0 UNION ALL SELECT r.target_information_id,c.depth+1 FROM chain c JOIN information_references r ON r.information_id=c.id WHERE r.relation='core:caused-by' AND c.depth<16)
      SELECT p.activity_id,p.scope,a.payload FROM chain c JOIN information_continuity_delivery_plans p ON p.completed_id=c.id JOIN information_atoms a ON a.information_id=$1 WHERE p.agent_id=$2 AND a.kind=ANY($3::text[])`,
        [
          input.deliveryInformationId,
          input.agentId,
          ["core.delivery.delivered", "core.delivery.failed"],
        ],
      )
    ).rows;
    for (const plan of plans) {
      const p = plan.payload;
      const destination = p.target;
      if (
        !destination ||
        JSON.stringify([
          p.platform,
          p.adapterId,
          destination.kind,
          destination.userId ??
            destination.groupId ??
            destination.conversationId ??
            null,
        ]) !== plan.scope
      )
        continue;
      const activity = (
        await this.read(input.agentId, plan.scope)
      )?.activities.find((a) => a.id === plan.activity_id);
      if (
        !activity ||
        activity.deliveryIds.includes(input.deliveryInformationId)
      )
        continue;
      await this.change({
        agentId: input.agentId,
        operationId: `delivery:${input.deliveryInformationId}`,
        expectedRevision: activity.revision,
        activityId: activity.id,
        change: { deliveryIds: [input.deliveryInformationId] },
        basis: [input.deliveryInformationId],
      });
    }
  }
  async feedback(input: {
    agentId: string;
    activityId: string;
    feedbackInformationId: string;
    completedInformationId: string;
    outcome: "fulfilled" | "declined";
  }) {
    let activity = (
      await this.db.query<{ value: Activity }>(
        "SELECT value FROM information_continuity_activities WHERE id=$1 AND agent_id=$2",
        [input.activityId, input.agentId],
      )
    ).rows[0]?.value;
    if (
      !activity ||
      activity.kind !== "commitment" ||
      activity.reevaluationRequired
    )
      throw new Error("feedback-activity-unavailable");
    const acceptedFrom = activity.acceptedFrom;
    const facts = (
      await this.db.query<{
        information_id: string;
        kind: string;
        source: string;
        payload: any;
        occurred_at: string;
      }>(
        "SELECT information_id,kind,source,payload,occurred_at FROM information_atoms WHERE information_id=ANY($1::text[])",
        [
          [
            input.feedbackInformationId,
            input.completedInformationId,
            activity.acceptedFrom,
          ],
        ],
      )
    ).rows;
    const feedback = facts.find(
      (r) => r.information_id === input.feedbackInformationId,
    );
    const accepted = facts.find((r) => r.information_id === acceptedFrom);
    const decision = facts.find(
      (r) => r.information_id === input.completedInformationId,
    );
    const proposed =
      decision?.payload.taskId === "agent.continuity.appraise"
        ? decision.payload.output?.feedback?.some(
            (f: any) =>
              f.activityId === input.activityId &&
              f.feedbackInformationId === input.feedbackInformationId &&
              f.outcome === input.outcome,
          )
        : decision?.payload.taskId === "agent.heavy.respond" &&
          decision.payload.output?.continuity?.kind === "feedback" &&
          decision.payload.output.continuity.activityId === input.activityId &&
          decision.payload.output.continuity.requestId ===
            input.feedbackInformationId &&
          decision.payload.output.continuity.outcome === input.outcome;
    if (
      feedback?.kind !== "core.message.inbound.text" ||
      feedback.source !== "runtime:ingress" ||
      !accepted ||
      decision?.kind !== "core.model.task.completed" ||
      !proposed ||
      actionDigest(feedback.payload.source.destination) !==
        actionDigest(accepted.payload.source.destination) ||
      feedback.payload.source.platform !== accepted.payload.source.platform ||
      feedback.payload.source.adapterId !== accepted.payload.source.adapterId ||
      feedback.payload.source.senderId !== accepted.payload.source.senderId
    )
      throw new Error("feedback-unproved");
    const context = await this.db.query(
      "SELECT 1 FROM information_atoms WHERE information_id=ANY($1::text[]) AND kind='agent.router.turn.context.completed' AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'inputs') i WHERE i->>'informationId'=$2)",
      [
        decision.payload.contextInformationIds ?? [],
        input.feedbackInformationId,
      ],
    );
    if (!context.rowCount) throw new Error("feedback-outside-evaluation");
    // 实际投递可能先于其异步投影。按因果链补齐，反馈不能确认未来的投递。
    const actual = (
      await this.db.query<{ information_id: string }>(
        `WITH RECURSIVE chain(id,depth) AS (
      SELECT completed_id,0 FROM information_continuity_delivery_plans WHERE agent_id=$1 AND activity_id=$2
      UNION SELECT r.information_id,c.depth+1 FROM chain c JOIN information_references r ON r.target_information_id=c.id
        WHERE r.relation='core:caused-by' AND c.depth<16)
      SELECT DISTINCT a.information_id FROM chain c JOIN information_atoms a ON a.information_id=c.id
      WHERE a.kind='core.delivery.delivered' AND a.payload->>'ok'='true' AND a.occurred_at::timestamptz<=$3::timestamptz LIMIT 100`,
        [input.agentId, activity.id, feedback!.occurred_at],
      )
    ).rows;
    for (const delivery of actual)
      await this.observeDelivery({
        agentId: input.agentId,
        deliveryInformationId: delivery.information_id,
      });
    activity = (
      await this.db.query<{ value: Activity }>(
        "SELECT value FROM information_continuity_activities WHERE id=$1 AND agent_id=$2",
        [activity.id, input.agentId],
      )
    ).rows[0]!.value;
    if (activity.reevaluationRequired)
      throw new Error("feedback-activity-unavailable");
    const delivered = await this.db.query(
      "SELECT 1 FROM information_atoms WHERE information_id=ANY($1::text[]) AND kind='core.delivery.delivered' AND payload->>'ok'='true' AND occurred_at::timestamptz<=$2::timestamptz LIMIT 1",
      [activity.deliveryIds, feedback!.occurred_at],
    );
    return this.change({
      agentId: input.agentId,
      operationId: `feedback:${input.completedInformationId}:${input.activityId}`,
      activityId: activity.id,
      expectedRevision: activity.revision,
      change: {
        feedbackIds: [input.feedbackInformationId],
        ...(input.outcome === "declined" || delivered.rowCount
          ? { fulfillment: input.outcome }
          : {}),
        ...(input.outcome === "fulfilled" &&
        delivered.rowCount &&
        !activity.inFlight &&
        !terminal.has(activity.state)
          ? { state: "completed" }
          : {}),
      },
      basis: [input.completedInformationId, input.feedbackInformationId],
    });
  }
  private async view(
    tx: SqlTransaction,
    agentId: string,
    scope: string,
    asOf: string,
  ): Promise<ContinuityView | null> {
    const head = (
      await tx.query<Head>(
        "SELECT * FROM information_continuity_agents WHERE agent_id=$1",
        [agentId],
      )
    ).rows[0];
    if (!head) return null;
    const day = continuityDay(new Date(asOf), head.policy.timeZone);
    const used =
      (
        await tx.query<{ used: number }>(
          "SELECT used FROM information_continuity_budget WHERE agent_id=$1 AND day=$2",
          [agentId, day],
        )
      ).rows[0]?.used ?? 0;
    const activities = (
      await tx.query<{ value: Activity }>(
        "SELECT value FROM information_continuity_activities WHERE agent_id=$1 AND scope=ANY($2::text[]) ORDER BY (id=$3) DESC,(state=ANY($4::text[])) DESC,(value->>'updatedAt') DESC,id LIMIT 101",
        [
          agentId,
          [scope, "shared"],
          head.main_activity_id,
          ["candidate", "active", "waiting", "paused"],
        ],
      )
    ).rows.map((r) => r.value);
    const resources = (
      await tx.query<{ value: EnvironmentResource }>(
        "SELECT value FROM information_continuity_resources WHERE agent_id=$1 AND scope=ANY($2::text[]) ORDER BY (value->>'readAt') DESC,id DESC LIMIT 101",
        [agentId, [scope, "shared"]],
      )
    ).rows.map((r) => r.value);
    const executionOutcomes = (
      await tx.query<{
        payload: any;
        readonly: boolean;
        activity_id: string;
        receipt_id: string;
        occurred_at: string;
      }>(
        `SELECT a.payload,(r.spec->'readOnlyToolIds' ? (h.input->>'toolName')) readonly,r.spec->'continuity'->>'activityId' activity_id,h.receipt_id,a.occurred_at::text
      FROM information_native_tool_runs r JOIN information_native_tool_calls c ON c.run_id=r.run_id JOIN information_action_heads h ON h.intent_id=c.intent_id
      JOIN information_atoms a ON a.information_id=h.receipt_id WHERE r.spec ? 'continuity' AND r.spec->'continuity'->>'activityId'=ANY($1::text[])
      AND h.input->>'scope'=ANY($2::text[]) ORDER BY a.occurred_at DESC,a.information_id LIMIT 64`,
        [activities.map((a) => a.id), [scope, "shared"]],
      )
    ).rows.map((r) => ({
      activityId: r.activity_id,
      receiptId: r.receipt_id,
      intentId: r.payload.intentId,
      operationId: r.payload.intent.operationId,
      attemptId: r.payload.attemptId,
      toolName: r.payload.intent.toolName,
      status: r.payload.outcome.status,
      evidence: r.payload.outcome.evidence,
      resultHash: r.payload.resultHash,
      jobId: /^[a-f0-9]{64}$/.test(r.payload.outcome.result?.jobId ?? "")
        ? r.payload.outcome.result.jobId
        : null,
      recordedAt: new Date(r.occurred_at).toISOString(),
      readOnly: r.readonly === true,
    }));
    const configured = this.host?.(scope);
    const environments = (
      await tx.query<{ intent_id: string; environment: any }>(
        `SELECT DISTINCT ON(h.input->'environment'->>'environmentId') h.intent_id,h.input->'environment' environment
      FROM information_action_heads h WHERE h.input->>'scope'=$1 AND h.input ? 'environment'
      ORDER BY h.input->'environment'->>'environmentId',(h.input->'environment'->>'expiresAt') DESC LIMIT 16`,
        [scope],
      )
    ).rows.map((r) => ({
      intentId: r.intent_id,
      environmentId: r.environment.environmentId,
      generation: r.environment.generation,
      workspaceId: r.environment.workspaceId,
      workflowId: r.environment.workflowId,
      leaseId: r.environment.leaseId,
      expiresAt: r.environment.expiresAt,
      validity:
        Date.parse(r.environment.expiresAt) > Date.parse(asOf)
          ? ("unexpired" as const)
          : ("expired" as const),
    }));
    const state =
      head.state && [scope, "shared"].includes(head.state.scope)
        ? head.state
        : null;
    return {
      ...(configured ? { host: { ...configured, environments } } : {}),
      agentId,
      revision: head.revision,
      policy: head.policy,
      policyInformationId: head.policy_id,
      contextInformationId: head.context_id,
      asOf,
      state,
      stateValidity: !head.state
        ? "unevaluated"
        : !state
          ? "unavailable"
          : Date.parse(state.expiresAt) <= Date.parse(asOf)
            ? "expired"
            : "current",
      activitiesTruncated: activities.length > 100,
      resourcesTruncated: resources.length > 100,
      activities: activities.slice(0, 100),
      resources: resources.slice(0, 100),
      executionOutcomes,
      busy:
        !!head.chat_run_id || (head.policy.enabled && !!head.main_activity_id),
      mainWorkKind: head.chat_run_id
        ? "request"
        : head.policy.enabled && head.main_activity_id
          ? "activity"
          : null,
      mainActivityId: activities.some((a) => a.id === head.main_activity_id)
        ? head.main_activity_id
        : null,
      budget: {
        day,
        timeZone: head.policy.timeZone,
        used,
        limit: head.policy.dailyModelCalls,
        remaining: Math.max(0, head.policy.dailyModelCalls - used),
      },
    };
  }
  async read(agentId: string, scope: string, at = this.now().toISOString()) {
    return this.db.transaction(async (tx) => {
      await tx.exec(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return this.view(tx, agentId, scope, at);
    });
  }
  /** 仅供已认证管理端列出范围。聊天冻结仍必须指定单一范围。 */
  async scopes(agentId: string): Promise<string[]> {
    const rows = await this.db.query<{ scope: string }>(
      "SELECT DISTINCT scope FROM information_continuity_activities WHERE agent_id=$1 UNION SELECT state->>'scope' FROM information_continuity_agents WHERE agent_id=$1 AND state IS NOT NULL LIMIT 100",
      [agentId],
    );
    return [...new Set([...rows.rows.map((r) => r.scope), "shared"])];
  }
  async unresolvedEffects(
    agentId: string,
    activityId: string,
  ): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM information_native_tool_runs r JOIN information_native_tool_calls c ON c.run_id=r.run_id
      JOIN information_action_heads h ON h.intent_id=c.intent_id JOIN information_atoms a ON a.information_id=h.receipt_id
      WHERE r.spec ? 'continuity' AND r.spec->'continuity'->>'agentId'=$1 AND r.spec->'continuity'->>'activityId'=$2
      AND NOT COALESCE(r.spec->'readOnlyToolIds' ? (h.input->>'toolName'),false)
      AND (a.payload->'outcome'->>'status'=ANY($3::text[]) OR a.payload->'outcome'->>'environmentValidation'=ANY($4::text[])) LIMIT 1`,
      [agentId, activityId, ["unknown", "partial"], ["fenced", "unconfirmed"]],
    );
    return !!rows.rowCount;
  }
  async receipts(agentId: string, scope: string, runInformationId: string) {
    return this.db.transaction(async (tx) => {
      await tx.exec(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const ids = (
        await tx.query<{ receipt_id: string }>(
          `SELECT DISTINCT h.receipt_id FROM information_action_heads h JOIN information_native_tool_calls c ON c.intent_id=h.intent_id
        JOIN information_native_tool_runs r ON r.run_id=c.run_id WHERE h.input->>'runInformationId'=$1 AND h.input->>'scope'=$2 AND h.receipt_id IS NOT NULL
        AND r.spec->'continuity'->>'agentId'=$3 LIMIT 128`,
          [runInformationId, scope, agentId],
        )
      ).rows;
      const receipts = [];
      for (const r of ids)
        receipts.push(
          await new PostgresActionStore(this.db).inspectReceipt(
            r.receipt_id,
            scope,
            tx,
          ),
        );
      return receipts;
    });
  }
  async frozen(agentId: string, operationId: string, scope: string) {
    const row = (
      await this.db.query<{
        result: {
          informationId: string;
          view: ContinuityView;
          atom: ReturnType<typeof informationAtomSchema.parse>;
        };
      }>(
        "SELECT result FROM information_continuity_operations WHERE agent_id=$1 AND operation_id=$2",
        [agentId, operationId],
      )
    ).rows[0]?.result;
    if (
      !row ||
      row.atom?.payload?.source === undefined ||
      row.atom.payload.view === undefined ||
      row.view.activities.some((a) => ![scope, "shared"].includes(a.scope))
    )
      return null;
    const source = row.atom.payload.source as any;
    if (
      JSON.stringify([
        source.platform,
        source.adapterId,
        source.destination.kind,
        source.destination.userId ??
          source.destination.groupId ??
          source.destination.conversationId ??
          null,
      ]) !== scope
    )
      return null;
    return row;
  }
  /** 宿主专用：工具循环只能在持久安全边界推进或释放主活动槽。 */
  async executionGate(
    agentId: string,
    activityId: string,
    runInformationId: string,
    mode: "enter" | "checkpoint" | "leave",
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      const head = await this.head(tx, agentId);
      const old = (
        await tx.query<{ value: Activity }>(
          "SELECT value FROM information_continuity_activities WHERE agent_id=$1 AND id=$2",
          [agentId, activityId],
        )
      ).rows[0]?.value;
      if (!old || (old.inFlight && old.inFlight !== runInformationId))
        return false;
      if (
        mode === "enter" &&
        (old.state !== "active" ||
          old.requestedState ||
          head.chat_run_id ||
          !head.policy.enabled ||
          old.reevaluationRequired ||
          head.main_activity_id !== old.id)
      )
        return false;
      if (
        mode === "checkpoint" &&
        old.inFlight === runInformationId &&
        head.main_activity_id === old.id &&
        !head.chat_run_id &&
        old.state === "active" &&
        !old.requestedState &&
        head.policy.enabled &&
        !old.reevaluationRequired
      )
        return true;
      if (mode !== "enter" && !old.inFlight) return false;
      if (mode === "enter" && old.inFlight === runInformationId) return true;
      const checkpoint =
        mode === "enter"
          ? []
          : (
              await tx.query<{ receipt_id: string }>(
                "SELECT h.receipt_id FROM information_action_heads h WHERE h.input->>'runInformationId'=$1 AND h.input->>'scope'=$2 AND h.receipt_id IS NOT NULL ORDER BY h.intent_id LIMIT 128",
                [runInformationId, old.scope],
              )
            ).rows.map((r) => r.receipt_id);
      const next = activitySchema.parse({
        ...old,
        revision: old.revision + 1,
        informationId: randomUUID(),
        updatedAt: this.now().toISOString(),
        checkpointReceiptIds: [
          ...new Set([...old.checkpointReceiptIds, ...checkpoint]),
        ].slice(-128),
        inFlight: mode === "enter" ? runInformationId : null,
        state:
          mode === "enter"
            ? old.state
            : old.suspension === "disabled" && head.policy.enabled
              ? "waiting"
              : (old.requestedState ??
                (!head.policy.enabled
                  ? "paused"
                  : old.reevaluationRequired
                    ? "waiting"
                    : old.state)),
        requestedState: null,
        suspension:
          mode !== "enter" &&
          old.suspension === "disabled" &&
          head.policy.enabled
            ? null
            : old.suspension,
      });
      await this.fact(
        tx,
        "agent.continuity.activity.v1",
        { agentId, activity: next, boundary: mode },
        [old.informationId, runInformationId],
        next.informationId,
      );
      await tx.query(
        "UPDATE information_continuity_activities SET state=$2,value=$3::jsonb WHERE id=$1",
        [old.id, next.state, JSON.stringify(next)],
      );
      const nextMain =
        head.main_activity_id === old.id
          ? next.state === "active"
            ? old.id
            : null
          : head.main_activity_id;
      await tx.query(
        "UPDATE information_continuity_agents SET revision=revision+1,main_activity_id=$2 WHERE agent_id=$1",
        [agentId, nextMain],
      );
      return mode === "enter";
    });
  }
  /** 重启只释放已经终止或到期的聊天占用，不重发其外部行动。 */
  async recoverCoordination(): Promise<void> {
    const stale = (
      await this.db.query<{ run_id: string }>(
        `SELECT DISTINCT r.run_id FROM information_native_tool_runs r
      WHERE (r.stopped_id IS NOT NULL OR (r.spec->>'deadline')::timestamptz<=$1::timestamptz)
      AND (EXISTS(SELECT 1 FROM information_continuity_agents a WHERE a.chat_run_id=r.run_id) OR
        EXISTS(SELECT 1 FROM information_continuity_activities a WHERE a.value->>'interruptedBy'=r.run_id AND a.value->>'suspension'='chat'))`,
        [this.now().toISOString()],
      )
    ).rows;
    for (const r of stale) await this.releaseChat(r.run_id);
  }
  /** 非独立聊天工具在实际调用前请求主槽，普通聊天及独立只读工具不触发切换。 */
  async claimChat(runInformationId: string, scope: string): Promise<boolean> {
    await this.recoverCoordination();
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      const head = (
        await tx.query<Head>(
          "SELECT * FROM information_continuity_agents WHERE agent_id='kaguya'",
        )
      ).rows[0];
      if (!head) return true;
      const run = (
        await tx.query<{ spec: any; stopped_id: string | null }>(
          "SELECT spec,stopped_id FROM information_native_tool_runs WHERE run_id=$1",
          [runInformationId],
        )
      ).rows[0];
      if (
        !run ||
        run.stopped_id ||
        run.spec.scope !== scope ||
        run.spec.continuity ||
        Date.parse(run.spec.deadline) <= this.now().getTime()
      )
        return false;
      if (head.chat_run_id) return head.chat_run_id === runInformationId;
      const old = head.main_activity_id
        ? (
            await tx.query<{ value: Activity }>(
              "SELECT value FROM information_continuity_activities WHERE id=$1",
              [head.main_activity_id],
            )
          ).rows[0]?.value
        : undefined;
      if (
        old?.inFlight &&
        (old.requestedState ||
          (old.interruptedBy && old.interruptedBy !== runInformationId))
      )
        return false;
      if (old) {
        const a = activitySchema.parse({
          ...old,
          revision: old.revision + 1,
          informationId: randomUUID(),
          updatedAt: this.now().toISOString(),
          state: old.inFlight ? old.state : "paused",
          requestedState: old.inFlight ? "paused" : null,
          suspension: "chat",
          interruptedBy: runInformationId,
          reason: "聊天工具需要暂时使用主行动槽",
        });
        await this.fact(
          tx,
          "agent.continuity.activity.v1",
          {
            agentId: "kaguya",
            activity: a,
            operationId: `chat-pause:${runInformationId}`,
          },
          [old.informationId, runInformationId],
          a.informationId,
        );
        await tx.query(
          "UPDATE information_continuity_activities SET state=$2,value=$3::jsonb WHERE id=$1",
          [a.id, a.state, JSON.stringify(a)],
        );
        await tx.query(
          "UPDATE information_continuity_agents SET revision=revision+1,main_activity_id=$1 WHERE agent_id='kaguya'",
          [a.inFlight ? a.id : null],
        );
        if (a.inFlight) return false;
      }
      await this.fact(
        tx,
        "agent.continuity.coordination.v1",
        {
          agentId: "kaguya",
          event: "request-claimed",
          runInformationId,
          scope,
        },
        [runInformationId],
      );
      await tx.query(
        "UPDATE information_continuity_agents SET revision=revision+1,chat_run_id=$1 WHERE agent_id='kaguya'",
        [runInformationId],
      );
      return true;
    });
  }
  async releaseChat(runInformationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      const head = (
        await tx.query<Head>(
          "SELECT * FROM information_continuity_agents WHERE agent_id='kaguya'",
        )
      ).rows[0];
      if (!head) return;
      if (head.chat_run_id === runInformationId) {
        await this.fact(
          tx,
          "agent.continuity.coordination.v1",
          { agentId: "kaguya", event: "request-released", runInformationId },
          [runInformationId],
        );
        await tx.query(
          "UPDATE information_continuity_agents SET revision=revision+1,chat_run_id=NULL WHERE agent_id='kaguya'",
          [],
        );
      }
      const rows = (
        await tx.query<{ value: Activity }>(
          "SELECT value FROM information_continuity_activities WHERE agent_id='kaguya' AND state=ANY($1::text[]) AND value->>'interruptedBy'=$2 AND value->>'suspension'='chat'",
          [["paused", "active"], runInformationId],
        )
      ).rows;
      for (const { value: old } of rows) {
        const a = activitySchema.parse({
          ...old,
          revision: old.revision + 1,
          informationId: randomUUID(),
          updatedAt: this.now().toISOString(),
          state:
            old.state === "paused" && head.policy.enabled
              ? "waiting"
              : old.state,
          requestedState:
            old.inFlight && old.requestedState === "paused"
              ? null
              : old.requestedState,
          suspension: head.policy.enabled ? null : "disabled",
          interruptedBy: null,
          reason: "聊天工具已释放主槽，从活动保存点继续",
        });
        await this.fact(
          tx,
          "agent.continuity.activity.v1",
          {
            agentId: "kaguya",
            activity: a,
            operationId: `chat-resume:${runInformationId}`,
          },
          [old.informationId, runInformationId],
          a.informationId,
        );
        await tx.query(
          "UPDATE information_continuity_activities SET state=$2,value=$3::jsonb WHERE id=$1",
          [a.id, a.state, JSON.stringify(a)],
        );
        await tx.query(
          "UPDATE information_continuity_agents SET revision=revision+1 WHERE agent_id='kaguya'",
        );
      }
    });
  }
  async freeze(input: {
    agentId: string;
    operationId: string;
    scope: string;
    basis: string[];
    activityId?: string;
    memory?: NativeMemorySnapshot;
  }) {
    const { memory: _memory, ...identity } = input;
    return this.operation(
      input.agentId,
      input.operationId,
      { kind: "freeze", ...identity },
      async (tx) => {
        const view = await this.view(
          tx,
          input.agentId,
          input.scope,
          this.now().toISOString(),
        );
        if (!view) throw new Error("continuity-not-configured");
        const memory = input.memory
          ? nativeMemorySnapshotSchema.parse(input.memory)
          : undefined;
        if (memory && memory.scope !== input.scope)
          throw new Error("memory-scope-mismatch");
        if (
          input.activityId &&
          !view.activities.some(
            (a) => a.id === input.activityId && a.state === "active",
          )
        )
          throw new Error("activity-not-active");
        const [platform, adapterId, kind, id] = input.scope.startsWith("[")
          ? JSON.parse(input.scope)
          : [
              "kaguya",
              "internal",
              "web",
              "00000000-0000-4000-8000-000000000001",
            ];
        const source = {
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
        const informationId = await this.fact(
          tx,
          input.activityId
            ? "agent.continuity.execution.frozen.v1"
            : "agent.continuity.frozen.v1",
          {
            view,
            source,
            ...(input.activityId ? { activityId: input.activityId } : {}),
            ...(memory ? { memory } : {}),
          },
          [
            ...input.basis,
            ...(view.state ? [view.state.informationId] : []),
            ...view.activities.map((a) => a.informationId),
            ...view.resources.map((r) => r.id),
          ],
          randomUUID(),
          view.contextInformationId,
        );
        const row = (
          await tx.query<{
            kind: string;
            payload: Record<string, any>;
            source: string;
            occurred_at: string;
          }>(
            "SELECT kind,payload,source,occurred_at::text FROM information_atoms WHERE information_id=$1",
            [informationId],
          )
        ).rows[0]!;
        const refs = (
          await tx.query<{ relation: string; target_information_id: string }>(
            "SELECT relation,target_information_id FROM information_references WHERE information_id=$1 ORDER BY ordinal",
            [informationId],
          )
        ).rows;
        return {
          informationId,
          view,
          atom: informationAtomSchema.parse({
            informationId,
            kind: row.kind,
            payload: row.payload,
            source: row.source,
            occurredAt: new Date(row.occurred_at).toISOString(),
            references: refs.map((r) => ({
              relation: r.relation,
              informationId: r.target_information_id,
            })),
          }),
        };
      },
    );
  }
}
