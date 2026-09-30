/** Ordered, durable projection of semantic Information and its evidence into raw Memory. */
import {
  RAW_PROJECTED_KINDS,
  RAW_SEMANTIC_KINDS,
  renderRawEvent,
  type FrozenRawContext,
  type RawContextAccess,
  type RawEvent,
  type RawReference,
  type RawScope,
} from "@kaguya/memory";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

type LedgerRow = {
  information_id: string;
  kind: string;
  occurred_at: string;
  position: string | number;
  payload: Record<string, unknown>;
};
type RefRow = { relation: string; target_information_id: string };
type RawRow = {
  information_id: string;
  kind: string;
  occurred_at: string | Date;
  position: string | number;
  payload: Record<string, unknown>;
  references: RawReference[];
  scope: RawScope | null;
};
const selectedKinds = new Set<string>(RAW_PROJECTED_KINDS);
const semanticKinds = new Set<string>(RAW_SEMANTIC_KINDS);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const iso = (value: string | Date) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const keyOf = (scope: RawScope) =>
  JSON.stringify([
    scope.platform,
    scope.adapterId,
    scope.destination.kind,
    scope.destination.kind === "private"
      ? scope.destination.userId
      : scope.destination.kind === "group"
        ? scope.destination.groupId
        : (scope.destination.conversationId ?? null),
  ]);
function scopeOf(payload: Record<string, unknown>): RawScope | null {
  const source = object(payload.source) ?? payload;
  const destination = object(source.destination) ?? object(source.target);
  const platform = string(source.platform),
    adapterId = string(source.adapterId);
  if (
    !platform ||
    !adapterId ||
    !destination ||
    !["private", "group", "web"].includes(String(destination.kind))
  )
    return null;
  return {
    platform,
    adapterId,
    destination: destination as RawScope["destination"],
  };
}
function profileEvidenceIds(payload: Record<string, unknown>): string[] {
  const sections = object(payload.sections);
  const metadata = object(payload.metadata);
  const entries = [
    ...Object.values(sections ?? {}).flatMap((value) =>
      Array.isArray(value) ? value : [],
    ),
    ...(Array.isArray(metadata?.aliases) ? metadata.aliases : []),
  ];
  return entries.flatMap((entry) =>
    Array.isArray(object(entry)?.evidenceInformationIds)
      ? (object(entry)!.evidenceInformationIds as unknown[]).filter(
          (id): id is string => !!string(id),
        )
      : [],
  );
}
const eventOf = (row: RawRow): RawEvent => ({
  informationId: row.information_id,
  kind: row.kind,
  occurredAt: iso(row.occurred_at),
  position: Number(row.position),
  payload: row.payload,
  references: row.references,
  scope: row.scope,
});

export class PostgresRawEventStore implements RawContextAccess {
  constructor(private readonly database: SqlDatabase) {}

  async projectLatest(): Promise<number> {
    const latest = await this.database.query<{ information_id: string }>(
      "SELECT information_id FROM information_lifecycle ORDER BY position DESC LIMIT 1",
    );
    return latest.rows[0]
      ? this.projectThrough(latest.rows[0].information_id)
      : 0;
  }

  async projectThrough(informationId: string): Promise<number> {
    const cutoff = await this.database.query<{ position: string | number }>(
      "SELECT position FROM information_lifecycle WHERE information_id=$1",
      [informationId],
    );
    if (!cutoff.rows[0]) throw new Error("Raw Memory cutoff is not registered");
    const through = Number(cutoff.rows[0].position);
    for (;;) {
      const progressed = await this.database.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(168169)");
        const checkpoint = await tx.query<{ position: string | number }>(
          "SELECT position FROM memory_raw_checkpoint WHERE singleton=true FOR UPDATE",
        );
        const after = Number(checkpoint.rows[0]?.position ?? 0);
        if (after >= through) return false;
        const page = await tx.query<LedgerRow>(
          "SELECT l.position, a.information_id, a.kind, a.occurred_at, a.payload FROM information_lifecycle l JOIN information_atoms a USING(information_id) WHERE l.position>$1 AND l.position<=$2 ORDER BY l.position ASC LIMIT 100",
          [after, through],
        );
        if (page.rows.length === 0)
          throw new Error("Raw Memory ledger position gap");
        for (const row of page.rows) {
          if (!selectedKinds.has(row.kind)) continue;
          const atom = await this.loadLedgerEvent(tx, row.information_id);
          if (!atom) throw new Error("Raw Memory missing selected event");
          const evidence = await this.loadEvidence(tx, atom);
          for (const item of evidence.values()) await this.insert(tx, item);
          const root =
            !atom.scope &&
            [
              "memory.text",
              "core.person.fact.extracted",
              "memory.identity.platform.account.binding",
            ].includes(atom.kind)
              ? {
                  ...atom,
                  scope:
                    [...evidence.values()].find((item) => item.scope)?.scope ??
                    null,
                }
              : atom;
          await this.insert(tx, root);
          if (
            atom.kind === "filter.decision" &&
            atom.payload.accepted === false
          ) {
            const inbound = atom.references.find(
              (ref) => ref.relation === "core:caused-by",
            )?.informationId;
            if (!inbound)
              throw new Error(
                "Raw Memory filter decision lacks inbound evidence",
              );
            await tx.query(
              "INSERT INTO memory_raw_rejections(inbound_information_id,position) VALUES($1,$2) ON CONFLICT(inbound_information_id) DO UPDATE SET position=LEAST(memory_raw_rejections.position,EXCLUDED.position)",
              [inbound, atom.position],
            );
          }
        }
        await tx.query(
          "UPDATE memory_raw_checkpoint SET position=$1 WHERE singleton=true",
          [Number(page.rows.at(-1)!.position)],
        );
        return true;
      });
      if (!progressed) return through;
    }
  }

  private async loadLedgerEvent(
    tx: SqlTransaction,
    id: string,
  ): Promise<RawEvent | undefined> {
    const found = await tx.query<LedgerRow>(
      "SELECT l.position,a.information_id,a.kind,a.occurred_at,a.payload FROM information_atoms a JOIN information_lifecycle l USING(information_id) WHERE a.information_id=$1",
      [id],
    );
    const row = found.rows[0];
    if (!row) return undefined;
    const refs = await tx.query<RefRow>(
      "SELECT relation,target_information_id FROM information_references WHERE information_id=$1 ORDER BY ordinal",
      [id],
    );
    return {
      informationId: row.information_id,
      kind: row.kind,
      occurredAt: iso(row.occurred_at),
      position: Number(row.position),
      payload: row.payload,
      references: refs.rows.map((ref) => ({
        relation: ref.relation,
        informationId: ref.target_information_id,
      })),
      scope: scopeOf(row.payload),
    };
  }

  private async loadEvidence(
    tx: SqlTransaction,
    root: RawEvent,
  ): Promise<Map<string, RawEvent>> {
    const found = new Map<string, RawEvent>();
    const pending: Array<{ id: string; depth: number }> = [];
    const enqueueRefs = (event: RawEvent, depth: number) => {
      for (const ref of event.references)
        if (
          ref.relation !== "core:context" &&
          ref.relation !== "agent:turn-claim" &&
          ref.relation !== "agent:turn-candidate"
        )
          pending.push({ id: ref.informationId, depth });
      if (event.kind === "memory.expression.learning.completed") {
        const scope = string(event.payload.scopeInformationId);
        if (scope) pending.push({ id: scope, depth });
        const habits = Array.isArray(event.payload.habits)
          ? event.payload.habits
          : [];
        for (const habit of habits)
          for (const id of Array.isArray(object(habit)?.sourceInformationIds)
            ? (object(habit)!.sourceInformationIds as unknown[])
            : [])
            if (string(id)) pending.push({ id: String(id), depth });
      }
      if (event.kind === "memory.identity.person.profile.revision")
        for (const id of profileEvidenceIds(event.payload))
          pending.push({ id, depth });
      if (
        event.kind === "memory.identity.platform.account.binding" &&
        string(event.payload.personInformationId)
      )
        pending.push({ id: String(event.payload.personInformationId), depth });
      if (
        event.kind === "core.model.task.requested" &&
        string(event.payload.sourceInformationId)
      )
        pending.push({ id: String(event.payload.sourceInformationId), depth });
    };
    enqueueRefs(root, 1);
    while (pending.length) {
      const next = pending.shift()!;
      if (found.has(next.id) || next.id === root.informationId) continue;
      if (found.size >= 2000)
        throw new Error("Raw Memory evidence chain too large");
      const atom = await this.loadLedgerEvent(tx, next.id);
      if (!atom) throw new Error("Raw Memory evidence atom missing");
      found.set(next.id, atom);
      if (
        next.depth < 4 &&
        [
          "core.delivery.requested",
          "agent.heavy.message.content.confirmed",
          "core.model.task.completed",
          "core.model.task.requested",
          "core.person.fact.candidate",
        ].includes(atom.kind)
      )
        enqueueRefs(atom, next.depth + 1);
    }
    return found;
  }

  private async insert(tx: SqlTransaction, atom: RawEvent): Promise<void> {
    let scope = atom.scope;
    if (
      !scope &&
      ["core.delivery.delivered", "core.delivery.failed"].includes(atom.kind)
    ) {
      const requestId = atom.references.find(
        (ref) => ref.relation === "core:status-of",
      )?.informationId;
      if (requestId) {
        const request = await this.loadLedgerEvent(tx, requestId);
        scope = request?.scope ?? null;
      }
    }
    if (
      !scope &&
      ["memory.text", "core.person.fact.extracted"].includes(atom.kind)
    ) {
      const sourceId = atom.references.find(
        (ref) =>
          ref.relation === "core:uses-context" ||
          ref.relation === "core:caused-by",
      )?.informationId;
      if (sourceId) {
        const source = await this.loadLedgerEvent(tx, sourceId);
        scope = source?.scope ?? null;
      }
    }
    if (!scope && atom.kind === "memory.expression.learning.completed") {
      const id = string(atom.payload.scopeInformationId);
      if (id) {
        const row = await this.loadLedgerEvent(tx, id);
        scope = row ? scopeOf(row.payload) : null;
      }
    }
    await tx.query(
      `INSERT INTO memory_raw_events(information_id,kind,payload,"references",scope,scope_key,occurred_at,position,is_semantic)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9)
      ON CONFLICT(information_id) DO UPDATE SET is_semantic=EXCLUDED.is_semantic,
        scope=COALESCE(memory_raw_events.scope,EXCLUDED.scope),scope_key=COALESCE(memory_raw_events.scope_key,EXCLUDED.scope_key)`,
      [
        atom.informationId,
        atom.kind,
        JSON.stringify(atom.payload),
        JSON.stringify(atom.references),
        scope ? JSON.stringify(scope) : null,
        scope ? keyOf(scope) : null,
        atom.occurredAt,
        atom.position,
        semanticKinds.has(atom.kind),
      ],
    );
  }

  async freeze(input: {
    turnInformationId: string;
    asOf: string;
    scope: RawScope;
    unreadInformationIds: readonly string[];
  }): Promise<FrozenRawContext> {
    const through = await this.projectThrough(input.turnInformationId);
    const end = new Date(input.asOf),
      start = new Date(end.getTime() - 600_000);
    if (!Number.isFinite(end.getTime()))
      throw new Error("Invalid raw Memory freeze time");
    const base = `is_semantic AND position <= $1 AND occurred_at <= $2 AND NOT EXISTS
      (SELECT 1 FROM memory_raw_rejections r WHERE r.inbound_information_id=memory_raw_events.information_id AND r.position <= $1)
      AND (kind <> 'memory.expression.learning.completed' OR (payload->>'status'='completed' AND jsonb_array_length(payload->'habits')>0))`;
    const globalQuery = `SELECT * FROM memory_raw_events WHERE ${base} AND occurred_at >= $3 ORDER BY occurred_at DESC,position DESC LIMIT 1000 OFFSET $4`;
    let globalRows = (
      await this.database.query<RawRow>(globalQuery, [
        through,
        end.toISOString(),
        start.toISOString(),
        0,
      ])
    ).rows;
    const scopeKey = keyOf(input.scope);
    const scopeQuery = `SELECT * FROM memory_raw_events WHERE ${base} AND scope_key=$3 AND occurred_at >= $4 ORDER BY occurred_at DESC,position DESC LIMIT 1000 OFFSET $5`;
    let scopeRows = (
      await this.database.query<RawRow>(scopeQuery, [
        through,
        end.toISOString(),
        scopeKey,
        start.toISOString(),
        0,
      ])
    ).rows;
    const olderQuery = `SELECT * FROM memory_raw_events WHERE ${base} AND scope_key=$3 AND occurred_at < $4 ORDER BY occurred_at DESC,position DESC LIMIT 300 OFFSET $5`;
    let olderRows = (
      await this.database.query<RawRow>(olderQuery, [
        through,
        end.toISOString(),
        scopeKey,
        start.toISOString(),
        0,
      ])
    ).rows;
    const unreadCandidates = input.unreadInformationIds.length
      ? await this.database.query<RawRow>(
          `SELECT * FROM memory_raw_events WHERE is_semantic AND position<=$1 AND information_id=ANY($2::text[])`,
          [through, [...input.unreadInformationIds]],
        )
      : { rows: [] as RawRow[] };
    if (
      unreadCandidates.rows.length !== new Set(input.unreadInformationIds).size
    )
      throw new Error("Raw Memory unread input is missing");
    const rejectedUnread = input.unreadInformationIds.length
      ? await this.database.query<{ inbound_information_id: string }>(
          "SELECT inbound_information_id FROM memory_raw_rejections WHERE position<=$1 AND inbound_information_id=ANY($2::text[])",
          [through, [...input.unreadInformationIds]],
        )
      : { rows: [] as { inbound_information_id: string }[] };
    const rejectedIds = new Set(
      rejectedUnread.rows.map((row) => row.inbound_information_id),
    );
    const unreadRows = {
      rows: unreadCandidates.rows.filter(
        (row) => !rejectedIds.has(row.information_id),
      ),
    };
    const all = new Map<string, RawEvent>();
    // Evidence is read solely from raw Memory, in bounded batches rather than ledger joins.
    const hydrate = async (rows: RawRow[]) => {
      const added = rows.map((row) => eventOf(row));
      for (const event of added) all.set(event.informationId, event);
      let frontier = added.flatMap((event) => [
        ...event.references.map((ref) => ref.informationId),
        ...(event.kind === "memory.expression.learning.completed"
          ? [
              String(event.payload.scopeInformationId),
              ...((event.payload.habits as any[] | undefined) ?? []).flatMap(
                (habit) => habit.sourceInformationIds ?? [],
              ),
            ]
          : []),
        ...(event.kind === "memory.identity.person.profile.revision"
          ? profileEvidenceIds(event.payload)
          : []),
      ]);
      for (let depth = 0; depth < 4 && frontier.length; depth++) {
        const ids = [
          ...new Set(
            frontier.filter((id) => typeof id === "string" && !all.has(id)),
          ),
        ];
        frontier = [];
        for (let offset = 0; offset < ids.length; offset += 500) {
          const found = await this.database.query<RawRow>(
            "SELECT * FROM memory_raw_events WHERE information_id=ANY($1::text[])",
            [ids.slice(offset, offset + 500)],
          );
          for (const row of found.rows) {
            const event = eventOf(row);
            all.set(event.informationId, event);
            frontier.push(...event.references.map((ref) => ref.informationId));
            if (
              event.kind === "core.model.task.requested" &&
              string(event.payload.sourceInformationId)
            )
              frontier.push(String(event.payload.sourceInformationId));
            if (
              event.kind === "memory.identity.platform.account.binding" &&
              string(event.payload.personInformationId)
            )
              frontier.push(String(event.payload.personInformationId));
          }
        }
      }
    };
    await hydrate([
      ...globalRows,
      ...scopeRows,
      ...olderRows,
      ...unreadRows.rows,
    ]);
    const unread = new Set(input.unreadInformationIds);
    const render = (rows: RawRow[], markUnread = true) =>
      rows
        .map((row) => ({
          event: all.get(row.information_id)!,
          block: renderRawEvent(
            all.get(row.information_id)!,
            all,
            markUnread && unread.has(row.information_id),
          ),
        }))
        .filter(
          (
            item,
          ): item is {
            event: RawEvent;
            block: { text: string; informationIds: readonly string[] };
          } => !!item.block,
        );
    const expandRecent = async (
      rows: RawRow[],
      query: string,
      params: unknown[],
    ) => {
      while (
        rows.length > 0 &&
        rows.length % 1000 === 0 &&
        render(rows).reduce(
          (count, item) => count + Array.from(item.block.text).length + 1,
          0,
        ) < 32_000
      ) {
        const page = await this.database.query<RawRow>(query, [
          ...params,
          rows.length,
        ]);
        if (page.rows.length === 0) break;
        await hydrate(page.rows);
        rows = [...rows, ...page.rows];
      }
      return rows;
    };
    globalRows = await expandRecent(globalRows, globalQuery, [
      through,
      end.toISOString(),
      start.toISOString(),
    ]);
    scopeRows = await expandRecent(scopeRows, scopeQuery, [
      through,
      end.toISOString(),
      scopeKey,
      start.toISOString(),
    ]);
    const global = render(globalRows, false).reverse();
    const recent = render(scopeRows).reverse();
    let older = render(olderRows).slice(0, 30).reverse();
    while (
      older.length < 30 &&
      olderRows.length % 300 === 0 &&
      olderRows.length > 0
    ) {
      const page = await this.database.query<RawRow>(olderQuery, [
        through,
        end.toISOString(),
        scopeKey,
        start.toISOString(),
        olderRows.length,
      ]);
      if (page.rows.length === 0) break;
      await hydrate(page.rows);
      olderRows = [...olderRows, ...page.rows];
      older = render(olderRows).slice(0, 30).reverse();
    }
    const protectedIds = new Set(
      [...older, ...render(unreadRows.rows)].map(
        (item) => item.event.informationId,
      ),
    );
    const current = [
      ...new Map(
        [...older, ...recent, ...render(unreadRows.rows)].map((item) => [
          item.event.informationId,
          item,
        ]),
      ).values(),
    ].sort(
      (a, b) =>
        a.event.occurredAt.localeCompare(b.event.occurredAt) ||
        a.event.position - b.event.position,
    );
    const length = () =>
      [global, current].reduce(
        (total, items) =>
          total +
          items.reduce(
            (sum, item) => sum + Array.from(item.block.text).length,
            0,
          ) +
          Math.max(0, items.length - 1),
        0,
      );
    while (length() > 32_000) {
      const choices = [
        global[0] && { list: global, event: global[0] },
        current.find((item) => !protectedIds.has(item.event.informationId)) && {
          list: current,
          event: current.find(
            (item) => !protectedIds.has(item.event.informationId),
          )!,
        },
      ].filter(
        (
          item,
        ): item is { list: typeof global; event: (typeof global)[number] } =>
          !!item,
      );
      if (!choices.length) break;
      choices.sort((a, b) =>
        a.event.event.occurredAt.localeCompare(b.event.event.occurredAt),
      );
      const chosen = choices[0]!;
      chosen.list.splice(chosen.list.indexOf(chosen.event), 1);
    }
    const block = (items: typeof global) => ({
      text: items.map((item) => item.block.text).join("\n"),
      informationIds: [
        ...new Set(items.flatMap((item) => item.block.informationIds)),
      ],
    });
    return {
      global: block(global),
      currentScope: block(current),
      overBudget: length() > 32_000,
      characterCount: length(),
    };
  }
}
