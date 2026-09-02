/**
 * 架构说明：本模块实现信息原子在 PostgreSQL 中的 append-only 仓储，
 * 负责 kind 同步、原子追加、按 id 读取与反向引用查询，并把数据库错误
 * 归一为仓储层错误，供 engine 的 `InformationAtomStore` 直接消费。
 * 代码库关系：`InformationCore` 只会看到这里实现的 store 端口；`postgres-driver.ts`
 * 提供事务与 query 抽象，`postgres-migrations.ts` 则先建立表结构、索引和 mutation 触发器。
 */
import {
  freezeInformationAtom,
  informationAtomSchema,
  informationReferenceSchema,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  type JsonObject,
} from "@kaguya/schema";
import type {
  InformationAppendOptions,
  InformationLedger,
  InformationReferenceExpectation,
  InformationReferenceQuery,
} from "@kaguya/engine";

import type { SqlDatabase, SqlTransaction } from "./postgres-driver.js";

type AtomRow = {
  information_id: string;
  kind: string;
  occurred_at: string;
  source: string;
  payload: unknown;
};

type ReferenceRow = {
  relation: string;
  target_information_id: string;
  ordinal: number;
};

type KindRow = {
  kind: string;
};

export class InformationStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InformationStoreError";
  }
}

export class InformationIdConflictError extends InformationStoreError {
  constructor(
    readonly informationId: string,
    options?: ErrorOptions,
  ) {
    super(`Information id conflict: ${informationId}`, options);
  }
}

export class InvalidInformationReferenceError extends InformationStoreError {
  constructor(
    readonly kind: string,
    readonly relation: string,
    readonly reason:
      "undeclared" | "multiple" | "missing-target" | "target-kind" | "required",
    options?: ErrorOptions,
  ) {
    super(
      `Invalid information reference ${relation} on ${kind}: ${reason}`,
      options,
    );
  }
}

export class InformationKindSetMismatchError extends InformationStoreError {
  constructor(
    readonly expectedKinds: readonly string[],
    readonly actualKinds: readonly string[],
  ) {
    super("information kind set mismatch");
  }
}

export interface PendingInformationLogProjection {
  readonly informationId: InformationId;
  readonly attemptCount: number;
}

/**
 * PostgreSQL implementation of the append-only InformationLedger boundary.
 * Log jobs live in a separate outbox so delivery bookkeeping never mutates an
 * information atom.
 */
export class InformationRepository implements InformationLedger {
  constructor(private readonly database: SqlDatabase) {}

  async synchronizeKinds(kinds: readonly string[]): Promise<void> {
    await this.database.transaction(async (tx) => {
      const desiredKinds = normalizeKinds(kinds);
      const existingRows = await tx.query<KindRow>(
        "SELECT kind FROM information_kinds ORDER BY kind ASC",
      );
      const existingKinds = existingRows.rows.map(({ kind }) => kind);

      if (existingKinds.length === 0) {
        if (desiredKinds.length === 0) {
          return;
        }
        await insertKinds(tx, desiredKinds);
        return;
      }

      if (!areKindsEqual(existingKinds, desiredKinds)) {
        throw new InformationKindSetMismatchError(desiredKinds, existingKinds);
      }
    });
  }

  async append(
    atom: DeepReadonly<InformationAtom>,
    expectations: readonly InformationReferenceExpectation[],
    options: InformationAppendOptions = {},
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      try {
        await tx.query(
          `INSERT INTO information_atoms (
             information_id, kind, occurred_at, source, payload
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            atom.informationId,
            atom.kind,
            atom.occurredAt,
            atom.source,
            JSON.stringify(atom.payload),
          ],
        );

        const expectationsByRelation = new Map(
          expectations.map(
            (expectation) => [expectation.relation, expectation] as const,
          ),
        );
        const seenRelations = new Map<string, number>();
        const targetIds = new Set<string>();

        for (const reference of atom.references) {
          const expectation = expectationsByRelation.get(reference.relation);
          if (expectation === undefined) {
            throw new InvalidInformationReferenceError(
              atom.kind,
              reference.relation,
              "undeclared",
            );
          }
          if (
            expectation.multiple !== true &&
            seenRelations.has(reference.relation)
          ) {
            throw new InvalidInformationReferenceError(
              atom.kind,
              reference.relation,
              "multiple",
            );
          }
          seenRelations.set(
            reference.relation,
            (seenRelations.get(reference.relation) ?? 0) + 1,
          );
          targetIds.add(reference.informationId);
        }

        for (const expectation of expectations) {
          if (
            expectation.required === true &&
            (seenRelations.get(expectation.relation) ?? 0) === 0
          ) {
            throw new InvalidInformationReferenceError(
              atom.kind,
              expectation.relation,
              "required",
            );
          }
        }

        const targetKindsById = await loadTargetKinds(tx, [...targetIds]);

        for (const reference of atom.references) {
          const expectation = expectationsByRelation.get(reference.relation);
          if (expectation === undefined) {
            continue;
          }

          const targetKind = targetKindsById.get(reference.informationId);
          if (targetKind === undefined) {
            throw new InvalidInformationReferenceError(
              atom.kind,
              reference.relation,
              "missing-target",
            );
          }
          if (
            expectation.targetKinds !== undefined &&
            !expectation.targetKinds.includes(targetKind)
          ) {
            throw new InvalidInformationReferenceError(
              atom.kind,
              reference.relation,
              "target-kind",
            );
          }
        }

        for (const [ordinal, reference] of atom.references.entries()) {
          await tx.query(
            `INSERT INTO information_references (
               information_id, ordinal, relation, target_information_id
             ) VALUES ($1, $2, $3, $4)`,
            [
              atom.informationId,
              ordinal,
              reference.relation,
              reference.informationId,
            ],
          );
        }

        if (options.enqueueLogProjection === true) {
          await tx.query(
            `INSERT INTO information_log_outbox (information_id)
             VALUES ($1)`,
            [atom.informationId],
          );
        }
      } catch (error) {
        throw mapStoreError(atom.informationId, error);
      }
    });
  }

  async get(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    return this.database.transaction(async (tx) =>
      readAtomById(tx, informationId),
    );
  }

  /** @deprecated Use get(). */
  async getById(
    informationId: InformationId,
  ): Promise<DeepReadonly<InformationAtom> | undefined> {
    return this.get(informationId);
  }

  async getMany(
    informationIds: readonly InformationId[],
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    return this.database.transaction(async (tx) => {
      const atoms: DeepReadonly<InformationAtom>[] = [];
      for (const informationId of informationIds) {
        const atom = await readAtomById(tx, informationId);
        if (atom !== undefined) {
          atoms.push(atom);
        }
      }
      return atoms;
    });
  }

  async query(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    return this.database.transaction(async (tx) => {
      const rows = await tx.query<{ information_id: string }>(
        query.relation === undefined
          ? `
            SELECT a.information_id
            FROM information_atoms a
            WHERE EXISTS (
              SELECT 1
              FROM information_references r
              WHERE r.information_id = a.information_id
                AND r.target_information_id = $1
            )
            ORDER BY a.occurred_at ASC, a.information_id ASC
          `
          : `
            SELECT a.information_id
            FROM information_atoms a
            WHERE EXISTS (
              SELECT 1
              FROM information_references r
              WHERE r.information_id = a.information_id
                AND r.target_information_id = $1
                AND r.relation = $2
            )
            ORDER BY a.occurred_at ASC, a.information_id ASC
          `,
        query.relation === undefined
          ? [query.informationId]
          : [query.informationId, query.relation],
      );

      const atoms: DeepReadonly<InformationAtom>[] = [];
      for (const row of rows.rows) {
        const atom = await readAtomById(tx, row.information_id);
        if (atom !== undefined) {
          atoms.push(atom);
        }
      }
      return atoms;
    });
  }

  /** @deprecated Use query(). */
  async listByReference(
    query: InformationReferenceQuery,
  ): Promise<readonly DeepReadonly<InformationAtom>[]> {
    return this.query(query);
  }

  async listPendingLogProjections(
    limit: number,
  ): Promise<readonly PendingInformationLogProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new InformationStoreError(
        "log projection limit must be between 1 and 1000",
      );
    }
    return this.database.transaction(async (tx) => {
      const rows = await tx.query<{
        information_id: string;
        attempt_count: number;
      }>(
        `
          SELECT information_id, attempt_count
          FROM information_log_outbox
          WHERE projected_at IS NULL
          ORDER BY attempt_count ASC, created_at ASC, information_id ASC
          LIMIT $1
        `,
        [limit],
      );
      return rows.rows.map((row) => ({
        informationId: row.information_id as InformationId,
        attemptCount: row.attempt_count,
      }));
    });
  }

  async markLogProjectionDelivered(
    informationId: InformationId,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        `
          UPDATE information_log_outbox
          SET projected_at = CURRENT_TIMESTAMP,
              last_error = NULL
          WHERE information_id = $1
        `,
        [informationId],
      );
    });
  }

  async recordLogProjectionFailure(
    informationId: InformationId,
    errorType: string,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        `
          UPDATE information_log_outbox
          SET attempt_count = attempt_count + 1,
              last_error = $2
          WHERE information_id = $1
            AND projected_at IS NULL
        `,
        [informationId, errorType.slice(0, 120)],
      );
    });
  }
}

async function readAtomById(
  tx: SqlTransaction,
  informationId: InformationId,
): Promise<DeepReadonly<InformationAtom> | undefined> {
  const atomRows = await tx.query<AtomRow>(
    `
      SELECT information_id, kind, occurred_at, source, payload
      FROM information_atoms
      WHERE information_id = $1
    `,
    [informationId],
  );
  const row = atomRows.rows[0];
  if (row === undefined) {
    return undefined;
  }

  const referenceRows = await tx.query<ReferenceRow>(
    `
      SELECT relation, target_information_id, ordinal
      FROM information_references
      WHERE information_id = $1
      ORDER BY ordinal ASC
    `,
    [informationId],
  );

  return freezeInformationAtom(
    informationAtomSchema.parse({
      informationId: row.information_id,
      kind: row.kind,
      occurredAt: row.occurred_at,
      source: row.source,
      payload: decodeJsonObject(row.payload),
      references: referenceRows.rows.map((reference) =>
        informationReferenceSchema.parse({
          relation: reference.relation,
          informationId: reference.target_information_id,
        }),
      ),
    }),
  );
}

async function loadTargetKinds(
  tx: SqlTransaction,
  informationIds: readonly string[],
): Promise<Map<string, string>> {
  if (informationIds.length === 0) {
    return new Map();
  }

  const rows = await tx.query<KindRow & { information_id: string }>(
    `
      SELECT information_id, kind
      FROM information_atoms
      WHERE information_id = ANY($1::text[])
    `,
    [informationIds],
  );

  return new Map(
    rows.rows.map((row) => [row.information_id, row.kind] as const),
  );
}

async function insertKinds(
  tx: SqlTransaction,
  kinds: readonly string[],
): Promise<void> {
  await tx.query(
    `
      INSERT INTO information_kinds (kind)
      SELECT UNNEST($1::text[])
    `,
    [kinds],
  );
}

function normalizeKinds(kinds: readonly string[]): readonly string[] {
  const uniqueKinds = [...new Set(kinds)];
  if (uniqueKinds.length !== kinds.length) {
    throw new InformationStoreError("information kind set contains duplicates");
  }
  return uniqueKinds.sort((left, right) => left.localeCompare(right));
}

function areKindsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((kind, index) => kind === right[index]);
}

function decodeJsonObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    return JSON.parse(value) as JsonObject;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InformationStoreError("stored payload is not a JSON object");
  }
  return value as JsonObject;
}

function mapStoreError(informationId: string, error: unknown): Error {
  if (error instanceof InformationStoreError) {
    return error;
  }

  if (
    isPgConflict(error) &&
    (error as { constraint?: string }).constraint === "information_atoms_pkey"
  ) {
    return new InformationIdConflictError(informationId, { cause: error });
  }

  return new InformationStoreError("information repository operation failed", {
    cause: error,
  });
}

function isPgConflict(
  error: unknown,
): error is { code?: string; constraint?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
