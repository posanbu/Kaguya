import { createTestingDatabase } from "@kaguya/database/testing";
import {
  modelTaskFingerprint,
  modelTaskRequestedInformationKind,
} from "@kaguya/runtime";
import { expect, it } from "vitest";
import { migrateModelTaskProtocol } from "./model-task-migration.js";

it("manually converts an old ledger once and restores its append-only guard", async () => {
  const db = await createTestingDatabase();
  try {
    await db.prepareSchema();
    const request = modelTaskRequestedInformationKind.payloadSchema.parse({
      taskId: "agent.light.decide",
      outputMode: "object",
      sourceInformationId: "source-1",
      contextInformationId: "context-1",
      contextInformationIds: ["source-1"],
      promptKind: "route",
      promptTemplateId: "test-light",
      promptTemplateDigest: "template-digest",
      promptDigest: "prompt-digest",
      provenance: [],
      activation: { instanceId: "light-1", definitionId: "agent.light" },
      selectionPolicy: { tier: "light" },
      resolvedModel: { providerId: "test", modelId: "test-light" },
      prompt: {
        kind: "route",
        text: "hello",
        templateId: "test-light",
        templates: [{ name: "main", content: "hello" }],
        variables: [],
      },
    });
    for (const kind of [
      "core.model.task.requested",
      "core.model.task.completed",
      "agent.light.decision.completed",
      "agent.router.message.intent.requested",
    ])
      await db.sql.query(
        "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
        [kind],
      );
    const insert = (
      id: string,
      kind: string,
      payload: Record<string, unknown>,
    ) =>
      db.sql.query(
        "INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
        [id, kind, "2026-09-01T00:00:00Z", "test", JSON.stringify(payload)],
      );
    await insert("request-1", "core.model.task.requested", {
      ...request,
      version: "4",
    });
    await insert("terminal-1", "core.model.task.completed", {
      ...request,
      version: "4",
      output: {
        action: "message",
        reason: "respond",
        composition: { topic: "old" },
      },
    });
    await db.sql.query(
      "INSERT INTO information_references(information_id,ordinal,relation,target_information_id) VALUES('terminal-1',0,'core:status-of','request-1')",
    );
    await insert("decision-1", "agent.light.decision.completed", {
      action: {
        action: "message",
        reason: "respond",
        composition: { topic: "old" },
      },
    });
    await insert("intent-1", "agent.router.message.intent.requested", {
      target: "old",
      composition: { topic: "old" },
    });
    await db.sql.query(
      "INSERT INTO information_commit_slots(slot_type,namespace,key,information_id) VALUES('operation','kaguya.model.task.requested.v1','old-key','request-1'),('terminal','kaguya.model.task.result.v1','request-1','terminal-1')",
    );
    await db.sql.exec(`
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_version_check;
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_information_protocol_check;
      UPDATE kaguya_schema_metadata SET version=1,information_protocol='router-light-heavy.v1';
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_version_check CHECK (version=1);
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_information_protocol_check CHECK (information_protocol='router-light-heavy.v1');
      DROP TABLE memory_raw_rejections, memory_raw_checkpoint, memory_raw_events;
    `);

    await expect(db.prepareSchema()).rejects.toThrow(
      "Unsupported Kaguya database schema",
    );

    const report = await migrateModelTaskProtocol(db.sql);
    expect(report).toMatchObject({
      alreadyMigrated: false,
      requests: 1,
      terminals: 1,
      decisions: 1,
      intents: 1,
    });
    expect((await migrateModelTaskProtocol(db.sql)).alreadyMigrated).toBe(true);
    const atoms = await db.sql.query<{
      kind: string;
      payload: Record<string, unknown>;
    }>("SELECT kind,payload FROM information_atoms ORDER BY information_id");
    expect(
      atoms.rows.every((row) => !Object.hasOwn(row.payload, "version")),
    ).toBe(true);
    expect(
      atoms.rows.find((row) => row.kind === "agent.light.decision.completed")
        ?.payload.action,
    ).toEqual({ action: "message", reason: "respond" });
    expect(
      atoms.rows.find(
        (row) => row.kind === "agent.router.message.intent.requested",
      )?.payload,
    ).toEqual({ target: "old" });
    const slots = await db.sql.query<{ namespace: string; key: string }>(
      "SELECT namespace,key FROM information_commit_slots ORDER BY slot_type",
    );
    expect(slots.rows).toContainEqual({
      namespace: "kaguya.model.task.requested",
      key: modelTaskFingerprint(request),
    });
    expect(slots.rows).toContainEqual({
      namespace: "kaguya.model.task.result",
      key: "request-1",
    });
    await expect(
      db.sql.query(
        "UPDATE information_atoms SET source='mutated' WHERE information_id='request-1'",
      ),
    ).rejects.toThrow("append-only");
    await db.prepareSchema();
  } finally {
    await db.close();
  }
});

it("keeps the old protocol unchanged while deliveries are pending", async () => {
  const db = await createTestingDatabase();
  try {
    await db.prepareSchema();
    await db.sql.exec(`
      INSERT INTO information_kinds(kind) VALUES('test.pending');
      INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload)
        VALUES('pending-1','test.pending','2026-09-01T00:00:00Z','test','{}'::jsonb);
      INSERT INTO information_subscriptions(subscription_id,kind,enabled)
        VALUES('test-subscription','test.pending',true);
      INSERT INTO information_deliveries(subscription_id,information_id)
        VALUES('test-subscription','pending-1');
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_version_check;
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_information_protocol_check;
      UPDATE kaguya_schema_metadata SET version=1,information_protocol='router-light-heavy.v1';
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_version_check CHECK (version=1);
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_information_protocol_check CHECK (information_protocol='router-light-heavy.v1');
    `);
    await expect(migrateModelTaskProtocol(db.sql)).rejects.toThrow(
      "Drain all pending deliveries",
    );
    const metadata = await db.sql.query<{ version: number }>(
      "SELECT version FROM kaguya_schema_metadata",
    );
    expect(metadata.rows[0]?.version).toBe(1);
  } finally {
    await db.close();
  }
});

it("resets an existing raw Memory projection for ledger replay", async () => {
  const db = await createTestingDatabase();
  try {
    await db.prepareSchema();
    await db.sql.exec(`
      UPDATE memory_raw_checkpoint SET position=42 WHERE singleton=true;
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_version_check;
      ALTER TABLE kaguya_schema_metadata DROP CONSTRAINT kaguya_schema_metadata_information_protocol_check;
      UPDATE kaguya_schema_metadata SET version=1,information_protocol='router-light-heavy.v1';
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_version_check CHECK (version=1);
      ALTER TABLE kaguya_schema_metadata ADD CONSTRAINT kaguya_schema_metadata_information_protocol_check CHECK (information_protocol='router-light-heavy.v1');
    `);

    await expect(migrateModelTaskProtocol(db.sql)).resolves.toMatchObject({
      alreadyMigrated: false,
      rawEventsCleared: 0,
    });
    const checkpoint = await db.sql.query<{ position: string }>(
      "SELECT position::text FROM memory_raw_checkpoint WHERE singleton=true",
    );
    expect(checkpoint.rows[0]?.position).toBe("0");
    await db.prepareSchema();
  } finally {
    await db.close();
  }
});
