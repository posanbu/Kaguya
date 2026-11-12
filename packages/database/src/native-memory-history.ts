/**
 * 功能概述：从不可变 native 发布重建指定提交上界内的节点、边及来源有效性。
 * 主要职责：memoryUpper 读取同快照内已提交前缀；readMemoryView 按目标范围重建最后节点与边操作，
 * scopedNodes 执行读取范围及状态筛选；来源撤回只沿 summarizes/derived-from 依赖传播。
 * 代码库关系：native-memory 的所有读取共用此实现；currentInvalidity 仅读局部依赖元数据；全文历史查询从历史正文计算，
 * 不使用当前索引或当前边。publish 必须持有 7149321 写锁直到提交，保证发布前缀有序。
 * 回执正规来源通过 sourceDependencies 保留实际依赖；撤回沿该持久闭包投影到来源根。
 * Inspection 可传 maxNodes 限制历史依赖展开；超限明确失败，不能输出不完整的有效性证明。
 * 输入输出与副作用：只读 SQL，返回独立 Map；不修改 epoch、原文或已发布 revision。
 */
import {
  nativeMemoryNodeSchema,
  type NativeMemoryNode,
  type MemoryReadContext,
} from "@kaguya/memory";
import { persistedSourceProofOwners } from "./native-memory-proof.js";
import type { SqlTransaction } from "./driver.js";

export type HistoricalEdge = {
  sourceId: string;
  targetId: string;
  relation: string;
  metadata?: Record<string, unknown>;
};
export interface MemoryView {
  nodes: Map<string, NativeMemoryNode>;
  edges: HistoricalEdge[];
  invalid: Set<string>;
  blocked: Set<string>;
  withdrawn: Set<string>;
  identities: Set<string>;
}
/** 新通用映射与旧 experience 映射共同参与读取，不修改历史节点。 */
function nodeProofOwners(n: NativeMemoryNode) {
  return [
    ...(n.metadata.proofOwners ?? []),
    ...(n.metadata.experience?.proofOwners ?? []),
  ];
}
export async function memoryUpper(db: SqlTransaction): Promise<string> {
  return (
    await db.query<{
      position: string;
    }>(`SELECT COALESCE((SELECT l.position FROM information_lifecycle l
      WHERE l.kind='memory.native.revision.v1' AND EXISTS(SELECT 1 FROM memory_native_publications p WHERE p.information_id=l.information_id)
      ORDER BY l.position DESC LIMIT 1),0)::text position`)
  ).rows[0]!.position;
}
/** 只投影失效目标，不读取 publication 正文。参数限定本次候选涉及的 owner/source。 */
export async function readMemoryInvalidations(
  db: SqlTransaction,
  upper: string | undefined,
  owners: readonly string[],
  sources: readonly string[],
) {
  const closure = (
    await db.query<{ root: string; id: string }>(
      `WITH RECURSIVE deps(root,id) AS (
    SELECT id,id FROM unnest($1::text[]) id UNION
    SELECT d.root,child FROM deps d JOIN information_atoms a ON a.information_id='memory-native-source:'||d.id
      JOIN information_lifecycle l ON l.information_id=a.information_id
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(a.payload->'sourceDependencies','[]'::jsonb)) child
      WHERE a.kind='memory.native.source.v1' AND a.payload->>'sourceProofVersion'='1' AND ($2::bigint IS NULL OR l.position<=$2::bigint)
    ) SELECT root,id FROM deps LIMIT 8193`,
      [sources, upper ?? null],
    )
  ).rows;
  if (closure.length > 8192) throw new Error("memory-source-closure-budget");
  const expandedSources = [...new Set(closure.map((d) => d.id))];
  const rows = (
    await db.query<{ kind: string; target: string }>(
      `SELECT effect->>'kind' kind,effect->>'targetId' target
    FROM memory_native_publications p JOIN information_atoms a ON a.information_id=p.information_id
    JOIN information_lifecycle l ON l.information_id=p.information_id
    CROSS JOIN LATERAL jsonb_array_elements(a.payload->'invalidations') effect
    WHERE a.kind='memory.native.revision.v1' AND a.payload ? 'invalidations' AND ($1::bigint IS NULL OR l.position<=$1::bigint) AND
      ((effect->>'kind'='identity-split' AND effect->>'targetId'=ANY($2::text[])) OR
       (effect->>'kind'='source-withdrawal' AND effect->>'targetId'=ANY($3::text[])))`,
      [upper ?? null, owners, expandedSources],
    )
  ).rows;
  return {
    withdrawn: new Set(
      rows
        .filter((r) => r.kind === "source-withdrawal")
        .flatMap((r) => [
          r.target,
          ...closure.filter((d) => d.id === r.target).map((d) => d.root),
        ]),
    ),
    identities: new Set(
      rows.filter((r) => r.kind === "identity-split").map((r) => r.target),
    ),
  };
}
/** 证明闭包只投影元数据；predecessors 仅作审计，proofOwners 绑定输出实际分配的证据。 */
export async function memoryProofMetadata(
  db: SqlTransaction,
  seeds: readonly string[],
) {
  if (!seeds.length) return [];
  const rows = (
    await db.query<{
      root: string;
      status: string;
      owner: string;
      sources: string[];
      unproved: string[];
    }>(
      `WITH RECURSIVE proof(root,id) AS (
    SELECT seed,seed FROM unnest($1::uuid[]) seed
    UNION SELECT p.root,e.target_id FROM proof p JOIN memory_edges e ON e.source_id=p.id
      WHERE e.relation IN ('summarizes','derived-from')
    ), metadata AS (SELECT p.root,n.metadata FROM proof p JOIN memory_nodes n ON n.id=p.id WHERE n.metadata->>'system'='native-v1')
    SELECT root::text,metadata->>'status' status,metadata->>'ownerId' owner,metadata->'sourceIds' sources,
      ARRAY(SELECT id FROM jsonb_array_elements_text(metadata->'sourceIds') id WHERE NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(metadata->'proofOwners','[]'::jsonb)) owner WHERE owner->'sourceIds' ? id)) unproved FROM metadata
    UNION ALL SELECT root::text,'active',owner->>'ownerId',to_jsonb(ARRAY(SELECT value FROM jsonb_array_elements_text(owner->'sourceIds') WHERE metadata->'sourceIds' ? value)),
      ARRAY(SELECT id FROM jsonb_array_elements_text(owner->'sourceIds') id WHERE metadata->'sourceIds' ? id AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(metadata->'proofOwners','[]'::jsonb)) verified WHERE verified->'sourceIds' ? id)) FROM metadata
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(metadata->'proofOwners','[]'::jsonb) || COALESCE(metadata->'experience'->'proofOwners','[]'::jsonb)) owner
      WHERE owner->'sourceIds' ?| ARRAY(SELECT jsonb_array_elements_text(metadata->'sourceIds'))`,
      [seeds],
    )
  ).rows;
  const persisted = await persistedSourceProofOwners(
    db,
    [...new Set(rows.flatMap((r) => r.sources))],
    await memoryUpper(db),
  );
  const extra: typeof rows = [];
  for (const row of rows) {
    for (const [owner, ids] of persisted) {
      const sources = row.sources.filter((id) => ids.has(id));
      if (sources.length)
        extra.push({
          root: row.root,
          status: "active",
          owner,
          sources,
          unproved: [],
        });
    }
    row.unproved = row.unproved.filter(
      (id) => ![...persisted.values()].some((ids) => ids.has(id)),
    );
  }
  return [...rows, ...extra];
}
export async function currentInvalidity(
  db: SqlTransaction,
  seeds: readonly string[],
  blockedOnly = false,
): Promise<Set<string>> {
  const rows = await memoryProofMetadata(db, seeds);
  const effects = await readMemoryInvalidations(
    db,
    undefined,
    rows.map((r) => r.owner),
    rows.flatMap((r) => r.sources),
  );
  return new Set(
    rows
      .filter(
        (r) =>
          r.unproved.length > 0 ||
          (!blockedOnly && r.status !== "active") ||
          effects.identities.has(r.owner) ||
          r.sources.some((id) => effects.withdrawn.has(id)),
      )
      .map((r) => r.root),
  );
}
export async function readMemoryView(
  db: SqlTransaction,
  upper: string,
  selection: {
    scope?: string;
    owners?: readonly string[];
    ids?: readonly string[];
    maxNodes?: number;
  },
): Promise<MemoryView> {
  const nodes = new Map<string, NativeMemoryNode>();
  // 先确定曾在可见范围的 ID，再取上界内最新 revision；不能先按状态/scope过滤而复活旧版本。
  const load = async (ids: readonly string[] | undefined) => {
    const rows = (
      await db.query<{ node: unknown }>(
        `WITH candidates AS (
      SELECT DISTINCT item->>'id' id FROM memory_native_publications p
      JOIN information_lifecycle l ON l.information_id=p.information_id
      CROSS JOIN LATERAL jsonb_array_elements(p.nodes) item
      WHERE l.position<=$1::bigint AND (($2::text[] IS NOT NULL AND item->>'id'=ANY($2::text[])) OR
        ($2::text[] IS NULL AND (item->'metadata'->>'scope'=$3 OR item->'metadata'->>'scope'='shared')))
    ) SELECT DISTINCT ON (item->>'id') item node FROM memory_native_publications p
      JOIN information_lifecycle l ON l.information_id=p.information_id
      CROSS JOIN LATERAL jsonb_array_elements(p.nodes) item
      WHERE l.position<=$1::bigint AND item->>'id' IN (SELECT id FROM candidates)
      ORDER BY item->>'id',l.position DESC LIMIT $4`,
        [
          upper,
          ids ?? null,
          selection.scope ?? null,
          selection.maxNodes === undefined ? null : selection.maxNodes + 1,
        ],
      )
    ).rows;
    if (selection.maxNodes !== undefined && rows.length > selection.maxNodes)
      throw new Error("inspection-memory-dependency-budget");
    for (const row of rows) {
      const n = nativeMemoryNodeSchema.parse(row.node);
      nodes.set(n.id, n);
    }
    if (selection.maxNodes !== undefined && nodes.size > selection.maxNodes)
      throw new Error("inspection-memory-dependency-budget");
  };
  await load(selection.ids);
  let edges: HistoricalEdge[] = [];
  for (;;) {
    if (!nodes.size) break;
    edges = (
      await db.query<{ edge: HistoricalEdge }>(
        `WITH operations AS (
      SELECT l.position,entry.edge,entry.added FROM memory_native_publications p
      JOIN information_atoms a ON a.information_id=p.information_id
      JOIN information_lifecycle l ON l.information_id=p.information_id
      CROSS JOIN LATERAL (
        SELECT value edge,true added FROM jsonb_array_elements(a.payload->'edges')
        UNION ALL SELECT value edge,false added FROM jsonb_array_elements(a.payload->'removeEdges')
      ) entry WHERE l.position<=$1::bigint AND
        (entry.edge->>'sourceId'=ANY($2::text[]) OR entry.edge->>'targetId'=ANY($2::text[]))
    ), latest AS (SELECT DISTINCT ON(edge->>'sourceId',edge->>'targetId',edge->>'relation') edge,added
      FROM operations ORDER BY edge->>'sourceId',edge->>'targetId',edge->>'relation',position DESC,added DESC)
    SELECT edge FROM latest WHERE added LIMIT $3`,
        [
          upper,
          [...nodes.keys()],
          selection.maxNodes === undefined ? null : selection.maxNodes * 4 + 1,
        ],
      )
    ).rows.map((r) => r.edge);
    if (
      selection.maxNodes !== undefined &&
      edges.length > selection.maxNodes * 4
    )
      throw new Error("inspection-memory-dependency-budget");
    const missing = [
      ...new Set(
        edges
          .filter(
            (e) =>
              nodes.has(e.sourceId) &&
              ["summarizes", "derived-from"].includes(e.relation) &&
              !nodes.has(e.targetId),
          )
          .map((e) => e.targetId),
      ),
    ];
    if (!missing.length) break;
    const count = nodes.size;
    await load(missing);
    if (nodes.size === count) break;
  }
  const proofs = new Map([...nodes].map(([id, n]) => [id, nodeProofOwners(n)]));
  const verified = new Map(
    [...nodes].map(([id, n]) => [id, [...(n.metadata.proofOwners ?? [])]]),
  );
  const missing = (n: NativeMemoryNode) =>
    n.metadata.sourceIds.filter(
      (id) => !verified.get(n.id)!.some((p) => p.sourceIds.includes(id)),
    );
  const persisted = await persistedSourceProofOwners(
    db,
    [...new Set([...nodes.values()].flatMap((n) => n.metadata.sourceIds))],
    upper,
  );
  const unproved = new Set<string>();
  for (const n of nodes.values()) {
    const ids = n.metadata.sourceIds;
    for (const [ownerId, sources] of persisted) {
      const sourceIds = ids.filter((id) => sources.has(id));
      if (sourceIds.length) {
        proofs.get(n.id)!.push({ ownerId, sourceIds });
        verified.get(n.id)!.push({ ownerId, sourceIds });
      }
    }
    if (missing(n).length) unproved.add(n.id);
  }
  const { withdrawn, identities } = await readMemoryInvalidations(
    db,
    upper,
    [...nodes.values()].flatMap((n) => [
      n.metadata.ownerId,
      ...proofs
        .get(n.id)!
        .filter((p) =>
          p.sourceIds.some((id) => n.metadata.sourceIds.includes(id)),
        )
        .map((p) => p.ownerId),
    ]),
    [...nodes.values()].flatMap((n) => n.metadata.sourceIds),
  );
  const invalid = new Set(
    [...nodes.values()]
      .filter(
        (n) =>
          unproved.has(n.id) ||
          n.metadata.sourceIds.some((id) => withdrawn.has(id)) ||
          identities.has(n.metadata.ownerId) ||
          proofs
            .get(n.id)!
            .some(
              (p) =>
                identities.has(p.ownerId) &&
                p.sourceIds.some((id) => n.metadata.sourceIds.includes(id)),
            ) ||
          n.metadata.status !== "active",
      )
      .map((n) => n.id),
  );
  const blocked = new Set(
    [...nodes.values()]
      .filter(
        (n) =>
          unproved.has(n.id) ||
          n.metadata.sourceIds.some((id) => withdrawn.has(id)) ||
          identities.has(n.metadata.ownerId) ||
          proofs
            .get(n.id)!
            .some(
              (p) =>
                identities.has(p.ownerId) &&
                p.sourceIds.some((id) => n.metadata.sourceIds.includes(id)),
            ),
      )
      .map((n) => n.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges)
      if (["summarizes", "derived-from"].includes(e.relation)) {
        if (invalid.has(e.targetId) && !invalid.has(e.sourceId)) {
          invalid.add(e.sourceId);
          changed = true;
        }
        if (blocked.has(e.targetId) && !blocked.has(e.sourceId)) {
          blocked.add(e.sourceId);
          changed = true;
        }
      }
  }
  return { nodes, edges, invalid, blocked, withdrawn, identities };
}
export function scopedNodes(
  view: MemoryView,
  input: MemoryReadContext,
  formation = false,
): NativeMemoryNode[] {
  return [...view.nodes.values()].filter(
    (n) =>
      (formation
        ? n.metadata.status !== "archived" && !view.blocked.has(n.id)
        : !view.invalid.has(n.id)) &&
      Date.parse(n.metadata.occurredAt) <= Date.parse(input.asOf) &&
      (n.metadata.scope === input.scope ||
        (n.metadata.scope === "shared" &&
          input.owners.includes(n.metadata.ownerId) &&
          ["person", "self", "expression"].includes(n.metadata.kind))),
  );
}
