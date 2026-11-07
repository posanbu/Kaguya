/**
 * 功能概述：为 native 发布和旧节点读取解析指定来源的身份依赖，不扫描无关来源。
 * 主要职责：sourceProofOwners 在发布事务内读取持久来源与原始消息绑定；persistedSourceProofOwners
 * 只投影来源 ID/owner，读取时受 publication 上界约束，返回 owner→source 映射。
 * 代码库关系：native-memory 的 publish/ingest 在提交锁内调用；native-memory-history 读取已保存的完整证明，
 * 不按当前绑定回填历史。原始入站消息支持首次摘要，投递来源核对实际成功回执及 request。
 * action-result 还校验 W3 intent/attempt/call/resultHash，不把任意 JSON owner 声明当作回执证明。
 * 输入输出与副作用：只读指定 sourceIds；保留已拆分身份的绑定，防止重新发布绕过失效；
 * 无法验证的来源不返回证明，由发布边界拒绝。无绑定入站消息属于其实际会话。
 */
import { canonicalMemorySourceId } from "@kaguya/memory";
import { actionDigest } from "./action-store.js";
import type { SqlTransaction } from "./driver.js";

/** 完整证明与旧 owner 依赖分开读取；旧 canonical 的单一 owner 不能填平证明缺口。 */
export async function persistedSourceProofOwners(
  db: SqlTransaction,
  sourceIds: string[],
  upper?: string,
  requireComplete = true,
) {
  const owners = new Map<string, Set<string>>();
  if (!sourceIds.length) return owners;
  const rows = await db.query<{
    id: string;
    owner: string;
    storage_id: string;
    canonical: boolean;
    owners: unknown;
    version: unknown;
    source_type: string | null;
    receipt_proof: any;
    memory_scope: string | null;
    receipt: any;
    intent: any;
  }>(
    `SELECT a.payload->'memorySource'->>'id' id,a.payload->'memorySource'->>'ownerId' owner,
      a.information_id storage_id,true canonical,a.payload->'sourceOwners' owners,a.payload->'sourceProofVersion' version,a.payload->'memorySource'->>'sourceType' source_type,a.payload->'receiptProof' receipt_proof,a.payload->'memorySource'->>'scope' memory_scope,receipt.payload receipt,h.input intent
      FROM information_atoms a JOIN information_lifecycle l USING(information_id)
      LEFT JOIN information_action_receipts ar ON ar.receipt_id=a.payload->'memorySource'->>'id'
      LEFT JOIN information_atoms receipt ON receipt.information_id=ar.receipt_id LEFT JOIN information_action_heads h ON h.intent_id=ar.intent_id
      WHERE a.information_id=ANY($1::text[]) AND a.kind='memory.native.source.v1'
        AND jsonb_typeof(a.payload->'memorySource'->'id')='string' AND jsonb_typeof(a.payload->'memorySource'->'ownerId')='string'
        AND ($3::bigint IS NULL OR l.position<=$3::bigint)
    UNION ALL SELECT source->>'id',source->>'ownerId',id,false,NULL::jsonb,NULL::jsonb,source->>'sourceType',NULL::jsonb,source->>'scope',NULL::jsonb,NULL::jsonb FROM memory_native_sources
      WHERE id=ANY($2::text[]) AND $3::bigint IS NULL AND NOT $4::boolean
        AND jsonb_typeof(source->'id')='string' AND jsonb_typeof(source->'ownerId')='string'`,
    [
      sourceIds.map(canonicalMemorySourceId),
      sourceIds,
      upper ?? null,
      requireComplete,
    ],
  );
  for (const row of rows.rows) {
    if (
      !sourceIds.includes(row.id) ||
      row.storage_id !==
        (row.canonical ? canonicalMemorySourceId(row.id) : row.id) ||
      typeof row.owner !== "string" ||
      !row.owner.trim()
    )
      continue;
    if (row.source_type === "action-result") {
      const p = row.receipt_proof,
        r = row.receipt;
      if (
        !row.canonical ||
        !r ||
        !p ||
        row.owner !== "self:kaguya" ||
        row.memory_scope !== r.intent?.scope ||
        p.intentId !== r.intentId ||
        p.attemptId !== r.attemptId ||
        p.toolCallId !== r.intent?.toolCallId ||
        p.resultHash !== r.resultHash ||
        actionDigest(r.intent) !== actionDigest(row.intent) ||
        r.resultHash !==
          actionDigest({
            result: r.outcome?.result,
            artifacts: r.outcome?.artifacts,
          })
      )
        continue;
    }
    const complete =
      row.version === 1 &&
      Array.isArray(row.owners) &&
      row.owners.length > 0 &&
      row.owners.every((o) => typeof o === "string" && o.trim().length > 0) &&
      row.owners.includes(row.owner);
    if (requireComplete && !complete) continue;
    const identities: string[] = complete
      ? (row.owners as string[])
      : [row.owner];
    for (const owner of identities) {
      if (!owners.has(owner)) owners.set(owner, new Set());
      owners.get(owner)!.add(row.id);
    }
  }
  return owners;
}

export async function sourceProofOwners(
  db: SqlTransaction,
  sourceIds: string[],
) {
  const owners = await persistedSourceProofOwners(db, sourceIds);
  const add = (owner: string, source: string) => {
    if (!owners.has(owner)) owners.set(owner, new Set());
    owners.get(owner)!.add(source);
  };
  if (!sourceIds.length) return owners;
  const normalized = new Set([...owners.values()].flatMap((ids) => [...ids]));
  const raw = await db.query<{
    information_id: string;
    payload: Record<string, any>;
    person_ids: string[];
  }>(
    `SELECT a.information_id,a.payload,ARRAY(
      SELECT DISTINCT b.payload->>'personInformationId' FROM information_atoms account
      JOIN information_references r ON r.target_information_id=account.information_id AND r.relation='core:binds'
      JOIN information_atoms b ON b.information_id=r.information_id
      WHERE account.kind='memory.identity.platform.account.entity' AND b.kind='memory.identity.platform.account.binding'
        AND account.payload->>'platform'=a.payload->'source'->>'platform'
        AND account.payload->>'adapterId'=a.payload->'source'->>'adapterId'
        AND account.payload->>'accountId'=a.payload->'source'->>'senderId'
        AND COALESCE(b.payload->>'personInformationId','')<>'') person_ids
    FROM information_atoms a WHERE a.information_id=ANY($1::text[]) AND a.kind='core.message.inbound.text'`,
    [sourceIds],
  );
  for (const { information_id: id, payload, person_ids } of raw.rows) {
    const address = payload.source,
      d = address?.destination;
    if (
      typeof payload.text !== "string" ||
      !payload.text.trim() ||
      typeof address?.platform !== "string" ||
      typeof address.adapterId !== "string" ||
      typeof address.senderId !== "string" ||
      !d ||
      typeof d.kind !== "string"
    )
      continue;
    // 正规来源也保留实际原文绑定；people() 会过滤拆分身份，不能用于证明归属。
    for (const person of person_ids) add(`person:${person}`, id);
    if (!normalized.has(id) && !person_ids.length) {
      add(
        address.sender?.isSelf || address.senderId === address.selfId
          ? "self:kaguya"
          : `conversation:${JSON.stringify([address.platform, address.adapterId, d.kind, d.userId ?? d.groupId ?? d.conversationId ?? null])}`,
        id,
      );
    }
  }
  // 成功投递可直接验证 request/status-of；其他旧证据种类必须已有完整证明。
  const delivered = await db.query<{ information_id: string }>(
    `SELECT a.information_id FROM information_atoms a
      JOIN information_references r ON r.information_id=a.information_id AND r.relation='core:status-of'
      JOIN information_atoms req ON req.information_id=r.target_information_id AND req.kind='core.delivery.requested'
      WHERE a.information_id=ANY($1::text[]) AND a.kind='core.delivery.delivered' AND a.payload->'ok'='true'::jsonb
        AND req.payload->'platform'=a.payload->'platform' AND req.payload->'adapterId'=a.payload->'adapterId'
        AND req.payload->'destination'=a.payload->'target' AND jsonb_typeof(req.payload->'message'->'text')='string'
        AND length(trim(req.payload->'message'->>'text'))>0`,
    [sourceIds],
  );
  for (const row of delivered.rows) add("self:kaguya", row.information_id);
  const verified = new Set([...owners.values()].flatMap((ids) => [...ids]));
  const legacy = await persistedSourceProofOwners(
    db,
    sourceIds,
    undefined,
    false,
  );
  for (const [owner, ids] of legacy)
    for (const id of ids) if (verified.has(id)) add(owner, id);
  return owners;
}
