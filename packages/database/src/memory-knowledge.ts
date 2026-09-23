/**
 * 人工记忆片段须逐字回指完整原文；召回只保留仍有有效断言的片段，修订后旧内容不会经事件旁路复活。
 * 功能概述：实现第一方事件—断言—实体 Wiki 的 PostgreSQL 基座，复用 Information ID，不产生第二套人物身份。
 * 主要职责：putEvent/appendClaim/putEpisode 校验账本与同范围证据并幂等追加；断言替代/撤回只允许同一陈述者视角；recall 冻结发生和记录时间，显式给出缺口；
 * writeWikiRevision 以 operationId 重放和版本 CAS 保存不可变修订；revokeSource 写来源 tombstone，invalidateEntity 幂等执行身份修订并标脏页面。
 * 代码库关系：memory/knowledge.ts 定义 capability 契约；memory-knowledge-schema.ts 建表；Runtime 和 first-party 模块负责原始事件生产与 Wiki 内容生成。
 * filterAvailableSourceIds 仅过滤原文 ID 可用性以保护 raw 旁路；listDirtyPages 用复合游标分页，坏页不会阻塞后续维护。
 * 输入输出与副作用：每个写事务先锁定 scope 行，跨进程竞争也遵循同一顺序；只返回指定范围，所有列表有界；数据库时间不能由调用方伪造。
 * 内部 assertEntities/readEvidence 阻止消息充当实体及派生摘要充当原始证据；pageFromRow 在 dirty 时隐藏正文，历史 revision 只供审计。
 */
import {
  KnowledgeConflictError,
  KnowledgeEvidenceError,
  knowledgeEventInputSchema,
  knowledgeClaimInputSchema,
  knowledgeEpisodeInputSchema,
  knowledgeRecallQuerySchema,
  wikiRevisionInputSchema,
  type MemoryKnowledgeAccess,
  type KnowledgeEventInput,
  type KnowledgeEvent,
  type KnowledgeClaimInput,
  type KnowledgeClaim,
  type KnowledgeRecallQuery,
  type KnowledgeRecallResult,
  type KnowledgeEpisodeInput,
  type KnowledgeEpisode,
  type WikiPage,
  type WikiRevisionInput,
  type WikiRevision,
  type EntityResolution,
  type KnowledgeCutoff,
} from "@kaguya/memory";
import type { SqlDatabase, SqlTransaction } from "./driver.js";
import {
  USER_MEMORY_SCOPE_KIND,
  WEB_MEMORY_SCOPE_ID,
  USER_STATEMENT_KIND,
  USER_INPUT_KIND,
  userStatementPayloadSchema,
} from "@kaguya/schema";

type EventRow = {
  input: KnowledgeEventInput;
  source_kind: string;
  recorded_at: Date | string;
  source_id: string;
};
type ClaimRow = {
  input: KnowledgeClaimInput;
  recorded_at: Date | string;
  claim_id: string;
};
type EpisodeRow = { input: KnowledgeEpisodeInput; recorded_at: Date | string };
type PageRow = {
  scope_id: string;
  entity_id: string;
  version: number;
  dirty_version: number;
  dirty: boolean;
  reasons: string[];
};
type RevisionRow = {
  input: WikiRevisionInput;
  recorded_at: Date | string;
  version: number;
};

export interface PostgresMemoryKnowledgeStoreOptions {
  /** 通用非聊天 scope 必须是显式批准的已有实体 kind。聊天 scope 始终校验 canonical payload。 */
  readonly scopeKinds?: readonly string[];
}
export class PostgresMemoryKnowledgeStore implements MemoryKnowledgeAccess {
  private readonly scopeKinds: readonly string[];
  constructor(
    private readonly database: SqlDatabase,
    options: PostgresMemoryKnowledgeStoreOptions = {},
  ) {
    this.scopeKinds = options.scopeKinds ?? [
      "device.entity",
      USER_MEMORY_SCOPE_KIND,
    ];
  }
  private lockScope(tx: SqlTransaction, scopeId: string): Promise<void> {
    return lockScope(tx, scopeId, this.scopeKinds);
  }

  async putEvent(
    input: KnowledgeEventInput,
  ): Promise<{ event: KnowledgeEvent; created: boolean }> {
    const parsed = knowledgeEventInputSchema.parse(input);
    parsed.occurredAt = iso(parsed.occurredAt);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, parsed.scopeInformationId);
      const existing = await tx.query<EventRow>(
        "SELECT * FROM memory_knowledge_events WHERE source_id = $1",
        [parsed.sourceInformationId],
      );
      if (existing.rows[0]) {
        if (!same(existing.rows[0].input, parsed))
          throw new KnowledgeConflictError();
        return { event: eventFromRow(existing.rows[0]), created: false };
      }
      const revoked = await tx.query(
        "SELECT source_id FROM memory_knowledge_revocations WHERE source_id=$1 AND scope_id=$2",
        [parsed.sourceInformationId, parsed.scopeInformationId],
      );
      if (revoked.rows.length) throw new KnowledgeEvidenceError();
      const source = await tx.query<{
        kind: string;
        occurred_at: string;
        is_future: boolean;
        payload: Record<string, unknown>;
      }>(
        "SELECT kind, payload, occurred_at, occurred_at::timestamptz > clock_timestamp() AS is_future FROM information_atoms WHERE information_id = $1",
        [parsed.sourceInformationId],
      );
      const atom = source.rows[0];
      if (
        !atom ||
        atom.is_future ||
        Date.parse(atom.occurred_at) !== Date.parse(parsed.occurredAt) ||
        isDerivedKind(atom.kind)
      )
        throw new KnowledgeEvidenceError();
      if (atom.kind === "core.message.inbound.text") {
        const scope = await tx.query<{
          payload: Record<string, unknown>;
          kind: string;
        }>(
          "SELECT kind,payload FROM information_atoms WHERE information_id=$1",
          [parsed.scopeInformationId],
        );
        const address = atom.payload.source;
        if (
          !isRecord(address) ||
          atom.payload.text !== parsed.content ||
          scope.rows[0]?.kind !== "agent.chat.scope.entity" ||
          !sameNativeScope(address, scope.rows[0].payload)
        )
          throw new KnowledgeEvidenceError();
      }
      if (atom.kind === USER_STATEMENT_KIND) {
        const payload = userStatementPayloadSchema.safeParse(atom.payload);
        if (
          !payload.success ||
          payload.data.text !== parsed.content ||
          payload.data.scopeInformationId !== parsed.scopeInformationId
        )
          throw new KnowledgeEvidenceError();
        const scope = await tx.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1",
          [parsed.scopeInformationId],
        );
        if (
          !scope.rows[0] ||
          !sameNativeScope(payload.data.scope, scope.rows[0].payload)
        )
          throw new KnowledgeEvidenceError();
        const original = await tx.query<{ kind: string; payload: unknown }>(
          "SELECT a.kind,a.payload FROM information_atoms a JOIN information_references r ON r.target_information_id=a.information_id WHERE r.information_id=$1 AND r.relation='agent:source' AND a.information_id=$2",
          [
            parsed.sourceInformationId,
            payload.data.originalSourceInformationId ?? null,
          ],
        );
        const originalPayload = userStatementPayloadSchema.safeParse(
          original.rows[0]?.payload,
        );
        if (
          original.rows[0]?.kind !== USER_INPUT_KIND ||
          !originalPayload.success ||
          originalPayload.data.scopeInformationId !==
            parsed.scopeInformationId ||
          originalPayload.data.requestId !== payload.data.requestId ||
          originalPayload.data.sourceType !== payload.data.sourceType ||
          !originalPayload.data.text.includes(payload.data.text)
        )
          throw new KnowledgeEvidenceError();
      }
      await assertEventActorAndScope(tx, parsed, atom.kind);
      const resolutions = [parsed.actor, ...parsed.subjects];
      await assertEntities(tx, [
        parsed.scopeInformationId,
        ...resolutions.flatMap(entityCandidates),
      ]);
      if (parsed.replyTo?.sourceInformationId)
        await readEvidence(tx, parsed.scopeInformationId, [
          parsed.replyTo.sourceInformationId,
        ]);
      const result = await tx.query<EventRow>(
        "INSERT INTO memory_knowledge_events(source_id, scope_id, source_kind, occurred_at, input) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *",
        [
          parsed.sourceInformationId,
          parsed.scopeInformationId,
          atom.kind,
          parsed.occurredAt,
          JSON.stringify(parsed),
        ],
      );
      const entities = unique([
        parsed.scopeInformationId,
        ...resolutions.flatMap((r) =>
          r.status === "resolved" ? [r.entityInformationId] : [],
        ),
      ]);
      await tx.query(
        "INSERT INTO memory_knowledge_event_entities(source_id,entity_id) SELECT $1, unnest($2::text[])",
        [parsed.sourceInformationId, entities],
      );
      await dirtyPages(tx, parsed.scopeInformationId, entities, "event_added");
      return { event: eventFromRow(result.rows[0]!), created: true };
    });
  }

  async filterAvailableSourceIds(input: {
    scopeInformationId?: string;
    sourceInformationIds: readonly string[];
  }): Promise<readonly string[]> {
    if (input.scopeInformationId !== undefined)
      assertId(input.scopeInformationId);
    if (
      !Array.isArray(input.sourceInformationIds) ||
      input.sourceInformationIds.length > 100
    )
      throw new KnowledgeEvidenceError();
    for (const id of input.sourceInformationIds) assertId(id);
    if (!input.sourceInformationIds.length) return [];
    const result = await this.database.query<{ information_id: string }>(
      `SELECT a.information_id FROM information_atoms a
      LEFT JOIN memory_knowledge_events e ON e.source_id=a.information_id
      WHERE a.information_id=ANY($2::text[])
        AND (e.source_id IS NULL OR (($1::text IS NULL OR e.scope_id=$1) AND e.revoked_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM memory_knowledge_revocations r WHERE r.source_id=a.information_id)`,
      [input.scopeInformationId ?? null, unique(input.sourceInformationIds)],
    );
    const available = new Set(result.rows.map((r) => r.information_id));
    return unique(input.sourceInformationIds).filter((id) => available.has(id));
  }

  async getEvent(
    sourceInformationId: string,
    scopeInformationId: string,
  ): Promise<KnowledgeEvent | undefined> {
    assertId(sourceInformationId);
    assertId(scopeInformationId);
    const result = await this.database.query<EventRow>(
      "SELECT * FROM memory_knowledge_events WHERE source_id=$1 AND scope_id=$2 AND revoked_at IS NULL",
      [sourceInformationId, scopeInformationId],
    );
    return result.rows[0] ? eventFromRow(result.rows[0]) : undefined;
  }

  async appendClaim(
    input: KnowledgeClaimInput,
  ): Promise<{ claim: KnowledgeClaim; created: boolean }> {
    const parsed = knowledgeClaimInputSchema.parse(input);
    parsed.validFrom = iso(parsed.validFrom);
    if (parsed.validTo) parsed.validTo = iso(parsed.validTo);
    assertUnique(parsed.evidenceSourceInformationIds);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, parsed.scopeInformationId);
      const existing = await tx.query<ClaimRow>(
        "SELECT * FROM memory_knowledge_claims WHERE claim_id=$1",
        [parsed.claimId],
      );
      if (existing.rows[0]) {
        if (!same(existing.rows[0].input, parsed))
          throw new KnowledgeConflictError();
        return { claim: claimFromRow(existing.rows[0]), created: false };
      }
      await assertEntities(tx, [
        parsed.subjectInformationId,
        ...(parsed.speakerInformationId ? [parsed.speakerInformationId] : []),
      ]);
      await readEvidence(
        tx,
        parsed.scopeInformationId,
        parsed.evidenceSourceInformationIds,
      );
      const targetId = parsed.supersedesClaimId ?? parsed.retractsClaimId;
      if (targetId) {
        const target = await tx.query<ClaimRow>(
          "SELECT * FROM memory_knowledge_claims WHERE claim_id=$1 AND scope_id=$2",
          [targetId, parsed.scopeInformationId],
        );
        if (
          !target.rows[0] ||
          target.rows[0].input.subjectInformationId !==
            parsed.subjectInformationId ||
          target.rows[0].input.predicate !== parsed.predicate ||
          target.rows[0].input.speakerInformationId !==
            parsed.speakerInformationId ||
          Date.parse(parsed.validFrom) <
            Date.parse(target.rows[0].input.validFrom)
        )
          throw new KnowledgeEvidenceError();
      }
      const result = await tx.query<ClaimRow>(
        "INSERT INTO memory_knowledge_claims(claim_id,scope_id,subject_id,speaker_id,valid_from,valid_to,supersedes_id,retracts_id,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *",
        [
          parsed.claimId,
          parsed.scopeInformationId,
          parsed.subjectInformationId,
          parsed.speakerInformationId ?? null,
          parsed.validFrom,
          parsed.validTo ?? null,
          parsed.supersedesClaimId ?? null,
          parsed.retractsClaimId ?? null,
          JSON.stringify(parsed),
        ],
      );
      await tx.query(
        "INSERT INTO memory_knowledge_claim_evidence(claim_id,source_id) SELECT $1,unnest($2::text[])",
        [parsed.claimId, parsed.evidenceSourceInformationIds],
      );
      await dirtyPages(
        tx,
        parsed.scopeInformationId,
        unique([parsed.scopeInformationId, parsed.subjectInformationId]),
        targetId ? "claim_revised" : "claim_added",
      );
      // Wiki 也可能在另一实体章节引用同一断言，因此撤回/替代令整个 scope 的缓存失效。
      if (targetId)
        await dirtyScope(tx, parsed.scopeInformationId, "claim_revised");
      return { claim: claimFromRow(result.rows[0]!), created: true };
    });
  }

  async putEpisode(
    input: KnowledgeEpisodeInput,
  ): Promise<{ episode: KnowledgeEpisode; created: boolean }> {
    const parsed = knowledgeEpisodeInputSchema.parse(input);
    assertUnique(parsed.evidenceSourceInformationIds);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, parsed.scopeInformationId);
      const existing = await tx.query<EpisodeRow>(
        "SELECT * FROM memory_knowledge_episodes WHERE episode_id=$1",
        [parsed.episodeId],
      );
      if (existing.rows[0]) {
        if (!same(existing.rows[0].input, parsed))
          throw new KnowledgeConflictError();
        return { episode: episodeFromRow(existing.rows[0]), created: false };
      }
      await readEvidence(
        tx,
        parsed.scopeInformationId,
        parsed.evidenceSourceInformationIds,
      );
      const result = await tx.query<EpisodeRow>(
        "INSERT INTO memory_knowledge_episodes(episode_id,scope_id,input) VALUES($1,$2,$3::jsonb) RETURNING *",
        [parsed.episodeId, parsed.scopeInformationId, JSON.stringify(parsed)],
      );
      return { episode: episodeFromRow(result.rows[0]!), created: true };
    });
  }

  async recall(input: KnowledgeRecallQuery): Promise<KnowledgeRecallResult> {
    const parsed = knowledgeRecallQuerySchema.parse(input);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, parsed.scopeInformationId);
      const values = [
        parsed.scopeInformationId,
        parsed.occurredBefore,
        parsed.recordedBefore,
        parsed.entityInformationId ?? null,
        parsed.query ?? "",
        parsed.limit + 1,
      ];
      const events = await tx.query<EventRow>(
        `
        SELECT e.* FROM memory_knowledge_events e
        WHERE e.scope_id=$1 AND e.occurred_at <= $2::timestamptz AND e.recorded_at <= $3::timestamptz AND e.revoked_at IS NULL
          AND (e.source_kind <> 'agent.user.statement' OR EXISTS(
            SELECT 1 FROM memory_knowledge_claim_evidence ce JOIN memory_knowledge_claims c ON c.claim_id=ce.claim_id
            WHERE ce.source_id=e.source_id AND c.scope_id=e.scope_id AND c.invalidated_at IS NULL AND c.retracts_id IS NULL
              AND c.valid_from <= $2::timestamptz AND (c.valid_to IS NULL OR c.valid_to >= $2::timestamptz) AND c.recorded_at <= $3::timestamptz
              AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claims n WHERE (n.supersedes_id=c.claim_id OR n.retracts_id=c.claim_id) AND n.recorded_at <= $3::timestamptz AND n.valid_from <= $2::timestamptz)))
          AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM memory_knowledge_event_entities p WHERE p.source_id=e.source_id AND p.entity_id=$4))
          AND ($5::text = '' OR strpos(lower(e.input->>'content'),lower($5))>0)
        ORDER BY e.occurred_at DESC, e.source_id ASC LIMIT $6`,
        values,
      );
      const claims = await tx.query<ClaimRow>(
        `
        SELECT c.* FROM memory_knowledge_claims c
        WHERE c.scope_id=$1 AND c.valid_from <= $2::timestamptz AND (c.valid_to IS NULL OR c.valid_to >= $2::timestamptz)
          AND c.recorded_at <= $3::timestamptz AND c.invalidated_at IS NULL AND c.retracts_id IS NULL
          AND ($4::text IS NULL OR c.subject_id=$4)
          AND ($5::text = '' OR strpos(lower((c.input->>'predicate') || ' ' || (c.input->>'value')),lower($5))>0)
          AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claims n WHERE n.scope_id=c.scope_id AND (n.supersedes_id=c.claim_id OR n.retracts_id=c.claim_id)
            AND n.recorded_at <= $3::timestamptz AND n.valid_from <= $2::timestamptz)
          AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claim_evidence ce JOIN memory_knowledge_events e ON e.source_id=ce.source_id
            WHERE ce.claim_id=c.claim_id AND (e.scope_id<>$1 OR e.revoked_at IS NOT NULL OR e.occurred_at>$2::timestamptz OR e.recorded_at>$3::timestamptz))
        ORDER BY (c.input->>'predicate' = 'stated') ASC,c.valid_from DESC,c.claim_id ASC LIMIT $6`,
        values,
      );
      // 持久断言优先占用完整证据闭包，近期闲聊只能使用剩余预算。
      const selectedClaims: KnowledgeClaim[] = [];
      const selectedEvidence = new Set<string>();
      let evidenceBudgetExceeded = false;
      for (const row of claims.rows.slice(0, parsed.limit)) {
        const candidate = claimFromRow(row);
        const additional = candidate.evidenceSourceInformationIds.filter(
          (id) => !selectedEvidence.has(id),
        );
        if (selectedEvidence.size + additional.length > parsed.limit) {
          evidenceBudgetExceeded = true;
          continue;
        }
        selectedClaims.push(candidate);
        for (const id of additional) selectedEvidence.add(id);
      }
      for (const row of events.rows.slice(0, parsed.limit)) {
        if (selectedEvidence.has(row.source_id)) continue;
        if (selectedEvidence.size >= parsed.limit) {
          evidenceBudgetExceeded = true;
          continue;
        }
        selectedEvidence.add(row.source_id);
      }
      const evidenceIds = [...selectedEvidence];
      const closure = evidenceIds.length
        ? await readEvidence(tx, parsed.scopeInformationId, evidenceIds, parsed)
        : [];
      const reasons: string[] = [
        "scope_isolated",
        "event_and_recording_cutoff",
        "raw_evidence_closure",
        "claims_before_recent_events",
      ];
      const missing: string[] = [];
      if (!closure.length) missing.push("no_evidence_before_cutoff");
      if (
        closure.some(
          (e) =>
            e.actor.status !== "resolved" ||
            e.subjects.some((r) => r.status !== "resolved"),
        )
      )
        missing.push("unresolved_identity");
      const conflicting = new Map<string, Set<string>>();
      for (const claim of selectedClaims) {
        const key = JSON.stringify([
          claim.subjectInformationId,
          claim.predicate,
        ]);
        const values = conflicting.get(key) ?? new Set<string>();
        values.add(claim.value);
        conflicting.set(key, values);
      }
      if ([...conflicting.values()].some((values) => values.size > 1))
        reasons.push("conflicting_claims_preserved");
      const truncated =
        evidenceBudgetExceeded ||
        events.rows.length > parsed.limit ||
        claims.rows.length > parsed.limit;
      if (truncated) missing.push("result_limit_reached");
      return {
        events: closure,
        claims: selectedClaims,
        evidenceSourceInformationIds: evidenceIds,
        reasons,
        missing,
        truncated,
      };
    });
  }

  async listDirtyPages(input: {
    limit: number;
    after?: { scopeInformationId: string; entityInformationId: string };
  }): Promise<readonly WikiPage[]> {
    assertLimit(input.limit);
    if (input.after) {
      assertId(input.after.scopeInformationId);
      assertId(input.after.entityInformationId);
    }
    const result = await this.database.query<PageRow>(
      "SELECT * FROM memory_knowledge_wiki_pages WHERE dirty AND ($2::text IS NULL OR (scope_id,entity_id)>($2,$3)) ORDER BY scope_id,entity_id LIMIT $1",
      [
        input.limit,
        input.after?.scopeInformationId ?? null,
        input.after?.entityInformationId ?? null,
      ],
    );
    return result.rows.map(pageFromRow);
  }

  async readWikiPage(input: {
    scopeInformationId: string;
    entityInformationId: string;
  }): Promise<WikiPage | undefined> {
    assertId(input.scopeInformationId);
    assertId(input.entityInformationId);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, input.scopeInformationId);
      const result = await tx.query<PageRow>(
        "SELECT * FROM memory_knowledge_wiki_pages WHERE scope_id=$1 AND entity_id=$2",
        [input.scopeInformationId, input.entityInformationId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const page = pageFromRow(row);
      if (row.dirty || !row.version) return page;
      const revision = await tx.query<RevisionRow>(
        "SELECT * FROM memory_knowledge_wiki_revisions WHERE scope_id=$1 AND entity_id=$2 AND version=$3",
        [input.scopeInformationId, input.entityInformationId, row.version],
      );
      return revision.rows[0]
        ? { ...page, latestRevision: revisionFromRow(revision.rows[0]) }
        : page;
    });
  }

  async writeWikiRevision(input: WikiRevisionInput): Promise<WikiRevision> {
    const parsed = wikiRevisionInputSchema.parse(input);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, parsed.scopeInformationId);
      const existing = await tx.query<RevisionRow>(
        "SELECT * FROM memory_knowledge_wiki_revisions WHERE scope_id=$1 AND entity_id=$2 AND operation_id=$3",
        [
          parsed.scopeInformationId,
          parsed.entityInformationId,
          parsed.operationId,
        ],
      );
      if (existing.rows[0]) {
        if (!same(existing.rows[0].input, parsed))
          throw new KnowledgeConflictError();
        return revisionFromRow(existing.rows[0]);
      }
      await assertEntities(tx, [parsed.entityInformationId]);
      const page = await tx.query<PageRow>(
        "SELECT * FROM memory_knowledge_wiki_pages WHERE scope_id=$1 AND entity_id=$2",
        [parsed.scopeInformationId, parsed.entityInformationId],
      );
      const current = page.rows[0];
      if (
        !current ||
        current.version !== parsed.expectedVersion ||
        current.dirty_version !== parsed.expectedDirtyVersion
      )
        throw new KnowledgeConflictError();
      for (const section of parsed.sections) {
        assertUnique(section.evidenceSourceInformationIds);
        assertUnique(section.claimIds);
        await readEvidence(
          tx,
          parsed.scopeInformationId,
          section.evidenceSourceInformationIds,
          parsed.evidenceCutoff,
        );
        if (section.claimIds.length) {
          const claims = await tx.query<ClaimRow>(
            `SELECT c.* FROM memory_knowledge_claims c WHERE claim_id=ANY($1::text[]) AND scope_id=$2
            AND recorded_at <= $3::timestamptz AND valid_from <= $4::timestamptz AND (valid_to IS NULL OR valid_to >= $4::timestamptz)
            AND invalidated_at IS NULL AND retracts_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM memory_knowledge_claims n WHERE n.scope_id=c.scope_id AND (n.supersedes_id=c.claim_id OR n.retracts_id=c.claim_id)
              AND n.recorded_at <= $3::timestamptz AND n.valid_from <= $4::timestamptz)`,
            [
              section.claimIds,
              parsed.scopeInformationId,
              parsed.evidenceCutoff.recordedBefore,
              parsed.evidenceCutoff.occurredBefore,
            ],
          );
          if (
            claims.rows.length !== section.claimIds.length ||
            claims.rows.some((r) =>
              r.input.evidenceSourceInformationIds.some(
                (id) => !section.evidenceSourceInformationIds.includes(id),
              ),
            )
          )
            throw new KnowledgeEvidenceError();
        }
      }
      const result = await tx.query<RevisionRow>(
        "INSERT INTO memory_knowledge_wiki_revisions(scope_id,entity_id,version,operation_id,input) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *",
        [
          parsed.scopeInformationId,
          parsed.entityInformationId,
          current.version + 1,
          parsed.operationId,
          JSON.stringify(parsed),
        ],
      );
      // 历史 cutoff 或晚到事件不能被新版本错误地清除 dirty；无需扫描正文即可验证水位。
      const pending = await tx.query<{ pending: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM memory_knowledge_events e JOIN memory_knowledge_event_entities p ON p.source_id=e.source_id
        WHERE e.scope_id=$1 AND p.entity_id=$2 AND e.revoked_at IS NULL AND (e.occurred_at>$3::timestamptz OR e.recorded_at>$4::timestamptz))
        OR EXISTS(SELECT 1 FROM memory_knowledge_claims c WHERE c.scope_id=$1 AND (c.subject_id=$2 OR $1=$2) AND c.invalidated_at IS NULL
          AND (c.valid_from>$3::timestamptz OR c.recorded_at>$4::timestamptz)) AS pending`,
        [
          parsed.scopeInformationId,
          parsed.entityInformationId,
          parsed.evidenceCutoff.occurredBefore,
          parsed.evidenceCutoff.recordedBefore,
        ],
      );
      const dirty = pending.rows[0]?.pending ?? false;
      await tx.query(
        "UPDATE memory_knowledge_wiki_pages SET version=$3,dirty=$4,reasons=$5::jsonb WHERE scope_id=$1 AND entity_id=$2",
        [
          parsed.scopeInformationId,
          parsed.entityInformationId,
          current.version + 1,
          dirty,
          JSON.stringify(dirty ? ["evidence_after_cutoff"] : []),
        ],
      );
      return revisionFromRow(result.rows[0]!);
    });
  }

  async listWikiRevisions(input: {
    scopeInformationId: string;
    entityInformationId: string;
    limit: number;
    beforeVersion?: number;
  }): Promise<readonly WikiRevision[]> {
    assertId(input.scopeInformationId);
    assertId(input.entityInformationId);
    assertLimit(input.limit);
    if (
      input.beforeVersion !== undefined &&
      (!Number.isSafeInteger(input.beforeVersion) || input.beforeVersion < 1)
    )
      throw new KnowledgeEvidenceError();
    const result = await this.database.query<RevisionRow>(
      "SELECT * FROM memory_knowledge_wiki_revisions WHERE scope_id=$1 AND entity_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4",
      [
        input.scopeInformationId,
        input.entityInformationId,
        input.beforeVersion ?? null,
        input.limit,
      ],
    );
    return result.rows.map(revisionFromRow);
  }

  async revokeSource(input: {
    scopeInformationId: string;
    sourceInformationId: string;
    reason: string;
  }): Promise<void> {
    assertId(input.scopeInformationId);
    assertId(input.sourceInformationId);
    assertReason(input.reason);
    await this.database.transaction(async (tx) => {
      await this.lockScope(tx, input.scopeInformationId);
      const source = await tx.query<{
        kind: string;
        payload: Record<string, unknown>;
      }>("SELECT kind,payload FROM information_atoms WHERE information_id=$1", [
        input.sourceInformationId,
      ]);
      if (!source.rows[0]) throw new KnowledgeEvidenceError();
      if (source.rows[0].kind === "core.message.inbound.text") {
        const scope = await tx.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1",
          [input.scopeInformationId],
        );
        if (
          !isRecord(source.rows[0].payload.source) ||
          !sameNativeScope(
            source.rows[0].payload.source,
            scope.rows[0]!.payload,
          )
        )
          return;
      } else {
        const scopeRef = await tx.query(
          "SELECT 1 FROM information_references WHERE information_id=$1 AND relation='agent:scope' AND target_information_id=$2",
          [input.sourceInformationId, input.scopeInformationId],
        );
        if (!scopeRef.rows.length) throw new KnowledgeEvidenceError();
      }
      const tombstone = await tx.query(
        "INSERT INTO memory_knowledge_revocations(source_id,scope_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING source_id",
        [input.sourceInformationId, input.scopeInformationId, input.reason],
      );
      await tx.query(
        "UPDATE memory_knowledge_events SET revoked_at=clock_timestamp(),revoke_reason=$3 WHERE source_id=$1 AND scope_id=$2 AND revoked_at IS NULL",
        [input.sourceInformationId, input.scopeInformationId, input.reason],
      );
      if (tombstone.rows.length)
        await dirtyScope(tx, input.scopeInformationId, "source_revoked");
    });
  }

  async invalidateEntity(input: {
    operationId: string;
    scopeInformationId: string;
    entityInformationId: string;
    reason: string;
  }): Promise<void> {
    assertId(input.operationId);
    assertId(input.scopeInformationId);
    assertId(input.entityInformationId);
    assertReason(input.reason);
    await this.database.transaction(async (tx) => {
      await this.lockScope(tx, input.scopeInformationId);
      const prior = await tx.query<{ input: unknown }>(
        "SELECT input FROM memory_knowledge_mutations WHERE scope_id=$1 AND operation_id=$2",
        [input.scopeInformationId, input.operationId],
      );
      if (prior.rows[0]) {
        if (!same(prior.rows[0].input, input))
          throw new KnowledgeConflictError();
        return;
      }
      await assertEntities(tx, [input.entityInformationId]);
      await tx.query(
        "INSERT INTO memory_knowledge_mutations(scope_id,operation_id,input) VALUES($1,$2,$3::jsonb)",
        [input.scopeInformationId, input.operationId, JSON.stringify(input)],
      );
      // 已绑定旧身份的事件不再为实体推论提供证据；原始账本仍可独立审计并以新来源修订。
      await tx.query(
        `UPDATE memory_knowledge_events e SET revoked_at=clock_timestamp(),revoke_reason=$3
        WHERE e.scope_id=$1 AND e.revoked_at IS NULL AND EXISTS(SELECT 1 FROM memory_knowledge_event_entities p WHERE p.source_id=e.source_id AND p.entity_id=$2)`,
        [input.scopeInformationId, input.entityInformationId, input.reason],
      );
      await tx.query(
        "UPDATE memory_knowledge_claims SET invalidated_at=clock_timestamp() WHERE scope_id=$1 AND (subject_id=$2 OR speaker_id=$2) AND invalidated_at IS NULL",
        [input.scopeInformationId, input.entityInformationId],
      );
      await dirtyScope(tx, input.scopeInformationId, "identity_revised");
    });
  }
}

async function lockScope(
  tx: SqlTransaction,
  scopeId: string,
  scopeKinds: readonly string[],
): Promise<void> {
  assertId(scopeId);
  const result = await tx.query<{
    kind: string;
    payload: Record<string, unknown>;
  }>("SELECT kind,payload FROM information_atoms WHERE information_id=$1", [
    scopeId,
  ]);
  const scope = result.rows[0];
  if (
    !scope ||
    !scope.kind.endsWith(".entity") ||
    (scope.kind === "agent.chat.scope.entity"
      ? scope.payload.scopeMode !== "canonical"
      : !scopeKinds.includes(scope.kind)) ||
    (scope?.kind === USER_MEMORY_SCOPE_KIND &&
      (scopeId !== WEB_MEMORY_SCOPE_ID ||
        scope.payload.platform !== "web" ||
        scope.payload.adapterId !== "web.ui.main" ||
        !same(scope.payload.destination, { kind: "web" })))
  )
    throw new KnowledgeEvidenceError();
  await tx.query(
    "INSERT INTO memory_knowledge_scopes(scope_id) VALUES($1) ON CONFLICT DO NOTHING",
    [scopeId],
  );
  await tx.query(
    "SELECT scope_id FROM memory_knowledge_scopes WHERE scope_id=$1 FOR UPDATE",
    [scopeId],
  );
}
async function assertEntities(
  tx: SqlTransaction,
  ids: readonly string[],
): Promise<void> {
  const wanted = unique(ids);
  const result = await tx.query<{ information_id: string; kind: string }>(
    "SELECT information_id,kind FROM information_atoms WHERE information_id=ANY($1::text[])",
    [wanted],
  );
  if (
    result.rows.length !== wanted.length ||
    result.rows.some((r) => !r.kind.endsWith(".entity"))
  )
    throw new KnowledgeEvidenceError();
}
async function readEvidence(
  tx: SqlTransaction,
  scopeId: string,
  sourceIds: readonly string[],
  cutoff?: KnowledgeCutoff,
): Promise<KnowledgeEvent[]> {
  const ids = unique(sourceIds);
  const result = await tx.query<EventRow>(
    `SELECT * FROM memory_knowledge_events WHERE scope_id=$1 AND source_id=ANY($2::text[]) AND revoked_at IS NULL
    AND ($3::timestamptz IS NULL OR occurred_at <= $3::timestamptz) AND ($4::timestamptz IS NULL OR recorded_at <= $4::timestamptz)
    ORDER BY occurred_at DESC,source_id ASC`,
    [
      scopeId,
      ids,
      cutoff?.occurredBefore ?? null,
      cutoff?.recordedBefore ?? null,
    ],
  );
  if (result.rows.length !== ids.length) throw new KnowledgeEvidenceError();
  return result.rows.map(eventFromRow);
}
async function dirtyPages(
  tx: SqlTransaction,
  scopeId: string,
  entityIds: readonly string[],
  reason: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO memory_knowledge_wiki_pages(scope_id,entity_id,dirty_version,reasons)
    SELECT $1,unnest($2::text[]),1,$3::jsonb ON CONFLICT(scope_id,entity_id)
    DO UPDATE SET dirty=true,dirty_version=memory_knowledge_wiki_pages.dirty_version+1,reasons=$3::jsonb`,
    [scopeId, entityIds, JSON.stringify([reason])],
  );
}
async function dirtyScope(
  tx: SqlTransaction,
  scopeId: string,
  reason: string,
): Promise<void> {
  await tx.query(
    "UPDATE memory_knowledge_wiki_pages SET dirty=true,dirty_version=dirty_version+1,reasons=$2::jsonb WHERE scope_id=$1",
    [scopeId, JSON.stringify([reason])],
  );
}
function eventFromRow(row: EventRow): KnowledgeEvent {
  return {
    ...row.input,
    sourceKind: row.source_kind,
    recordedAt: iso(row.recorded_at),
  };
}
function claimFromRow(row: ClaimRow): KnowledgeClaim {
  return { ...row.input, recordedAt: iso(row.recorded_at) };
}
function episodeFromRow(row: EpisodeRow): KnowledgeEpisode {
  return { ...row.input, recordedAt: iso(row.recorded_at) };
}
function pageFromRow(row: PageRow): WikiPage {
  return {
    scopeInformationId: row.scope_id,
    entityInformationId: row.entity_id,
    version: row.version,
    dirtyVersion: row.dirty_version,
    dirty: row.dirty,
    reasons: row.reasons,
  };
}
function revisionFromRow(row: RevisionRow): WikiRevision {
  const {
    expectedVersion: _version,
    expectedDirtyVersion: _dirty,
    ...input
  } = row.input;
  return { ...input, version: row.version, recordedAt: iso(row.recorded_at) };
}
function entityCandidates(value: EntityResolution): string[] {
  return value.status === "resolved"
    ? [value.entityInformationId]
    : value.status === "ambiguous"
      ? value.candidateInformationIds
      : [];
}
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
function assertUnique(ids: readonly string[]): void {
  if (unique(ids).length !== ids.length) throw new KnowledgeEvidenceError();
}
function assertId(id: string): void {
  if (typeof id !== "string" || !id.trim() || id.length > 512)
    throw new KnowledgeEvidenceError();
}
function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new KnowledgeEvidenceError();
}
function assertReason(reason: string): void {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 256)
    throw new KnowledgeEvidenceError();
}
function isDerivedKind(kind: string): boolean {
  return /(?:^|\.)(?:memory|wiki|claim|summary|cognition)(?:\.|$)/u.test(kind);
}
function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameNativeScope(
  address: Record<string, unknown>,
  scope: Record<string, unknown>,
): boolean {
  return (
    typeof address.platform === "string" &&
    !!address.platform &&
    typeof address.adapterId === "string" &&
    !!address.adapterId &&
    address.platform === scope.platform &&
    address.adapterId === scope.adapterId &&
    isRecord(address.destination) &&
    same(address.destination, scope.destination)
  );
}

/** 原始消息以可靠 Identity 终态证明说话者；通用生产者必须在原子本身声明范围与 actor 来源。 */
async function assertEventActorAndScope(
  tx: SqlTransaction,
  input: KnowledgeEventInput,
  sourceKind: string,
): Promise<void> {
  if (sourceKind === "core.message.inbound.text") {
    if (input.actor.status !== "resolved") return;
    const result = await tx.query<{ valid: boolean }>(
      `SELECT EXISTS(
      SELECT 1 FROM information_references r JOIN information_atoms a ON a.information_id=r.information_id
      WHERE r.target_information_id=$1 AND r.relation='core:status-of' AND a.kind='agent.person.context.completed'
        AND a.payload->>'scopeMode'='canonical' AND a.payload->>'status'='complete'
        AND a.payload->>'scopeInformationId'=$2 AND a.payload->>'personInformationId'=$3
    ) AS valid`,
      [
        input.sourceInformationId,
        input.scopeInformationId,
        input.actor.entityInformationId,
      ],
    );
    if (!result.rows[0]?.valid) throw new KnowledgeEvidenceError();
    return;
  }
  const refs = await tx.query<{
    relation: string;
    target_information_id: string;
  }>(
    "SELECT relation,target_information_id FROM information_references WHERE information_id=$1 AND relation=ANY($2::text[])",
    [input.sourceInformationId, ["agent:scope", "agent:actor"]],
  );
  if (
    !refs.rows.some(
      (r) =>
        r.relation === "agent:scope" &&
        r.target_information_id === input.scopeInformationId,
    )
  )
    throw new KnowledgeEvidenceError();
  if (input.actor.status === "resolved") {
    const actorId = input.actor.entityInformationId;
    if (
      actorId !== input.scopeInformationId &&
      !refs.rows.some(
        (r) =>
          r.relation === "agent:actor" && r.target_information_id === actorId,
      )
    )
      throw new KnowledgeEvidenceError();
  }
}
