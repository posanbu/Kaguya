/**
 * 功能概述：用真实隔离数据库验证录入任务、证据、去重、身份澄清、修订及契约升级。
 * 主要职责：直接等待提交/事务完成，不以固定休眠代替持久化；跨仓储实例恢复冻结计划并检查唯一副作用。
 * 代码库关系：同一契约同时由 PGlite 和可选 PostgreSQL 执行，复用生产 Information 与 Memory 表。
 * 输入输出与副作用：每例创建独立数据库，afterEach 关闭；只有合成原文和身份，不使用真实模型或配置。
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "./testing.js";
import { PostgresMemoryIngestionStore } from "./memory-ingestion.js";
import type { KaguyaDatabase } from "./index.js";
import {
  USER_STATEMENT_KIND,
  USER_INPUT_KIND,
  USER_SUBJECT_KIND,
  USER_MEMORY_SCOPE_KIND,
  GLOBAL_MEMORY_SCOPE_ID,
  type MemoryIngestionPlan,
  type MemoryIngestionSubmission,
} from "@kaguya/schema";

const cleanup: KaguyaDatabase[] = [];
afterEach(async () => {
  for (const db of cleanup.splice(0)) await db.close();
});
const text = "小夏喜欢天文，和小林是从小认识的朋友。她不太喜欢咖啡。";
function submission(
  overrides: Partial<MemoryIngestionSubmission> = {},
): MemoryIngestionSubmission {
  return {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
    sourceType: "character_setting",
    text,
    resolutions: [],
    targetClaimId: null,
    ...overrides,
  };
}
function plan(): MemoryIngestionPlan {
  return {
    version: 2,
    subjects: [
      {
        key: "xia",
        label: "小夏",
        existingEntityId: null,
        evidenceQuote: "小夏",
      },
      {
        key: "lin",
        label: "小林",
        existingEntityId: null,
        evidenceQuote: "小林",
      },
    ],
    claims: [
      {
        subjectKey: "xia",
        predicate: "喜好",
        value: "天文",
        objectSubjectKey: null,
        evidenceQuote: "小夏喜欢天文",
        epistemic: "assertion",
        supersedesClaimId: null,
        supplementsClaimId: null,
        validFrom: null,
        validTo: null,
      },
      {
        subjectKey: "xia",
        predicate: "朋友",
        value: "从小认识的朋友",
        objectSubjectKey: "lin",
        evidenceQuote: "和小林是从小认识的朋友",
        epistemic: "assertion",
        supersedesClaimId: null,
        supplementsClaimId: null,
        validFrom: null,
        validTo: null,
      },
    ],
    questions: [],
    unprocessed: ["咖啡偏好等待更明确的主体说明"],
  };
}
function contract(create: () => Promise<KaguyaDatabase>) {
  async function fixture() {
    const db = await create();
    cleanup.push(db);
    await db.prepareSchema();
    await db.prepareMemoryKnowledgeSchema();
    await db.information.synchronizeKinds([
      USER_STATEMENT_KIND,
      USER_INPUT_KIND,
      USER_SUBJECT_KIND,
      USER_MEMORY_SCOPE_KIND,
      "agent.chat.scope.entity",
      "agent.person.entity",
      "agent.person.observed",
      "agent.platform.account.entity",
      "agent.platform.account.binding",
    ]);
    const store = new PostgresMemoryIngestionStore(db.sql);
    const apply = async (input: MemoryIngestionSubmission, output = plan()) => {
      await store.submit(input);
      const claim = (await store.claim())!;
      await store.savePlan(claim, output);
      return store.apply(claim);
    };
    return { db, store, apply };
  }
  it("persists original input, entities, relationships and Wiki, and deduplicates transport and semantic replay", async () => {
    const f = await fixture();
    const input = submission();
    const queued = await f.store.submit(input);
    expect(queued.status).toBe("queued");
    expect(await f.store.submit(input)).toEqual(queued);
    await expect(
      f.store.submit({ ...input, text: "different" }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
    const claim = (await f.store.claim())!;
    await f.store.savePlan(claim, plan());
    const result = await f.store.apply(claim);
    expect(result.status).toBe("partial");
    expect(result.results.filter((r) => r.claimId)).toHaveLength(2);
    const count = await f.db.sql.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM memory_knowledge_claims",
    );
    expect(count.rows[0]!.count).toBe(2);
    const newStore = new PostgresMemoryIngestionStore(f.db.sql);
    expect(await newStore.list(input.sessionId)).toEqual([result]);
    const source = await f.db.information.get(`user-input:${input.requestId}`);
    expect(source?.payload).toMatchObject({
      text,
      submitter: "webui:management",
      sourceType: "character_setting",
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
    });
    const subject = result.results.find((r) => r.label === "小夏")!;
    const wiki = await f.db.knowledge.readWikiPage({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      entityInformationId: subject.entityInformationId!,
    });
    expect(wiki?.dirty).toBe(false);
    expect(wiki?.latestRevision?.sections).toHaveLength(2);
    const duplicate = await f.apply(submission());
    expect(duplicate.results.filter((r) => r.status === "new")).toHaveLength(0);
    expect(duplicate.results.filter((r) => r.status === "linked")).toHaveLength(
      4,
    );
    const counts = await f.db.sql.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM memory_knowledge_claims",
    );
    expect(counts.rows[0]!.count).toBe(2);
  });
  it("matches native display names through account bindings instead of a shared raw account number", async () => {
    const f = await fixture();
    const input = submission();
    const job = await f.store.submit(input);
    const append = async (
      informationId: string,
      kind: string,
      payload: Record<string, string>,
      references: { relation: string; informationId: string }[] = [],
    ) =>
      f.db.information.append(
        {
          informationId,
          kind,
          payload,
          occurredAt: "2026-01-01T00:00:00Z",
          source: "test",
          references,
        },
        references.map((r) => ({
          relation: r.relation,
          required: true,
          multiple: false,
        })),
      );
    await append("native-person", "agent.person.entity", { accountId: "100" }, [
      { relation: "agent:scope", informationId: GLOBAL_MEMORY_SCOPE_ID },
    ]);
    for (const [account, person, nickname] of [
      ["qq-account", "native-person", "小林"],
      ["other-account", "other-person", "不相关的人"],
    ]) {
      await append(account!, "agent.platform.account.entity", {
        accountId: "100",
      });
      await append(
        `${account}-binding`,
        "agent.platform.account.binding",
        { accountId: "100", personInformationId: person! },
        [{ relation: "core:binds", informationId: account! }],
      );
      await append(
        `${account}-observed`,
        "agent.person.observed",
        { accountId: "100", nickname: nickname! },
        [{ relation: "core:observes", informationId: account! }],
      );
    }
    expect((await f.store.context(job)).candidates).toEqual([
      {
        entityInformationId: "native-person",
        label: "小林",
        description: "100",
      },
    ]);
  });
  it("holds ambiguous identities for an explicit choice and keeps clarification context", async () => {
    const f = await fixture();
    const input = submission();
    await f.store.submit(input);
    for (const id of ["lin-a", "lin-b"])
      await f.db.information.append(
        {
          informationId: id,
          kind: USER_SUBJECT_KIND,
          occurredAt: "2026-01-01T00:00:00Z",
          source: "test:seed",
          payload: {
            label: "小林",
            scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
          },
          references: [
            { relation: "agent:scope", informationId: GLOBAL_MEMORY_SCOPE_ID },
          ],
        },
        [{ relation: "agent:scope", required: true, multiple: false }],
      );
    const claim = (await f.store.claim())!;
    const guessed = plan();
    guessed.subjects[1]!.existingEntityId = "lin-a";
    await f.store.savePlan(claim, guessed);
    const held = await f.store.apply(claim);
    expect(held.status).toBe("clarification");
    expect(held.ambiguities[0]?.candidates).toHaveLength(2);
    expect(
      (await f.db.sql.query("SELECT * FROM memory_knowledge_claims")).rows,
    ).toHaveLength(0);
    const next = submission({
      sessionId: input.sessionId,
      text: "就是列表中第一个小林。",
      resolutions: [{ label: "小林", entityInformationId: "lin-a" }],
    });
    const result = await f.apply(next, guessed);
    expect(result.status).toBe("partial");
    expect(
      result.results.find((r) => r.label === "小林")?.entityInformationId,
    ).toBe("lin-a");
    expect(
      result.results
        .filter((r) => r.claimId)
        .every(
          (r) => r.sourceInformationId === `user-input:${input.requestId}`,
        ),
    ).toBe(true);
  });
  it("revises instead of overwriting, preserves old provenance and refreshes Wiki", async () => {
    const f = await fixture();
    const original = await f.apply(submission());
    const old = original.results.find(
      (r) => r.claimId && r.label.includes("喜好"),
    )!;
    const revised = plan();
    revised.subjects = [revised.subjects[0]!];
    revised.claims = [
      {
        ...revised.claims[0]!,
        value: "绘画",
        evidenceQuote: "小夏现在喜欢绘画",
        supersedesClaimId: old.claimId!,
      },
    ];
    revised.unprocessed = [];
    const result = await f.apply(
      submission({ text: "更正：小夏现在喜欢绘画，不再喜欢天文。" }),
      revised,
    );
    expect(result.status).toBe("succeeded");
    expect(result.results.find((r) => r.claimId)?.status).toBe("revised");
    const cutoff = new Date().toISOString();
    const recall = await f.db.knowledge.recall({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      entityInformationId: old.entityInformationId,
      occurredBefore: cutoff,
      recordedBefore: cutoff,
      limit: 100,
    });
    expect(
      recall.claims.filter((c) => c.predicate === "喜好").map((c) => c.value),
    ).toEqual(["绘画"]);
    const obsolete = await f.db.knowledge.recall({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      query: "天文",
      occurredBefore: cutoff,
      recordedBefore: cutoff,
      limit: 100,
    });
    expect(obsolete.events).toHaveLength(0);
    expect(obsolete.claims).toHaveLength(0);
    expect(
      (
        await f.db.sql.query(
          "SELECT * FROM memory_knowledge_claims WHERE claim_id=$1",
          [old.claimId],
        )
      ).rows,
    ).toHaveLength(1);
    const wiki = await f.db.knowledge.readWikiPage({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      entityInformationId: old.entityInformationId!,
    });
    expect(
      wiki?.latestRevision?.sections.some((s) => s.content.includes("绘画")),
    ).toBe(true);
  });
  it("clarifies a conflicting value and accepts an explicit supplement without retiring the old value", async () => {
    const f = await fixture();
    const original = await f.apply(submission());
    const old = original.results.find(
      (r) => r.claimId && r.label.includes("喜好"),
    )!;
    const addition = plan();
    addition.subjects = [addition.subjects[0]!];
    addition.claims = [
      { ...addition.claims[0]!, value: "绘画", evidenceQuote: "小夏喜欢绘画" },
    ];
    addition.unprocessed = [];
    const input = submission({ text: "小夏喜欢绘画" });
    expect((await f.apply(input, addition)).status).toBe("clarification");
    addition.claims[0]!.supplementsClaimId = old.claimId!;
    expect(
      (
        await f.apply(
          submission({
            sessionId: input.sessionId,
            text: "这是补充，保留之前的喜好。",
          }),
          addition,
        )
      ).status,
    ).toBe("succeeded");
    const cutoff = new Date().toISOString();
    const recalled = await f.db.knowledge.recall({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      entityInformationId: old.entityInformationId,
      occurredBefore: cutoff,
      recordedBefore: cutoff,
      limit: 100,
    });
    expect(
      recalled.claims
        .filter((c) => c.predicate === "喜好")
        .map((c) => c.value)
        .sort(),
    ).toEqual(["天文", "绘画"]);
    addition.claims[0]!.supplementsClaimId = null;
    addition.claims[0]!.supersedesClaimId = old.claimId!;
    const revision = await f.apply(
      submission({ text: "更正：小夏喜欢绘画，不再喜欢天文。" }),
      addition,
    );
    expect(revision.results.find((r) => r.claimId)?.status).toBe("revised");
    const after = new Date().toISOString();
    const obsolete = await f.db.knowledge.recall({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      query: "天文",
      occurredBefore: after,
      recordedBefore: after,
      limit: 100,
    });
    expect(obsolete.claims).toHaveLength(0);
    expect(obsolete.events).toHaveLength(0);
  });
  it("does not queue a failed task while the same session is processing", async () => {
    const f = await fixture();
    const input = submission();
    await f.store.submit(input);
    const claimed = (await f.store.claim())!;
    await f.store.fail(claimed, "model_retryable");
    await f.store.submit(
      submission({ sessionId: input.sessionId, text: "补充说明" }),
    );
    await expect(f.store.retry(input.requestId)).rejects.toMatchObject({
      code: "session_busy",
    });
    expect((await f.store.get(input.requestId)).status).toBe("failed");
  });
  it("rolls back an invalid plan and makes unsupported evidence regeneratable", async () => {
    const f = await fixture();
    const input = submission();
    await f.store.submit(input);
    const claim = (await f.store.claim())!;
    const invalid = plan();
    invalid.claims[1]!.subjectKey = "foreign";
    await f.store.savePlan(claim, invalid);
    await expect(f.store.apply(claim)).rejects.toMatchObject({
      code: "unknown_subject",
    });
    for (const table of [
      "memory_knowledge_events",
      "memory_knowledge_claims",
      "memory_knowledge_wiki_pages",
    ])
      expect(
        (await f.db.sql.query(`SELECT * FROM ${table}`)).rows,
      ).toHaveLength(0);
    expect(
      await f.db.information.get(`user-input:${input.requestId}`),
    ).toBeUndefined();
    await f.store.fail(claim, "unknown_subject");
    await f.store.retry(input.requestId);
    const retried = (await f.store.claim())!;
    expect(retried.plan).toBeNull();
    const badQuote = plan();
    badQuote.claims[0]!.evidenceQuote = "没有出现的原文";
    await f.store.savePlan(retried, badQuote);
    await expect(f.store.apply(retried)).rejects.toMatchObject({
      code: "unsupported_evidence",
    });
  });
  it("lists global records across sessions and deletes/restores without recalling removed evidence", async () => {
    const f = await fixture();
    await f.apply(submission());
    const records = await new PostgresMemoryIngestionStore(f.db.sql).records(
      "天文",
    );
    expect(records.hasMore).toBe(false);
    expect(records.records).toHaveLength(1);
    const saved = records.records[0]!;
    expect(saved).toMatchObject({
      subjectLabel: "小夏",
      predicate: "喜好",
      value: "天文",
      deleted: false,
    });
    const operation = {
      operationId: randomUUID(),
      claimId: saved.claimId,
      action: "delete",
    };
    const deleted = await f.store.mutateRecord(operation);
    expect(deleted.deleted).toBe(true);
    expect(await f.store.mutateRecord(operation)).toEqual(deleted);
    await expect(
      f.store.mutateRecord({ ...operation, action: "restore" }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
    await expect(
      f.store.mutateRecord({ ...operation, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "record_changed" });
    const recall = () => {
      const cutoff = new Date().toISOString();
      return f.db.knowledge.recall({
        scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
        entityInformationId: saved.subjectInformationId,
        occurredBefore: cutoff,
        recordedBefore: cutoff,
        limit: 100,
      });
    };
    const afterDelete = await recall();
    expect(afterDelete.claims.map((c) => c.predicate)).toEqual(["朋友"]);
    expect(afterDelete.events.map((e) => e.content).join(" ")).not.toContain(
      "喜欢天文",
    );
    const wiki = await f.db.knowledge.readWikiPage({
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      entityInformationId: saved.subjectInformationId,
    });
    expect(wiki?.latestRevision?.sections.map((s) => s.heading)).toEqual([
      "朋友",
    ]);
    expect((await f.store.records("天文")).records).toEqual([deleted]);
    const restore = {
      operationId: randomUUID(),
      claimId: deleted.claimId,
      action: "restore",
    };
    const restored = await f.store.mutateRecord(restore);
    expect(restored).toMatchObject({ value: "天文", deleted: false });
    expect(await f.store.mutateRecord(restore)).toEqual(restored);
    expect((await recall()).claims).toHaveLength(2);
    expect((await f.store.records("天文")).records).toEqual([restored]);
    await expect(
      f.store.mutateRecord({
        ...operation,
        operationId: randomUUID(),
        claimId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "record_changed" });
  });
  it("modifies only the selected record using a new instruction and rejects stale targets", async () => {
    const f = await fixture();
    await f.apply(submission());
    const target = (await f.store.records("天文")).records[0]!;
    // 记录按钮已明确选择主体，即使存在同名人物也不应再次要求身份选择。
    await f.db.information.append(
      {
        informationId: "another-xia",
        kind: USER_SUBJECT_KIND,
        occurredAt: "2026-01-01T00:00:00Z",
        source: "test:seed",
        payload: { label: "小夏", scopeInformationId: GLOBAL_MEMORY_SCOPE_ID },
        references: [
          { relation: "agent:scope", informationId: GLOBAL_MEMORY_SCOPE_ID },
        ],
      },
      [{ relation: "agent:scope", required: true, multiple: false }],
    );
    const input = submission({
      text: "把喜好改成绘画。",
      targetClaimId: target.claimId,
    });
    await f.store.submit(input);
    const claimed = (await f.store.claim())!;
    expect((await f.store.context(claimed.job)).targetClaim?.claimId).toBe(
      target.claimId,
    );
    const edit: MemoryIngestionPlan = {
      version: 2,
      subjects: [
        {
          key: "xia",
          label: "小夏",
          existingEntityId: target.subjectInformationId,
          evidenceQuote: input.text,
        },
      ],
      claims: [
        {
          ...plan().claims[0]!,
          value: "绘画",
          evidenceQuote: input.text,
          supersedesClaimId: target.claimId,
        },
      ],
      questions: [],
      unprocessed: [],
    };
    await f.store.savePlan(claimed, edit);
    const result = await f.store.apply(claimed);
    expect(result.results.find((r) => r.status === "revised")).toMatchObject({
      supersedesClaimId: target.claimId,
    });
    const current = (await f.store.records()).records;
    expect(current.map((r) => r.value).sort()).toEqual(
      ["从小认识的朋友", "绘画"].sort(),
    );
    const nextTarget = current.find((r) => r.predicate === "喜好")!;
    await f.store.submit(
      submission({
        text: "把喜好改成音乐。",
        targetClaimId: nextTarget.claimId,
      }),
    );
    const pending = (await f.store.claim())!;
    await f.store.savePlan(pending, {
      ...edit,
      claims: [
        {
          ...edit.claims[0]!,
          evidenceQuote: "把喜好改成音乐。",
          value: "音乐",
          supersedesClaimId: nextTarget.claimId,
        },
      ],
      subjects: [{ ...edit.subjects[0]!, evidenceQuote: "把喜好改成音乐。" }],
    });
    await f.store.mutateRecord({
      operationId: randomUUID(),
      claimId: nextTarget.claimId,
      action: "delete",
    });
    await expect(f.store.apply(pending)).rejects.toMatchObject({
      code: "record_changed",
    });
    expect(
      (await f.store.records()).records.find((r) => r.predicate === "喜好"),
    ).toMatchObject({ deleted: true, value: "绘画" });
  });
  it("does not let a delayed untargeted plan resurrect deleted evidence", async () => {
    const f = await fixture();
    await f.apply(submission());
    const target = (await f.store.records("天文")).records[0]!;
    await f.store.submit(submission());
    const pending = (await f.store.claim())!;
    await f.store.savePlan(pending, plan());
    await f.store.mutateRecord({
      operationId: randomUUID(),
      claimId: target.claimId,
      action: "delete",
    });
    await expect(f.store.apply(pending)).rejects.toMatchObject({
      code: "record_changed",
    });
    expect((await f.store.records("天文")).records).toMatchObject([
      { deleted: true },
    ]);
    // 明确的新指令可以重新录入，旧任务的原文不行。
    await f.apply(submission());
    expect(
      (await f.store.records("天文")).records.filter((r) => !r.deleted),
    ).toHaveLength(1);
  });
  it("recovers an expired lease with its frozen plan and rejects stale worker writes", async () => {
    const f = await fixture();
    const input = submission();
    await f.store.submit(input);
    const abandoned = (await f.store.claim())!;
    await f.store.savePlan(abandoned, plan());
    await f.db.sql.query(
      "UPDATE memory_ingestion_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE request_id=$1",
      [input.requestId],
    );
    await expect(f.store.apply(abandoned)).rejects.toMatchObject({
      code: "lease_lost",
    });
    const restored = new PostgresMemoryIngestionStore(f.db.sql);
    const resumed = (await restored.claim())!;
    expect(resumed.plan).toEqual(plan());
    expect(resumed.job.attempt).toBe(2);
    await expect(f.store.apply(abandoned)).rejects.toMatchObject({
      code: "lease_lost",
    });
    await restored.apply(resumed);
    expect(
      (await f.db.sql.query("SELECT * FROM memory_knowledge_claims")).rows,
    ).toHaveLength(2);
  });
  it("rejects incompatible jobs, scope changes, injected fields and foreign entity references", async () => {
    const f = await fixture();
    const input = submission();
    await expect(
      f.store.submit({ ...input, sql: "DROP TABLE" }),
    ).rejects.toMatchObject({ code: "invalid_submission" });
    await f.store.submit(input);
    await expect(
      f.store.submit({
        ...submission(),
        sessionId: input.sessionId,
        scopeInformationId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "invalid_submission" });
    await f.db.sql.query(
      "UPDATE memory_ingestion_jobs SET contract_version=0 WHERE request_id=$1",
      [input.requestId],
    );
    expect(await f.store.claim()).toBeUndefined();
    expect(await f.store.get(input.requestId)).toMatchObject({
      status: "failed",
      errorCode: "incompatible_contract",
    });
    await expect(f.store.retry(input.requestId)).rejects.toMatchObject({
      code: "incompatible_contract",
    });
    const other = submission();
    await f.store.submit(other);
    const claimed = (await f.store.claim())!;
    const foreign = plan();
    foreign.subjects[0]!.existingEntityId = "does-not-exist";
    await f.store.savePlan(claimed, foreign);
    await expect(f.store.apply(claimed)).rejects.toMatchObject({
      code: "foreign_entity",
    });
  });
}
describe("memory ingestion persistence", () => contract(createTestingDatabase));
const postgresUrl = process.env.KAGUYA_TEST_DATABASE_URL;
describe.skipIf(!postgresUrl)("memory ingestion PostgreSQL contract", () =>
  contract(() => createPostgresTestingDatabase(postgresUrl!)),
);
