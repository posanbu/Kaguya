/**
 * 功能概述：以 PostgreSQL 实现独立消息 Memory 的幂等写入与范围化字符倒排召回。
 * 主要职责：校验文档/查询、原子写入文档和 Unicode 2-gram、按可选原生 key 过滤，
 * 并以查询 gram 覆盖率和时间产生稳定结果。
 * 代码库关系：KaguyaDatabase 暴露本仓储；Runtime 将 recall 适配为 Information
 * retrieval strategy；表结构由 schema.ts 建立，Memory 行不属于 append-only ledger。
 * 输入输出与副作用：put/recall 执行数据库 I/O；正文和 query 从不进入错误消息。
 */
import { randomUUID } from "node:crypto";

import {
  MemorySourceConflictError,
  memoryDestinationIdentity,
  memorySparseDocumentGrams,
  memorySparseGrams,
  parseMemoryDocumentInput,
  parseMemoryRecallQuery,
  type MemoryAccess,
  type MemoryDocument,
  type MemoryDocumentInput,
  type MemoryPutResult,
  type MemoryRecallHit,
  type MemoryRecallQuery,
  type MemoryScopeKey,
} from "@kaguya/memory";
import type { PlatformDestination } from "@kaguya/schema";

import type { SqlDatabase, SqlTransaction } from "./driver.js";

type MemoryDocumentRow = {
  memory_id: string;
  source_information_id: string;
  source_kind: string;
  content: string;
  occurred_at: string;
  created_at: string;
  platform: string;
  adapter_id: string;
  platform_message_id: string;
  account_id: string;
  destination_kind: PlatformDestination["kind"];
  destination_id: string | null;
};

type MemoryRecallRow = MemoryDocumentRow & { score: string | number };

export interface PostgresMemoryStoreOptions {
  readonly memoryIdGenerator?: () => string;
  readonly now?: () => Date;
}

export class PostgresMemoryStore implements MemoryAccess {
  readonly #nextMemoryId: () => string;
  readonly #now: () => Date;

  constructor(
    private readonly database: SqlDatabase,
    options: PostgresMemoryStoreOptions = {},
  ) {
    this.#nextMemoryId = options.memoryIdGenerator ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async put(input: MemoryDocumentInput): Promise<MemoryPutResult> {
    const parsed = parseMemoryDocumentInput(input);
    const candidate = freezeMemoryDocument({
      ...parsed,
      memoryId: this.#nextMemoryId(),
      createdAt: this.#now().toISOString(),
    });
    const destination = memoryDestinationIdentity(parsed.address.destination);
    const grams = memorySparseDocumentGrams(parsed.content);

    return this.database.transaction(async (tx) => {
      const inserted = await tx.query<MemoryDocumentRow>(
        `INSERT INTO memory_documents (
           memory_id, source_information_id, source_kind, content,
           occurred_at, created_at, platform, adapter_id,
           platform_message_id, account_id, destination_kind, destination_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         )
         ON CONFLICT (source_information_id) DO NOTHING
         RETURNING *`,
        [
          candidate.memoryId,
          candidate.sourceInformationId,
          candidate.sourceKind,
          candidate.content,
          candidate.occurredAt,
          candidate.createdAt,
          candidate.address.platform,
          candidate.address.adapterId,
          candidate.address.platformMessageId,
          candidate.address.accountId,
          destination.kind,
          destination.id ?? null,
        ],
      );

      if (inserted.rows[0] !== undefined) {
        if (grams.length > 0) {
          await tx.query(
            `INSERT INTO memory_document_ngrams (memory_id, gram)
             SELECT $1, gram
             FROM unnest($2::text[]) AS gram
             ON CONFLICT DO NOTHING`,
            [candidate.memoryId, [...grams]],
          );
        }
        return Object.freeze({
          document: rowToDocument(inserted.rows[0]),
          created: true,
        });
      }

      const existing = await readBySource(tx, parsed.sourceInformationId);
      if (existing === undefined || !sameDocumentInput(existing, parsed)) {
        throw new MemorySourceConflictError(parsed.sourceInformationId);
      }
      return Object.freeze({ document: existing, created: false });
    });
  }

  async recall(query: MemoryRecallQuery): Promise<readonly MemoryRecallHit[]> {
    const parsed = parseMemoryRecallQuery(query);
    const grams = memorySparseGrams(parsed.query);
    if (grams.length === 0) return Object.freeze([]);

    const values: unknown[] = [[...grams], grams.length];
    const predicates: string[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (parsed.namespaces?.length) {
      predicates.push(
        `(${parsed.namespaces
          .map(
            (key) =>
              `(d.platform = ${bind(key.platform)} AND d.adapter_id = ${bind(key.adapterId)})`,
          )
          .join(" OR ")})`,
      );
    }
    if (parsed.accounts?.length) {
      predicates.push(
        `(${parsed.accounts
          .map(
            (key) =>
              `(d.platform = ${bind(key.platform)} AND d.adapter_id = ${bind(key.adapterId)} AND d.account_id = ${bind(key.accountId)})`,
          )
          .join(" OR ")})`,
      );
    }
    if (parsed.scopes?.length) {
      predicates.push(
        `(${parsed.scopes.map((key) => scopePredicate(key, bind)).join(" OR ")})`,
      );
    }
    if (parsed.occurredBefore !== undefined) {
      predicates.push(
        `d.occurred_at::timestamptz <= ${bind(parsed.occurredBefore)}::timestamptz`,
      );
    }
    if (parsed.excludeSourceInformationIds?.length) {
      predicates.push(
        `NOT (d.source_information_id = ANY(${bind([...parsed.excludeSourceInformationIds])}::text[]))`,
      );
    }
    const limit = bind(parsed.limit);
    const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
    const result = await this.database.query<MemoryRecallRow>(
      `WITH query_grams AS (
         SELECT unnest($1::text[]) AS gram
       ), matches AS (
         SELECT ng.memory_id, COUNT(DISTINCT ng.gram) AS hit_terms
         FROM memory_document_ngrams ng
         INNER JOIN query_grams q ON q.gram = ng.gram
         GROUP BY ng.memory_id
       )
       SELECT d.*, matches.hit_terms::double precision / $2::double precision AS score
       FROM matches
       INNER JOIN memory_documents d ON d.memory_id = matches.memory_id
       ${where}
       ORDER BY score DESC, d.occurred_at::timestamptz DESC, d.memory_id ASC
       LIMIT ${limit}`,
      values,
    );
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          document: rowToDocument(row),
          score: Number(row.score),
        }),
      ),
    );
  }
}

async function readBySource(
  tx: SqlTransaction,
  sourceInformationId: string,
): Promise<MemoryDocument | undefined> {
  const result = await tx.query<MemoryDocumentRow>(
    `SELECT * FROM memory_documents WHERE source_information_id = $1`,
    [sourceInformationId],
  );
  return result.rows[0] === undefined
    ? undefined
    : rowToDocument(result.rows[0]);
}

function scopePredicate(
  key: MemoryScopeKey,
  bind: (value: unknown) => string,
): string {
  const destination = memoryDestinationIdentity(key.destination);
  return `(d.platform = ${bind(key.platform)} AND d.adapter_id = ${bind(
    key.adapterId,
  )} AND d.destination_kind = ${bind(destination.kind)} AND d.destination_id IS NOT DISTINCT FROM ${bind(
    destination.id ?? null,
  )})`;
}

function rowToDocument(row: MemoryDocumentRow): MemoryDocument {
  return freezeMemoryDocument({
    memoryId: row.memory_id,
    sourceInformationId: row.source_information_id,
    sourceKind: row.source_kind,
    content: row.content,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    address: {
      platform: row.platform,
      adapterId: row.adapter_id,
      platformMessageId: row.platform_message_id,
      accountId: row.account_id,
      destination: rowToDestination(row),
    },
  });
}

function rowToDestination(row: MemoryDocumentRow): PlatformDestination {
  if (row.destination_kind === "private") {
    if (row.destination_id === null)
      throw new Error("Invalid private memory row");
    return { kind: "private", userId: row.destination_id };
  }
  if (row.destination_kind === "group") {
    if (row.destination_id === null)
      throw new Error("Invalid group memory row");
    return { kind: "group", groupId: row.destination_id };
  }
  if (row.destination_id !== null) throw new Error("Invalid web memory row");
  return { kind: "web" };
}

function sameDocumentInput(
  document: MemoryDocument,
  input: MemoryDocumentInput,
): boolean {
  const documentDestination = memoryDestinationIdentity(
    document.address.destination,
  );
  const inputDestination = memoryDestinationIdentity(input.address.destination);
  return (
    document.sourceKind === input.sourceKind &&
    document.content === input.content &&
    Date.parse(document.occurredAt) === Date.parse(input.occurredAt) &&
    document.address.platform === input.address.platform &&
    document.address.adapterId === input.address.adapterId &&
    document.address.platformMessageId === input.address.platformMessageId &&
    document.address.accountId === input.address.accountId &&
    documentDestination.kind === inputDestination.kind &&
    documentDestination.id === inputDestination.id
  );
}

function freezeMemoryDocument(document: MemoryDocument): MemoryDocument {
  return Object.freeze({
    ...document,
    address: Object.freeze({
      ...document.address,
      destination: Object.freeze({ ...document.address.destination }),
    }),
  });
}
