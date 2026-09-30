/** One-time, operator-invoked migration from versioned Model Task payloads. */
import type { SqlDatabase } from "@kaguya/database";
import {
  modelTaskFingerprint,
  modelTaskRequestedInformationKind,
} from "@kaguya/runtime";

type Row = {
  information_id: string;
  kind: string;
  payload: Record<string, unknown>;
};
type Slot = { information_id: string; key: string };
export interface ModelTaskMigrationReport {
  readonly alreadyMigrated: boolean;
  readonly requests: number;
  readonly terminals: number;
  readonly decisions: number;
  readonly intents: number;
  readonly rawEventsCleared: number;
}

const oldRequestNamespace = "kaguya.model.task.requested.v1";
const newRequestNamespace = "kaguya.model.task.requested";
const oldTerminalNamespace = "kaguya.model.task.result.v1";
const newTerminalNamespace = "kaguya.model.task.result";
const taskKinds = [
  "core.model.task.requested",
  "core.model.task.completed",
  "core.model.task.failed",
  "core.model.task.cancelled",
] as const;

function withoutVersion(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { version: _version, ...rest } = payload;
  return rest;
}

/** The caller must stop every Kaguya process and take a database backup first. */
export async function migrateModelTaskProtocol(
  database: SqlDatabase,
): Promise<ModelTaskMigrationReport> {
  return database.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(168170)");
    const metadata = await tx.query<{
      version: number;
      information_protocol: string;
    }>(
      "SELECT version,information_protocol FROM kaguya_schema_metadata WHERE singleton=true FOR UPDATE",
    );
    if (
      metadata.rows[0]?.version === 2 &&
      metadata.rows[0].information_protocol === "router-light-heavy.v2"
    )
      return {
        alreadyMigrated: true,
        requests: 0,
        terminals: 0,
        decisions: 0,
        intents: 0,
        rawEventsCleared: 0,
      };
    if (
      metadata.rows.length !== 1 ||
      metadata.rows[0]?.version !== 1 ||
      metadata.rows[0].information_protocol !== "router-light-heavy.v1"
    )
      throw new Error(
        "Expected the previous Router/Light/Heavy v1 database protocol",
      );

    const pending = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_deliveries WHERE state IN ('pending','claimed')",
    );
    if (Number(pending.rows[0]?.count ?? 0) > 0)
      throw new Error(
        "Drain all pending deliveries with the old server before migrating",
      );
    const open = await tx.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM information_atoms requested
      WHERE requested.kind='core.model.task.requested' AND NOT EXISTS (
        SELECT 1 FROM information_references r JOIN information_atoms terminal
          ON terminal.information_id=r.information_id
        WHERE r.relation='core:status-of' AND r.target_information_id=requested.information_id
          AND terminal.kind IN ('core.model.task.completed','core.model.task.failed','core.model.task.cancelled'))`);
    if (Number(open.rows[0]?.count ?? 0) > 0)
      throw new Error("Finish or cancel every old Model Task before migrating");

    const tasks = await tx.query<Row>(
      "SELECT information_id,kind,payload FROM information_atoms WHERE kind=ANY($1::text[]) ORDER BY information_id",
      [taskKinds],
    );
    const requests = tasks.rows.filter(
      (row) => row.kind === "core.model.task.requested",
    );
    const slots = await tx.query<Slot>(
      "SELECT information_id,key FROM information_commit_slots WHERE slot_type='operation' AND namespace=$1",
      [oldRequestNamespace],
    );
    const slotIds = new Set(slots.rows.map((slot) => slot.information_id));
    if (
      slotIds.size !== requests.length ||
      requests.some((row) => !slotIds.has(row.information_id))
    )
      throw new Error("Old Model Task request slots do not match the ledger");
    const newKeys = new Map<string, string>();
    for (const row of requests) {
      if (typeof row.payload.version !== "string")
        throw new Error("Old Model Task request is missing its version");
      const migrated = modelTaskRequestedInformationKind.payloadSchema.parse(
        withoutVersion(row.payload),
      );
      const key = modelTaskFingerprint(migrated);
      if (newKeys.has(key))
        throw new Error("Model Task requests collide after removing version");
      newKeys.set(key, row.information_id);
    }
    const newSlots = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_commit_slots WHERE namespace IN ($1,$2)",
      [newRequestNamespace, newTerminalNamespace],
    );
    if (Number(newSlots.rows[0]?.count ?? 0) > 0)
      throw new Error("New Model Task slot namespace is already occupied");

    // The ledger is append-only during normal operation. This offline migration is the sole
    // deliberate exception, enclosed by one transaction and restored before commit.
    await tx.exec(
      "DROP TRIGGER information_atoms_reject_mutation ON information_atoms",
    );

    for (const row of tasks.rows) {
      if (typeof row.payload.version !== "string")
        throw new Error("Old Model Task atom is missing its version");
      const payload = withoutVersion(row.payload);
      if (
        row.kind === "core.model.task.completed" &&
        payload.taskId === "agent.light.decide"
      ) {
        const output = payload.output;
        if (
          output &&
          typeof output === "object" &&
          !Array.isArray(output) &&
          (output as Record<string, unknown>).action === "message"
        )
          payload.output = withoutComposition(
            output as Record<string, unknown>,
          );
      }
      await tx.query(
        "UPDATE information_atoms SET payload=$2::jsonb WHERE information_id=$1",
        [row.information_id, JSON.stringify(payload)],
      );
    }
    const decisions = await tx.query<Row>(
      "SELECT information_id,kind,payload FROM information_atoms WHERE kind='agent.light.decision.completed' AND payload->'action' ? 'composition'",
    );
    for (const row of decisions.rows) {
      const payload = {
        ...row.payload,
        action: withoutComposition(
          row.payload.action as Record<string, unknown>,
        ),
      };
      await tx.query(
        "UPDATE information_atoms SET payload=$2::jsonb WHERE information_id=$1",
        [row.information_id, JSON.stringify(payload)],
      );
    }
    const intents = await tx.query<Row>(
      "SELECT information_id,kind,payload FROM information_atoms WHERE kind='agent.router.message.intent.requested' AND payload ? 'composition'",
    );
    for (const row of intents.rows)
      await tx.query(
        "UPDATE information_atoms SET payload=$2::jsonb WHERE information_id=$1",
        [row.information_id, JSON.stringify(withoutComposition(row.payload))],
      );

    for (const [key, informationId] of newKeys)
      await tx.query(
        "UPDATE information_commit_slots SET namespace=$1,key=$2 WHERE slot_type='operation' AND namespace=$3 AND information_id=$4",
        [newRequestNamespace, key, oldRequestNamespace, informationId],
      );
    await tx.query(
      "UPDATE information_commit_slots SET namespace=$1 WHERE slot_type='terminal' AND namespace=$2",
      [newTerminalNamespace, oldTerminalNamespace],
    );
    const rawTables = await tx.query<{
      events: string | null;
      rejections: string | null;
      checkpoint: string | null;
    }>(
      "SELECT to_regclass('memory_raw_events')::text AS events, to_regclass('memory_raw_rejections')::text AS rejections, to_regclass('memory_raw_checkpoint')::text AS checkpoint",
    );
    const rawTableCount = Object.values(rawTables.rows[0] ?? {}).filter(
      Boolean,
    ).length;
    if (rawTableCount !== 0 && rawTableCount !== 3)
      throw new Error("Raw Memory projection tables are incomplete");
    const raw =
      rawTableCount === 3
        ? await tx.query("DELETE FROM memory_raw_events")
        : { rowCount: 0 };
    if (rawTableCount === 3) {
      await tx.query("DELETE FROM memory_raw_rejections");
      await tx.query(
        "UPDATE memory_raw_checkpoint SET position=0 WHERE singleton=true",
      );
    }
    await tx.exec(`
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_version_check;
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_information_protocol_check;
      UPDATE kaguya_schema_metadata SET version=2,information_protocol='router-light-heavy.v2' WHERE singleton=true;
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_version_check CHECK (version=2);
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_information_protocol_check CHECK (information_protocol='router-light-heavy.v2');
      CREATE TRIGGER information_atoms_reject_mutation
        BEFORE UPDATE OR DELETE ON information_atoms
        FOR EACH ROW EXECUTE FUNCTION kaguya_reject_information_mutation();
    `);
    return {
      alreadyMigrated: false,
      requests: requests.length,
      terminals: tasks.rows.length - requests.length,
      decisions: decisions.rows.length,
      intents: intents.rows.length,
      rawEventsCleared: raw.rowCount ?? 0,
    };
  });
}

function withoutComposition(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { composition: _composition, ...rest } = payload;
  return rest;
}
