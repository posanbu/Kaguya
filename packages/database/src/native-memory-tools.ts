/**
 * 功能概述：向原生工具提供按 step 冻结的 Memory 查询、精读、历史和有证据修订。
 * NativeMemoryTools 从宿主持久 step 解析 scope/owners/cutoff；模型只能提交查询及明确节点修订。
 * 发布与 W3 执行资格、选定回执身份、来源正规化同持 7149321，actor/proof/owner 均由宿主生成。
 * 每次工具输出单独持久化，重放保持同一个快照；不改变旧 observation、Memory epoch 或原始来源。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createNativeMemoryAccess,
  canonicalMemorySourceId,
  type MemoryReadContext,
} from "@kaguya/memory";
import {
  nativeMemorySnapshotSchema,
  nativeMemoryNodeSchema,
  freezeInformationAtom,
  informationAtomSchema,
  z,
  type NativeMemoryNode,
  type JsonObject,
} from "@kaguya/schema";
import { nativeToolStepSchema, type ActionExecution } from "@kaguya/sdk";
import { PostgresNativeMemoryStore } from "./native-memory.js";
import { PostgresActionStore, actionDigest } from "./action-store.js";
import {
  readMemoryInvalidations,
  readMemoryView,
  memoryUpper,
} from "./native-memory-history.js";
import { sourceProofOwners } from "./native-memory-proof.js";
import { appendInformationAtom } from "./information-repository.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

const id = z.string().min(1).max(1000),
  nodeId = z.uuid();
export const nativeMemoryToolSchemas = {
  "memory.query": z.object({ query: z.string().max(4000) }).strict(),
  "memory.read": z
    .object({ id: nodeId, revision: z.number().int().positive() })
    .strict(),
  "memory.history": z
    .object({
      id: nodeId,
      limit: z.number().int().min(1).max(50),
      cursor: z.string().max(4000).nullable(),
    })
    .strict(),
  "memory.correct": z
    .object({
      id: nodeId,
      revision: z.number().int().positive(),
      content: z.string().min(1).max(16000),
      receiptIds: z.array(id).max(16),
    })
    .strict(),
  "memory.record": z
    .object({
      content: z.string().min(1).max(16000),
      receiptIds: z.array(id).min(1).max(16),
    })
    .strict(),
};
export async function prepareNativeMemoryToolSchema(db: SqlDatabase) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS memory_native_tool_outputs(operation_id text PRIMARY KEY,input_hash text NOT NULL,result jsonb NOT NULL)`,
  );
}
function facade(tx: SqlTransaction): SqlDatabase {
  return {
    query: tx.query.bind(tx),
    exec: tx.exec.bind(tx),
    transaction: async (run) => run(tx),
    close: async () => {},
  };
}
export class NativeMemoryTools {
  constructor(private readonly db: SqlDatabase) {}
  private async context(tx: SqlTransaction, input: ActionExecution) {
    const stepId = input.intent.target.stepInformationId;
    const row = (
      await tx.query<{ payload: any; spec: any }>(
        `SELECT a.payload,r.spec FROM information_native_tool_steps s JOIN information_native_tool_runs r USING(run_id)
      JOIN information_atoms a ON a.information_id=s.frozen_id JOIN information_native_tool_calls c ON c.run_id=s.run_id AND c.step_index=s.step_index
      WHERE s.frozen_id=$1 AND c.intent_id=$2 AND c.call_id=$3`,
        [stepId, input.intentId, input.intent.toolCallId],
      )
    ).rows[0];
    if (
      !row ||
      row.spec.scope !== input.intent.scope ||
      row.spec.actionRunInformationId !== input.intent.runInformationId
    )
      throw new Error("memory-tool-scope-denied");
    const step = nativeToolStepSchema.parse(row.payload),
      snapshot = nativeMemorySnapshotSchema.parse(step.memory);
    if (
      snapshot.status !== "enabled" ||
      snapshot.scope !== input.intent.scope ||
      !snapshot.cutoff
    )
      throw new Error("memory-tool-disabled");
    const context: MemoryReadContext = {
      scope: snapshot.scope,
      owners: snapshot.owners,
      asOf: snapshot.frozenAt,
      query: "",
      cutoff: snapshot.cutoff,
      participants: snapshot.participants,
    };
    return { step, snapshot, context, stepId: String(stepId) };
  }
  private async visible(
    tx: SqlTransaction,
    node: NativeMemoryNode,
    context: MemoryReadContext,
    position: string,
  ) {
    if (Date.parse(node.metadata.occurredAt) > Date.parse(context.asOf))
      return false;
    if (!(
      node.metadata.scope === context.scope ||
      (node.metadata.scope === "shared" &&
        context.owners.includes(node.metadata.ownerId) &&
        ["person", "self", "expression"].includes(node.metadata.kind))
    ))
      return false;
    const view = await readMemoryView(tx, position, { ids: [node.id] });
    if (
      view.invalid.has(node.id) ||
      view.blocked.has(node.id) ||
      node.metadata.status !== "active"
    )
      return false;
    const nodes = [...view.nodes.values()],
      sources = [...new Set(nodes.flatMap((n) => n.metadata.sourceIds))];
    const proof = await sourceProofOwners(tx, sources);
    const owners = new Set([
      ...nodes.map((n) => n.metadata.ownerId),
      ...proof.keys(),
      ...nodes.flatMap((n) =>
        [
          ...(n.metadata.proofOwners ?? []),
          ...(n.metadata.experience?.proofOwners ?? []),
        ]
          .filter((p) =>
            p.sourceIds.some((s) => n.metadata.sourceIds.includes(s)),
          )
          .map((p) => p.ownerId),
      ),
    ]);
    const effects = await readMemoryInvalidations(
      tx,
      undefined,
      [...owners],
      sources,
    );
    return !effects.withdrawn.size && !effects.identities.size;
  }
  private async history(
    tx: SqlTransaction,
    context: MemoryReadContext,
    id: string,
    limit: number,
    cursor: string | null,
    revision?: number,
  ) {
    const upper = context.cutoff!.publicationPosition;
    const binding = actionDigest({
      scope: context.scope,
      owners: [...context.owners].sort(),
      asOf: context.asOf,
      upper,
      id,
    });
    let before: string | null = null;
    if (cursor) {
      const c = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        c.binding !== binding ||
        !/^\d+$/.test(c.before) ||
        BigInt(c.before) > BigInt(upper)
      )
        throw new Error("memory-tool-cursor-denied");
      before = c.before;
    }
    const rows = (
      await tx.query<{
        information_id: string;
        position: string;
        node: NativeMemoryNode;
      }>(
        `SELECT p.information_id,l.position::text,n.node FROM memory_native_publications p JOIN information_lifecycle l ON l.information_id=p.information_id
      CROSS JOIN LATERAL jsonb_array_elements(p.nodes) n(node) WHERE n.node->>'id'=$1 AND l.position<=$2::bigint AND ($3::bigint IS NULL OR l.position<$3::bigint)
      AND ($4::integer IS NULL OR (n.node->'metadata'->>'revision')::integer=$4) ORDER BY l.position DESC LIMIT $5`,
        [id, upper, before, revision ?? null, limit + 1],
      )
    ).rows;
    // 页面按原持久位置推进，拒绝项不泄露正文、修订号或提交身份。
    const page = rows.slice(0, limit),
      items = [];
    for (const row of page)
      if (
        await this.visible(
          tx,
          nativeMemoryNodeSchema.parse(row.node),
          context,
          row.position,
        )
      )
        items.push(row);
    return {
      items,
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({ binding, before: page.at(-1)!.position }),
            ).toString("base64url")
          : null,
    };
  }
  private async normalize(
    tx: SqlTransaction,
    input: ActionExecution,
    receiptIds: string[],
    stepIndex: number,
  ) {
    const sourceIds: string[] = [];
    for (const receiptId of [...new Set(receiptIds)]) {
      const binding = (
        await tx.query<{ intent_id: string; call_id: string; input: any }>(
          `SELECT c.intent_id,c.call_id,h.input FROM information_native_tool_calls c JOIN information_native_tool_runs r USING(run_id)
        JOIN information_atoms a ON a.information_id=c.result_id JOIN information_action_heads h ON h.intent_id=c.intent_id
        WHERE r.run_id=$1 AND c.step_index<$2 AND a.payload->>'receiptId'=$3 AND a.payload->>'intentId'=c.intent_id AND a.payload->>'toolCallId'=c.call_id`,
          [input.intent.target.runInformationId, stepIndex, receiptId],
        )
      ).rows[0];
      if (!binding || binding.input.scope !== input.intent.scope)
        throw new Error("memory-receipt-not-selected");
      // 同事务重验回执及原授权，过期/撤回授权不由 Memory 自行续期。
      const receipt = await new PostgresActionStore(this.db).readReceipt(
        receiptId,
        input.intent.scope,
        binding.input.authorizationId,
        tx,
      );
      if (
        receipt.intentId !== binding.intent_id ||
        receipt.intent.toolCallId !== binding.call_id
      )
        throw new Error("memory-receipt-binding-invalid");
      const epoch = (
        await tx.query(
          "SELECT 1 FROM information_lifecycle l,memory_native_epoch e WHERE l.information_id=$1 AND l.position>e.source_after",
          [receiptId],
        )
      ).rowCount;
      if (!epoch) throw new Error("memory-receipt-before-epoch");
      const prior = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1",
          [canonicalMemorySourceId(receiptId)],
        )
      ).rows[0];
      const receiptProof = {
        intentId: receipt.intentId,
        attemptId: receipt.attemptId,
        toolCallId: binding.call_id,
        resultHash: receipt.resultHash,
      };
      if (prior) {
        if (
          actionDigest(prior.payload.receiptProof) !==
          actionDigest(receiptProof)
        )
          throw new Error("memory-receipt-proof-conflict");
        sourceIds.push(receiptId);
        continue;
      }
      const dependencies = new Set<string>(
        receipt.intent.dependencies.sourceInformationIds,
      );
      const owners = new Set<string>(["self:kaguya"]);
      for (const ref of receipt.intent.dependencies.memoryRevisions) {
        const history = (
          await tx.query<{ node: NativeMemoryNode }>(
            `SELECT n.node FROM memory_native_publications p CROSS JOIN LATERAL jsonb_array_elements(p.nodes) n(node) WHERE n.node->>'id'=$1 AND (n.node->'metadata'->>'revision')::integer=$2 LIMIT 1`,
            [ref.id, ref.revision],
          )
        ).rows[0];
        if (!history) throw new Error("memory-receipt-dependency-missing");
        history.node.metadata.sourceIds.forEach((id) => dependencies.add(id));
        owners.add(history.node.metadata.ownerId);
        for (const p of [
          ...(history.node.metadata.proofOwners ?? []),
          ...(history.node.metadata.experience?.proofOwners ?? []),
        ])
          if (
            p.sourceIds.some((id) =>
              history.node.metadata.sourceIds.includes(id),
            )
          )
            owners.add(p.ownerId);
      }
      const proof = await sourceProofOwners(tx, [...dependencies]);
      for (const owner of proof.keys()) owners.add(owner);
      const effects = await readMemoryInvalidations(
        tx,
        undefined,
        [...owners],
        [...dependencies],
      );
      if (effects.withdrawn.size || effects.identities.size)
        throw new Error("memory-receipt-source-invalidated");
      const text = JSON.stringify({
        kind: "tool-observation",
        tool: receipt.intent.toolName,
        status: receipt.outcome.status,
        evidence: receipt.outcome.evidence,
        environmentValidation: receipt.outcome.environmentValidation ?? null,
        result: receipt.outcome.result,
      });
      const source = {
        id: receiptId,
        scope: input.intent.scope,
        ownerId: "self:kaguya",
        text,
        occurredAt: receipt.recordedAt,
        collectedAt: new Date().toISOString(),
        sourceType: "action-result",
        participants: [],
        replyTo: null,
      };
      await tx.query(
        "INSERT INTO information_kinds(kind) VALUES('memory.native.source.v1') ON CONFLICT DO NOTHING",
      );
      await appendInformationAtom(
        tx,
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId: canonicalMemorySourceId(receiptId),
            kind: "memory.native.source.v1",
            source: "memory:action-receipt",
            occurredAt: receipt.recordedAt,
            payload: {
              memorySource: source,
              originalInformationId: receiptId,
              text,
              receiptProof,
              sourceProofVersion: 1,
              sourceOwners: [...owners].sort(),
              sourceDependencies: [...dependencies].sort(),
            },
            references: [
              { relation: "core:uses-context", informationId: receiptId },
            ],
          }),
        ),
        [{ relation: "core:uses-context", required: true, multiple: false }],
        { enqueueLogProjection: false },
      );
      sourceIds.push(receiptId);
    }
    return sourceIds;
  }
  async execute(input: ActionExecution): Promise<JsonObject> {
    const name = input.intent.toolName as keyof typeof nativeMemoryToolSchemas;
    const schema = nativeMemoryToolSchemas[name];
    if (!schema) throw new Error("memory-tool-unknown");
    const args = schema.parse(input.intent.arguments) as any;
    const hash = actionDigest({ name, args, target: input.intent.target });
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      await new PostgresActionStore(this.db).assertEffectAllowed(input, tx);
      const prior = (
        await tx.query<{ input_hash: string; result: JsonObject }>(
          "SELECT input_hash,result FROM memory_native_tool_outputs WHERE operation_id=$1",
          [input.operationId],
        )
      ).rows[0];
      if (prior) {
        if (prior.input_hash !== hash)
          throw new Error("memory-tool-operation-conflict");
        return prior.result;
      }
      const { step, context, snapshot } = await this.context(tx, input);
      const store = new PostgresNativeMemoryStore(facade(tx), true);
      const access = createNativeMemoryAccess({ enabled: true, store });
      let result: any;
      if (name === "memory.query")
        result = {
          memorySnapshot: await access.freeze({
            ...context,
            query: args.query,
          }),
        };
      else if (name === "memory.read" || name === "memory.history") {
        const page = await this.history(
          tx,
          context,
          args.id,
          args.limit ?? 1,
          args.cursor ?? null,
          args.revision,
        );
        if (name === "memory.read" && page.items.length !== 1)
          throw new Error("memory-tool-revision-unavailable");
        const nodes = page.items.map((i) => i.node);
        result = {
          ...page,
          memorySnapshot: {
            ...snapshot,
            fixed: [],
            recalled: nodes.map((node) => ({
              node,
              traces: [],
              truncated: false,
            })),
            personCandidates: [],
            pendingEvidence: [],
          },
        };
        // 历史每个条目有自己的 publication 上界，不能拿最后一个快照伪称所有版本同时存在。
        if (name === "memory.history") {
          delete result.memorySnapshot;
          result.memorySnapshots = page.items.map((i) => ({
            ...snapshot,
            cutoff: { publicationPosition: i.position },
            fixed: [],
            recalled: [{ node: i.node, traces: [], truncated: false }],
            personCandidates: [],
            pendingEvidence: [],
          }));
        } else
          result.memorySnapshot.cutoff = {
            publicationPosition: page.items[0]!.position,
          };
      } else {
        const sourceIds = await this.normalize(
          tx,
          input,
          args.receiptIds,
          step.stepIndex,
        );
        let node: NativeMemoryNode,
          expectedRevision = 0;
        if (name === "memory.correct") {
          const page = await this.history(
            tx,
            context,
            args.id,
            1,
            null,
            args.revision,
          );
          if (!page.items[0])
            throw new Error("memory-tool-revision-unavailable");
          node = nativeMemoryNodeSchema.parse(page.items[0].node);
          expectedRevision = args.revision;
          if (
            !["self", "experience"].includes(node.metadata.kind) ||
            node.metadata.ownerId !== "self:kaguya"
          )
            throw new Error("memory-tool-correction-owner-denied");
          node = {
            ...node,
            content: args.content,
            metadata: {
              ...node.metadata,
              revision: expectedRevision + 1,
              sourceIds: [
                ...new Set([...node.metadata.sourceIds, ...sourceIds]),
              ],
            },
          };
        } else
          node = nativeMemoryNodeSchema.parse({
            id: randomUUID(),
            content: args.content,
            metadata: {
              system: "native-v1",
              kind: "experience",
              scope: context.scope,
              ownerId: "self:kaguya",
              level: 1,
              revision: 1,
              status: "active",
              locked: false,
              sourceIds,
              aliases: [],
              tags: ["tool-observation"],
              occurredAt: new Date().toISOString(),
            },
          });
        const nodes = await store.publish({
          operationId: `memory-tool:${createHash("sha256").update(input.operationId).digest("hex")}`,
          actor: "automatic",
          expectedVersions: expectedRevision
            ? { [node.id]: expectedRevision }
            : {},
          nodes: [{ node, expectedRevision }],
        });
        const next = {
          ...context,
          asOf: new Date().toISOString(),
          cutoff: { publicationPosition: await memoryUpper(tx) },
          explicitIds: nodes.map((n) => n.id),
        };
        result = { nodes, memorySnapshot: await access.freeze(next) };
      }
      result = JSON.parse(JSON.stringify(result));
      await tx.query(
        "INSERT INTO memory_native_tool_outputs(operation_id,input_hash,result) VALUES($1,$2,$3::jsonb)",
        [input.operationId, hash, JSON.stringify(result)],
      );
      await new PostgresActionStore(this.db).assertEffectAllowed(
        input,
        tx,
        false,
      );
      return result as JsonObject;
    });
  }
}
