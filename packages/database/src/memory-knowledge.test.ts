/**
 * 功能概述：以真实 PostgreSQL 语义的 PGlite 验证第一方知识仓储，不用 mock 替代证据及并发约束。
 * 主要职责：覆盖事件幂等、人物身份与未来/派生拒绝、范围隔离、记录时间冻结、断言演化、Wiki CAS/重放/持久失效。
 * 代码库关系：复用正式 schema 和 InformationRepository，并重建 KaguyaDatabase wrapper 验证状态属于数据库而非进程内缓存。
 * 输入输出与副作用：每例隔离数据库、固定历史发生时间；测试后的 close 释放 WASM 数据库。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  KnowledgeConflictError,
  KnowledgeEvidenceError,
  type KnowledgeEventInput,
  type KnowledgeClaimInput,
  type WikiRevisionInput,
} from "@kaguya/memory";
import {
  freezeInformationAtom,
  informationIdSchema,
  type JsonObject,
} from "@kaguya/schema";
import { KaguyaDatabase } from "./index.js";
import { createTestingDatabase } from "./testing.js";

const databases: KaguyaDatabase[] = [];
const occurredAt = "2026-01-02T12:00:00.000Z";
const later = "2099-01-01T00:00:00.000Z";
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
function scopePayload(scopeId: string) {
  return {
    platform: "test",
    adapterId: "test.main",
    destination: { kind: "group", groupId: scopeId },
    scopeMode: "canonical",
  };
}
async function append(
  db: KaguyaDatabase,
  id: string,
  kind: string,
  time = occurredAt,
  payload?: JsonObject,
) {
  payload ??=
    kind === "agent.chat.scope.entity"
      ? scopePayload(id)
      : kind === "core.message.inbound.text"
        ? { text: "Alice likes tea", source: scopePayload("scope-a") }
        : {};
  await db.information.append(
    freezeInformationAtom({
      informationId: informationIdSchema.parse(id),
      kind,
      occurredAt: time,
      source: "test",
      payload,
      references:
        kind === "device.observation"
          ? [
              {
                relation: "agent:scope",
                informationId: informationIdSchema.parse("scope-a"),
              },
              {
                relation: "agent:actor",
                informationId: informationIdSchema.parse("sensor"),
              },
            ]
          : [],
    }),
    kind === "device.observation"
      ? [
          { relation: "agent:scope", required: true, multiple: false },
          { relation: "agent:actor", required: true, multiple: false },
        ]
      : [],
  );
  if (kind === "core.message.inbound.text") {
    const source = payload.source as JsonObject;
    const destination = source.destination as JsonObject;
    await db.information.append(
      freezeInformationAtom({
        informationId: informationIdSchema.parse(`identity-${id}`),
        kind: "agent.person.context.completed",
        occurredAt: time,
        source: "identity",
        payload: {
          status: "complete",
          scopeMode: "canonical",
          scopeInformationId: String(destination.groupId),
          personInformationId: "alice",
        },
        references: [
          {
            relation: "core:status-of",
            informationId: informationIdSchema.parse(id),
          },
        ],
      }),
      [{ relation: "core:status-of", required: true, multiple: false }],
    );
  }
}
async function setup() {
  const db = await createTestingDatabase();
  databases.push(db);
  await db.prepareSchema();
  await db.prepareMemoryKnowledgeSchema();
  await db.information.synchronizeKinds([
    "agent.chat.scope.entity",
    "agent.person.entity",
    "device.entity",
    "device.observation",
    "core.message.inbound.text",
    "agent.memory.wiki.revision",
    "agent.person.context.completed",
  ]);
  for (const id of ["scope-a", "scope-b"])
    await append(db, id, "agent.chat.scope.entity");
  for (const id of ["alice", "bob"])
    await append(db, id, "agent.person.entity");
  await append(db, "sensor", "device.entity");
  return db;
}
function event(
  id: string,
  scope = "scope-a",
  content = "Alice likes tea",
): KnowledgeEventInput {
  return {
    sourceInformationId: id,
    scopeInformationId: scope,
    occurredAt,
    content,
    eventType: "message",
    actor: { status: "resolved", entityInformationId: "alice" },
    subjects: [{ status: "resolved", entityInformationId: "bob" }],
  };
}
async function put(
  db: KaguyaDatabase,
  id: string,
  scope = "scope-a",
  content = "Alice likes tea",
) {
  await append(db, id, "core.message.inbound.text", occurredAt, {
    text: content,
    source: scopePayload(scope),
  });
  return db.knowledge.putEvent(event(id, scope, content));
}
function claim(
  id: string,
  evidence: string[],
  value = "tea",
): KnowledgeClaimInput {
  return {
    claimId: id,
    scopeInformationId: "scope-a",
    subjectInformationId: "alice",
    speakerInformationId: "alice",
    predicate: "likes",
    value,
    epistemic: "assertion",
    validFrom: occurredAt,
    evidenceSourceInformationIds: evidence,
  };
}
function query(scopeInformationId = "scope-a") {
  return {
    scopeInformationId,
    occurredBefore: later,
    recordedBefore: later,
    limit: 20,
  };
}
async function revision(
  db: KaguyaDatabase,
  sourceIds = ["source-a"],
): Promise<WikiRevisionInput> {
  const page = await db.knowledge.readWikiPage({
    scopeInformationId: "scope-a",
    entityInformationId: "alice",
  });
  return {
    operationId: `revision-${page!.version}`,
    scopeInformationId: "scope-a",
    entityInformationId: "alice",
    expectedVersion: page!.version,
    expectedDirtyVersion: page!.dirtyVersion,
    evidenceCutoff: { occurredBefore: later, recordedBefore: later },
    generatorVersion: "test-v1",
    sections: [
      {
        heading: "Stated preferences",
        content: "Alice said she likes tea",
        evidenceSourceInformationIds: sourceIds,
        claimIds: [],
      },
    ],
  };
}

describe("PostgresMemoryKnowledgeStore", () => {
  it("keeps generic raw events idempotent, separate actors/subjects and database recording time", async () => {
    const db = await setup();
    await append(db, "observation", "device.observation");
    const input: KnowledgeEventInput = {
      ...event("observation"),
      eventType: "temperature",
      actor: { status: "resolved", entityInformationId: "sensor" },
      subjects: [
        {
          status: "ambiguous",
          label: "owner",
          candidateInformationIds: ["alice", "bob"],
        },
      ],
      actionStatus: "completed",
      mediaReferences: [{ uri: "media:frame", startMs: 0, endMs: 100 }],
    };
    const first = await db.knowledge.putEvent(input);
    expect(first.created).toBe(true);
    expect(first.event.sourceKind).toBe("device.observation");
    expect(Date.parse(first.event.recordedAt)).toBeGreaterThan(
      Date.parse(occurredAt),
    );
    expect(await db.knowledge.putEvent(input)).toEqual({
      event: first.event,
      created: false,
    });
    await expect(
      db.knowledge.putEvent({ ...input, content: "changed" }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    const pages = await db.knowledge.listDirtyPages({ limit: 20 });
    expect(pages.map((p) => p.entityInformationId).sort()).toEqual([
      "scope-a",
      "sensor",
    ]);
    const firstPage = await db.knowledge.listDirtyPages({ limit: 1 });
    expect(
      await db.knowledge.listDirtyPages({ limit: 1, after: firstPage[0]! }),
    ).toEqual([pages[1]]);
    expect(
      await db.knowledge.getEvent("observation", "scope-b"),
    ).toBeUndefined();
    expect((await db.knowledge.recall(query())).missing).toContain(
      "unresolved_identity",
    );
  });

  it("rejects fabricated occurrence time, future and derived sources, and message IDs as people", async () => {
    const db = await setup();
    await append(db, "raw", "core.message.inbound.text");
    await expect(
      db.knowledge.putEvent({
        ...event("raw"),
        occurredAt: "2026-01-02T13:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await expect(
      db.knowledge.putEvent(event("raw", "scope-b")),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await expect(
      db.knowledge.putEvent(event("raw", "scope-a", "forged text")),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await expect(
      db.knowledge.putEvent(event("raw", "alice")),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await append(db, "ephemeral", "agent.chat.scope.entity", occurredAt, {
      ...scopePayload("ephemeral"),
      scopeMode: "ephemeral",
    });
    await expect(
      db.knowledge.putEvent(event("raw", "ephemeral")),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    for (const fakeActor of ["raw", "bob"])
      await expect(
        db.knowledge.putEvent({
          ...event("raw"),
          actor: { status: "resolved", entityInformationId: fakeActor },
        }),
      ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await append(db, "future", "device.observation", later);
    await expect(
      db.knowledge.putEvent({ ...event("future"), occurredAt: later }),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await append(db, "summary", "agent.memory.wiki.revision");
    await expect(
      db.knowledge.putEvent(event("summary")),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
  });

  it("freezes both event time and late recording and rejects mixed-scope claim or episode evidence", async () => {
    const db = await setup();
    const first = await put(db, "source-a");
    await put(db, "source-b", "scope-b");
    await put(db, "late-arrival");
    const frozen = await db.knowledge.recall({
      ...query(),
      recordedBefore: first.event.recordedAt,
    });
    expect(frozen.events.map((e) => e.sourceInformationId)).toEqual([
      "source-a",
    ]);
    expect(
      (await db.knowledge.recall(query("scope-b"))).events.map(
        (e) => e.sourceInformationId,
      ),
    ).toEqual(["source-b"]);
    expect(
      (
        await db.knowledge.recall({
          ...query(),
          occurredBefore: "2026-01-01T00:00:00.000Z",
        })
      ).events,
    ).toEqual([]);
    await expect(
      db.knowledge.appendClaim(claim("mixed", ["source-a", "source-b"])),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await expect(
      db.knowledge.putEpisode({
        episodeId: "mixed",
        scopeInformationId: "scope-a",
        title: "Trip",
        evidenceSourceInformationIds: ["source-a", "source-b"],
      }),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    const episode = {
      episodeId: "day",
      scopeInformationId: "scope-a",
      title: "Day",
      evidenceSourceInformationIds: ["source-a", "late-arrival"],
    };
    expect((await db.knowledge.putEpisode(episode)).created).toBe(true);
    expect((await db.knowledge.putEpisode(episode)).created).toBe(false);
  });

  it("rejects one speaker superseding or retracting another speaker's claim", async () => {
    const db = await setup();
    await put(db, "source-a");
    await put(db, "source-b");
    await db.knowledge.appendClaim(claim("alice-view", ["source-a"]));
    for (const relation of ["supersedesClaimId", "retractsClaimId"] as const) {
      await expect(
        db.knowledge.appendClaim({
          ...claim(`bob-${relation}`, ["source-b"], "coffee"),
          speakerInformationId: "bob",
          [relation]: "alice-view",
        }),
      ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    }
    await db.knowledge.appendClaim({
      ...claim("bob-view", ["source-b"], "coffee"),
      speakerInformationId: "bob",
    });
    expect(
      (await db.knowledge.recall(query())).claims.map((c) => c.claimId).sort(),
    ).toEqual(["alice-view", "bob-view"]);
  });

  it("preserves conflicting viewpoints and append-only supersession/retraction with full evidence", async () => {
    const db = await setup();
    await put(db, "source-a");
    await put(db, "source-b");
    const old = await db.knowledge.appendClaim(claim("old", ["source-a"]));
    expect(
      (await db.knowledge.appendClaim(claim("old", ["source-a"]))).created,
    ).toBe(false);
    await expect(
      db.knowledge.appendClaim(claim("old", ["source-b"])),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    await db.knowledge.appendClaim({
      ...claim("different", ["source-b"], "coffee"),
      speakerInformationId: "bob",
    });
    expect((await db.knowledge.recall(query())).reasons).toContain(
      "conflicting_claims_preserved",
    );
    await db.knowledge.appendClaim({
      ...claim("corrected", ["source-b"], "water"),
      supersedesClaimId: "old",
    });
    expect(
      (await db.knowledge.recall(query())).claims.map((c) => c.claimId).sort(),
    ).toEqual(["corrected", "different"]);
    expect(
      (
        await db.knowledge.recall({
          ...query(),
          recordedBefore: old.claim.recordedAt,
        })
      ).claims.map((c) => c.claimId),
    ).toEqual(["old"]);
    await db.knowledge.appendClaim({
      ...claim("withdraw", ["source-b"], ""),
      retractsClaimId: "corrected",
    });
    expect(
      (await db.knowledge.recall(query())).claims.map((c) => c.claimId),
    ).toEqual(["different"]);
    const bounded = await db.knowledge.recall({ ...query(), limit: 1 });
    expect(bounded.events.length).toBeLessThanOrEqual(1);
    expect(
      bounded.claims.every((c) =>
        c.evidenceSourceInformationIds.every((id) =>
          bounded.events.some((e) => e.sourceInformationId === id),
        ),
      ),
    ).toBe(true);
  });

  it("CAS protects immutable Wiki revisions, replays operations and refuses future/cross-scope evidence", async () => {
    const db = await setup();
    await put(db, "source-a");
    await put(db, "source-b", "scope-b");
    const input = await revision(db);
    await expect(
      db.knowledge.writeWikiRevision({
        ...input,
        sections: [
          { ...input.sections[0]!, evidenceSourceInformationIds: ["source-b"] },
        ],
      }),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    await expect(
      db.knowledge.writeWikiRevision({
        ...input,
        evidenceCutoff: { ...input.evidenceCutoff, recordedBefore: occurredAt },
      }),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    const saved = await db.knowledge.writeWikiRevision(input);
    expect(saved.version).toBe(1);
    expect(await db.knowledge.writeWikiRevision(input)).toEqual(saved);
    await expect(
      db.knowledge.writeWikiRevision({
        ...input,
        generatorVersion: "different",
      }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    await expect(
      db.knowledge.writeWikiRevision({ ...input, operationId: "stale" }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect((await db.knowledge.readWikiPage(input))!.latestRevision).toEqual(
      saved,
    );
    await put(db, "source-new");
    expect(
      (await db.knowledge.readWikiPage(input))!.latestRevision,
    ).toBeUndefined();
    await expect(
      db.knowledge.writeWikiRevision({
        ...input,
        operationId: "dirty-cas",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect(
      await db.knowledge.listWikiRevisions({ ...input, limit: 10 }),
    ).toEqual([saved]);
  });

  it("keeps old persistent claims ahead of recent chatter within a bounded evidence budget", async () => {
    const db = await setup();
    await put(db, "z-old-preference");
    await db.knowledge.appendClaim(claim("preference", ["z-old-preference"]));
    for (const id of ["a-chat", "b-chat", "c-chat"]) await put(db, id);
    const result = await db.knowledge.recall({ ...query(), limit: 2 });
    expect(result.claims.map((c) => c.claimId)).toEqual(["preference"]);
    expect(result.events.map((e) => e.sourceInformationId)).toContain(
      "z-old-preference",
    );
    expect(result.events).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.reasons).toContain("claims_before_recent_events");
  });

  it("blocks raw bypass for revoked sources even before knowledge projection", async () => {
    const db = await setup();
    await append(db, "unprojected", "core.message.inbound.text");
    await put(db, "available");
    expect(
      await db.knowledge.filterAvailableSourceIds({
        sourceInformationIds: ["unprojected", "available", "missing"],
      }),
    ).toEqual(["unprojected", "available"]);
    await db.knowledge.revokeSource({
      scopeInformationId: "scope-a",
      sourceInformationId: "unprojected",
      reason: "withdrawn before projection",
    });
    expect(
      await db.knowledge.filterAvailableSourceIds({
        sourceInformationIds: ["unprojected", "available"],
      }),
    ).toEqual(["available"]);
    await expect(
      db.knowledge.putEvent(event("unprojected")),
    ).rejects.toBeInstanceOf(KnowledgeEvidenceError);
    expect(
      await db.knowledge.filterAvailableSourceIds({
        scopeInformationId: "scope-b",
        sourceInformationIds: ["available"],
      }),
    ).toEqual([]);
  });

  it("replays identity invalidations without revoking later evidence", async () => {
    const db = await setup();
    await put(db, "old-source");
    const mutation = {
      operationId: "identity-revision",
      scopeInformationId: "scope-a",
      entityInformationId: "alice",
      reason: "corrected binding",
    };
    await db.knowledge.invalidateEntity(mutation);
    await put(db, "after-correction");
    const restarted = new KaguyaDatabase(db.sql);
    await restarted.knowledge.invalidateEntity(mutation);
    expect(
      await restarted.knowledge.filterAvailableSourceIds({
        sourceInformationIds: ["old-source", "after-correction"],
      }),
    ).toEqual(["after-correction"]);
    await expect(
      restarted.knowledge.invalidateEntity({
        ...mutation,
        entityInformationId: "bob",
      }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
  });

  it("persists revocation and identity invalidation across store restart without exposing stale Wiki", async () => {
    const db = await setup();
    await put(db, "source-a");
    await db.knowledge.appendClaim(claim("fact", ["source-a"]));
    const input = await revision(db);
    await db.knowledge.writeWikiRevision(input);
    await db.knowledge.revokeSource({
      scopeInformationId: "scope-b",
      sourceInformationId: "source-a",
      reason: "wrong scope",
    });
    expect((await db.knowledge.readWikiPage(input))!.dirty).toBe(false);
    await db.knowledge.revokeSource({
      scopeInformationId: "scope-a",
      sourceInformationId: "source-a",
      reason: "withdrawn",
    });
    const restarted = new KaguyaDatabase(db.sql);
    await restarted.prepareMemoryKnowledgeSchema();
    expect((await restarted.knowledge.readWikiPage(input))!.dirty).toBe(true);
    expect(
      (await restarted.knowledge.readWikiPage(input))!.latestRevision,
    ).toBeUndefined();
    expect((await restarted.knowledge.recall(query())).claims).toEqual([]);
    expect(
      await restarted.knowledge.getEvent("source-a", "scope-a"),
    ).toBeUndefined();
    await put(db, "second");
    await db.knowledge.appendClaim(claim("second-fact", ["second"]));
    await restarted.knowledge.invalidateEntity({
      operationId: "identity-mutation-1",
      scopeInformationId: "scope-a",
      entityInformationId: "alice",
      reason: "identity corrected",
    });
    expect((await db.knowledge.recall(query())).claims).toEqual([]);
    expect(
      (await db.knowledge.listDirtyPages({ limit: 10 })).every((p) =>
        p.reasons.includes("identity_revised"),
      ),
    ).toBe(true);
  });
});
