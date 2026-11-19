import { describe, expect, it } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "./testing.js";
import { PostgresContinuityStore } from "./continuity-store.js";
import { randomUUID } from "node:crypto";

const pg = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !pg)
  throw new Error("PostgreSQL test URL required");
const factories = [
  ["PGlite", createTestingDatabase],
  ...(pg
    ? ([["PostgreSQL", () => createPostgresTestingDatabase(pg)]] as const)
    : []),
] as const;
const policy = {
  version: "small.v1",
  enabled: true,
  timeZone: "Asia/Shanghai",
  dailyModelCalls: 24,
  subjectiveTtlMs: 1800000,
};
const subjective = {
  attention: ["reading"],
  interests: [{ topic: "月球", reason: "好奇" }],
  appraisal: "想继续阅读",
  social: "focused" as const,
};

for (const [name, factory] of factories)
  describe(`continuity ${name}`, () => {
    it("shares the main slot with chat tools, resumes the saved point and preserves a later manual pause", async () => {
      const db = await factory();
      try {
        await db.prepareSchema();
        const store = new PostgresContinuityStore(db.sql);
        await store.configure({
          agentId: "kaguya",
          operationId: "config",
          expectedRevision: 0,
          policy,
          basis: [],
        });
        const initial = (await store.read("kaguya", "shared"))!,
          source = initial.policyInformationId;
        let a = await store.create({
          agentId: "kaguya",
          operationId: "create",
          expectedRevision: 1,
          activity: {
            id: "reading",
            scope: "private:a",
            kind: "plan",
            title: "私人阅读正文",
            goal: "保存笔记",
            nextStep: "从第二页继续",
            sources: [source],
          },
        });
        a = await store.change({
          agentId: "kaguya",
          operationId: "start",
          expectedRevision: a.revision,
          activityId: a.id,
          change: { state: "active", completedSteps: ["已读第一页"] },
          basis: [source],
        });
        const f = await store.freeze({
          agentId: "kaguya",
          scope: a.scope,
          operationId: "execution",
          activityId: a.id,
          basis: [source],
        });
        await store.executionGate("kaguya", a.id, f.informationId, "enter");
        const chat = await db.nativeTools.open(
          "chat",
          {
            scope: "private:b",
            deadline: new Date(Date.now() + 300000).toISOString(),
            origin: {
              instanceId: "heavy",
              definitionId: "agent.heavy",
              taskId: "agent.heavy.respond",
              sourceInformationId: source,
            },
          },
          initial.contextInformationId,
          [source],
        );
        expect(await store.claimChat(chat.run_id, "private:b")).toBe(false);
        expect(
          (await store.read("kaguya", a.scope))?.activities[0],
        ).toMatchObject({
          state: "active",
          requestedState: "paused",
          suspension: "chat",
          interruptedBy: chat.run_id,
        });
        expect(
          await store.executionGate(
            "kaguya",
            a.id,
            f.informationId,
            "checkpoint",
          ),
        ).toBe(false);
        expect(await store.claimChat(chat.run_id, "private:b")).toBe(true);
        expect(await store.read("kaguya", "private:b")).toMatchObject({
          busy: true,
          mainWorkKind: "request",
          activities: [],
          mainActivityId: null,
        });
        a = (await store.read("kaguya", a.scope))!.activities[0]!;
        await expect(
          store.change({
            agentId: "kaguya",
            operationId: "too-early",
            expectedRevision: a.revision,
            activityId: a.id,
            change: { state: "active" },
            basis: [source],
          }),
        ).rejects.toThrow("main-slot-busy");
        await store.releaseChat(chat.run_id);
        a = (await store.read("kaguya", a.scope))!.activities[0]!;
        expect(a).toMatchObject({
          state: "waiting",
          suspension: null,
          interruptedBy: null,
          nextStep: "从第二页继续",
          completedSteps: ["已读第一页"],
        });
        expect((await store.read("kaguya", a.scope))?.budget.used).toBe(0);
        a = await store.change({
          agentId: "kaguya",
          operationId: "continue",
          expectedRevision: a.revision,
          activityId: a.id,
          change: { state: "active" },
          basis: [source],
        });
        expect(await store.claimChat(chat.run_id, "private:b")).toBe(true);
        a = (await store.read("kaguya", a.scope))!.activities[0]!;
        await store.change({
          agentId: "kaguya",
          operationId: "control:manual-pause",
          expectedRevision: a.revision,
          activityId: a.id,
          change: { state: "paused" },
          basis: [source],
        });
        await store.releaseChat(chat.run_id);
        expect(
          (await store.read("kaguya", a.scope))?.activities[0]?.state,
        ).toBe("paused");
        expect(await store.claimChat(chat.run_id, "private:b")).toBe(true);
        const afterRestart = new PostgresContinuityStore(
          db.sql,
          () => new Date(Date.now() + 360000),
        );
        await afterRestart.recoverCoordination();
        expect(
          (await afterRestart.read("kaguya", a.scope))?.mainWorkKind,
        ).toBeNull();
        expect(
          (await afterRestart.read("kaguya", a.scope))?.activities[0]?.state,
        ).toBe("paused");
        expect(
          JSON.stringify(await store.read("kaguya", "private:b")),
        ).not.toContain("私人阅读正文");
      } finally {
        await db.close();
      }
    });
    it("pauses at a durable safe boundary and disabling admission does not erase progress", async () => {
      const db = await factory();
      try {
        await db.prepareSchema();
        const store = new PostgresContinuityStore(db.sql);
        await store.configure({
          agentId: "a",
          operationId: "config",
          expectedRevision: 0,
          policy,
          basis: [],
        });
        const source = (await store.read("a", "shared"))!.policyInformationId;
        let a = await store.create({
          agentId: "a",
          operationId: "create",
          expectedRevision: 1,
          activity: {
            id: "read",
            scope: "private:a",
            kind: "plan",
            title: "阅读",
            goal: "保存笔记",
            sources: [source],
          },
        });
        a = await store.change({
          agentId: "a",
          operationId: "start",
          expectedRevision: a.revision,
          activityId: a.id,
          change: {
            state: "active",
            completedSteps: ["已读第一页"],
            nextStep: "第二页",
          },
          basis: [source],
        });
        const f = await store.freeze({
          agentId: "a",
          scope: a.scope,
          operationId: "execution",
          activityId: a.id,
          basis: [source],
        });
        expect(
          await store.executionGate("a", a.id, f.informationId, "enter"),
        ).toBe(true);
        a = (await store.read("a", a.scope))!.activities[0]!;
        const pending = await store.change({
          agentId: "a",
          operationId: "pause",
          expectedRevision: a.revision,
          activityId: a.id,
          change: { state: "paused" },
          basis: [source],
        });
        expect(pending).toMatchObject({
          state: "active",
          requestedState: "paused",
          inFlight: f.informationId,
        });
        expect(
          await store.executionGate("a", a.id, f.informationId, "checkpoint"),
        ).toBe(false);
        a = (await store.read("a", a.scope))!.activities[0]!;
        expect(a).toMatchObject({
          state: "paused",
          requestedState: null,
          inFlight: null,
          completedSteps: ["已读第一页"],
          nextStep: "第二页",
        });
        expect((await store.read("a", "shared"))?.busy).toBe(false);
        const view = (await store.read("a", a.scope))!;
        await store.configure({
          agentId: "a",
          operationId: "disable",
          expectedRevision: view.revision,
          policy: { ...policy, enabled: false },
          basis: [source],
        });
        expect(
          (
            await store.charge({
              agentId: "a",
              operationId: "disabled-call",
              purpose: "execution",
              basis: [source],
            })
          ).allowed,
        ).toBe(false);
        await expect(
          store.change({
            agentId: "a",
            operationId: "disabled-start",
            expectedRevision: a.revision,
            activityId: a.id,
            change: { state: "active" },
            basis: [source],
          }),
        ).rejects.toThrow("autonomy-disabled");
        expect((await store.read("a", a.scope))!.activities[0]?.nextStep).toBe(
          "第二页",
        );
      } finally {
        await db.close();
      }
    });
    it("persists daily calls across restart, deduplicates operations and uses the agent day", async () => {
      const db = await factory();
      try {
        await db.prepareSchema();
        let now = new Date("2026-11-12T15:59:00Z");
        const store = new PostgresContinuityStore(db.sql, () => now);
        await store.configure({
          agentId: "a",
          operationId: "config",
          expectedRevision: 0,
          policy,
          basis: [],
        });
        const calls = await Promise.all(
          Array.from({ length: 26 }, (_, i) =>
            store.charge({
              agentId: "a",
              operationId: `call:${i}`,
              purpose: "appraisal",
              basis: [],
            }),
          ),
        );
        expect(calls.filter((c) => c.allowed)).toHaveLength(24);
        const resumed = new PostgresContinuityStore(db.sql, () => now);
        expect(
          (
            await resumed.charge({
              agentId: "a",
              operationId: "call:0",
              purpose: "appraisal",
              basis: [],
            })
          ).allowed,
        ).toBe(true);
        expect((await resumed.read("a", "shared"))?.budget).toMatchObject({
          day: "2026-11-12",
          used: 24,
          remaining: 0,
        });
        await expect(
          resumed.charge({
            agentId: "a",
            operationId: "call:0",
            purpose: "retry",
            basis: [],
          }),
        ).rejects.toThrow("operation-conflict");
        const beforeZone = (await resumed.read("a", "shared"))!;
        await resumed.configure({
          agentId: "a",
          operationId: "change-timezone",
          expectedRevision: beforeZone.revision,
          policy: { ...policy, timeZone: "UTC", version: "small.zone.v2" },
          basis: [beforeZone.policyInformationId],
        });
        expect((await resumed.read("a", "shared"))?.budget.remaining).toBe(0);
        const utc = (await resumed.read("a", "shared"))!;
        await resumed.configure({
          agentId: "a",
          operationId: "restore-timezone",
          expectedRevision: utc.revision,
          policy: { ...policy, version: "small.zone.v3" },
          basis: [utc.policyInformationId],
        });
        now = new Date("2026-11-12T16:00:00Z");
        expect(
          (
            await resumed.charge({
              agentId: "a",
              operationId: "tomorrow",
              purpose: "choice",
              basis: [],
            })
          ).allowed,
        ).toBe(true);
        expect((await resumed.read("a", "shared"))?.budget).toMatchObject({
          day: "2026-11-13",
          used: 1,
        });
      } finally {
        await db.close();
      }
    });
    it("expires subjective fields without inventing an appraisal and freezes immutable scoped views", async () => {
      const db = await factory();
      try {
        await db.prepareSchema();
        let now = new Date("2026-11-13T00:00:00Z");
        const store = new PostgresContinuityStore(db.sql, () => now);
        await store.configure({
          agentId: "a",
          operationId: "config",
          expectedRevision: 0,
          policy,
          basis: [],
        });
        const config = (
          await db.sql.query<{ information_id: string }>(
            "SELECT information_id FROM information_atoms WHERE kind='agent.continuity.policy.v1'",
          )
        ).rows[0]!.information_id;
        const { informationId: cause } = await store.internalSource({
          operationId: "seed",
          source: {
            agentId: "a",
            ownerId: "self:kaguya",
            scope: "shared",
            type: "persona-seed",
            text: "对月球好奇",
            basis: [config],
            occurredAt: now.toISOString(),
          },
        });
        // Import requires a real persisted basis, not the operation's display name.
        expect(cause).toBeTruthy();
        const state = await store.evaluate({
          agentId: "a",
          operationId: "state",
          expectedRevision: 1,
          scope: "private:a",
          subjective,
          basis: [cause],
        });
        const frozen = await store.freeze({
          agentId: "a",
          operationId: "freeze",
          scope: "private:a",
          basis: [cause],
        });
        expect(frozen.view.state?.informationId).toBe(state.informationId);
        expect((await store.read("a", "other"))?.state).toBeNull();
        now = new Date(now.getTime() + 1800000);
        expect((await store.read("a", "private:a"))?.stateValidity).toBe(
          "expired",
        );
        expect(
          (
            await store.freeze({
              agentId: "a",
              operationId: "freeze",
              scope: "private:a",
              basis: [cause],
            })
          ).view.stateValidity,
        ).toBe("current");
        await expect(
          store.evaluate({
            agentId: "a",
            operationId: "forged",
            expectedRevision: 2,
            scope: "shared",
            subjective: { ...subjective, budget: 100 } as typeof subjective,
            basis: [cause],
          }),
        ).rejects.toThrow();
      } finally {
        await db.close();
      }
    });
    it("coordinates a single main slot, requires safe pause, preserves history and late results", async () => {
      const db = await factory();
      try {
        await db.prepareSchema();
        const store = new PostgresContinuityStore(db.sql);
        const configId = await store.configure({
          agentId: "a",
          operationId: "config",
          expectedRevision: 0,
          policy,
          basis: [],
        });
        const source = (
          await db.sql.query<{ information_id: string }>(
            "SELECT information_id FROM information_atoms WHERE kind='agent.continuity.policy.v1'",
          )
        ).rows[0]!.information_id;
        expect(configId).toBe(1);
        const make = (id: string, expectedRevision: number, scope: string) =>
          store.create({
            agentId: "a",
            operationId: `create:${id}`,
            expectedRevision,
            activity: {
              id,
              scope,
              kind: "plan",
              title: "阅读",
              goal: "读资料并保存笔记",
              sources: [source],
              nextStep: "打开资料",
            },
          });
        const a = await make("a1", 1, "private:a");
        const b = await make("a2", 2, "shared");
        const active = await store.change({
          agentId: "a",
          operationId: "start",
          expectedRevision: a.revision,
          activityId: a.id,
          change: { state: "active" },
          basis: [source],
        });
        await expect(
          store.change({
            agentId: "a",
            operationId: "race",
            expectedRevision: b.revision,
            activityId: b.id,
            change: { state: "active" },
            basis: [source],
          }),
        ).rejects.toThrow("main-slot-busy");
        expect(await store.read("a", "other")).toMatchObject({
          busy: true,
          mainActivityId: null,
          activities: [expect.objectContaining({ id: "a2" })],
        });
        const paused = await store.change({
          agentId: "a",
          operationId: "pause",
          expectedRevision: active.revision,
          activityId: a.id,
          change: {
            state: "paused",
            nextStep: "第二页",
            completedSteps: ["读过第一页"],
          },
          basis: [source],
        });
        await expect(
          store.change({
            agentId: "a",
            operationId: "stale",
            expectedRevision: active.revision,
            activityId: a.id,
            change: { state: "active" },
            basis: [source],
          }),
        ).rejects.toThrow("revision-conflict");
        const abandoned = await store.change({
          agentId: "a",
          operationId: "abandon",
          expectedRevision: paused.revision,
          activityId: a.id,
          change: { state: "abandoned" },
          basis: [source],
        });
        await expect(
          store.change({
            agentId: "a",
            operationId: "resume-abandoned",
            expectedRevision: abandoned.revision,
            activityId: a.id,
            change: { state: "active" },
            basis: [source],
          }),
        ).rejects.toThrow("terminal-activity");
        const late = await store.change({
          agentId: "a",
          operationId: "late",
          expectedRevision: abandoned.revision,
          activityId: a.id,
          change: { externalResult: "partial" },
          basis: [source],
        });
        expect(late).toMatchObject({
          state: "abandoned",
          externalResult: "partial",
          completedSteps: ["读过第一页"],
        });
        expect(
          (
            await db.information.find({
              kinds: ["agent.continuity.activity.v1"],
              limit: 100,
            })
          ).length,
        ).toBe(6);
      } finally {
        await db.close();
      }
    });
    it("proves internal self sources without a human message and refuses forged choice or ownership", async () => {
      const db = await factory();
      try {
        await db.prepareSchema();
        const now = new Date("2026-11-13T00:00:00Z");
        const store = new PostgresContinuityStore(db.sql, () => now);
        await store.configure({
          agentId: "a",
          operationId: "config",
          expectedRevision: 0,
          policy,
          basis: [],
        });
        const config = (
          await db.sql.query<{ information_id: string }>(
            "SELECT information_id FROM information_atoms WHERE kind='agent.continuity.policy.v1'",
          )
        ).rows[0]!.information_id;
        const { informationId: id } = await store.internalSource({
          operationId: "import",
          source: {
            agentId: "a",
            ownerId: "self:kaguya",
            scope: "shared",
            type: "persona-seed",
            text: "角色设定：对月球好奇",
            basis: [config],
            occurredAt: now.toISOString(),
          },
        });
        const source = {
          id,
          scope: "shared",
          ownerId: "self:kaguya",
          text: "角色设定：对月球好奇",
          occurredAt: now.toISOString(),
          collectedAt: now.toISOString(),
          sourceType: "internal" as const,
          participants: [],
          replyTo: null,
        };
        expect(await db.memoryGraph.native.ingest(source)).toBe(true);
        const nodeId = randomUUID();
        const result = await db.memoryGraph.native.publish({
          operationId: "self-import",
          actor: "automatic",
          nodes: [
            {
              expectedRevision: 0,
              node: {
                id: nodeId,
                content: source.text,
                metadata: {
                  system: "native-v1",
                  kind: "self",
                  ownerId: "self:kaguya",
                  scope: "shared",
                  level: 0,
                  occurredAt: now.toISOString(),
                  revision: 1,
                  status: "active",
                  locked: false,
                  sourceIds: [id],
                  aliases: [],
                  tags: ["persona-seed"],
                },
              },
            },
          ],
          edges: [],
        });
        expect(result[0]?.metadata.proofOwners).toEqual([
          { ownerId: "self:kaguya", sourceIds: [id] },
        ]);
        const activity = await store.create({
          agentId: "a",
          operationId: "depends-on-self",
          expectedRevision: 1,
          activity: {
            id: "dependent",
            scope: "shared",
            kind: "plan",
            title: "按原兴趣阅读",
            goal: "阅读",
            sources: [id],
            memoryDependencies: [{ id: nodeId, revision: 1 }],
          },
        });
        const before = await store.freeze({
          agentId: "a",
          scope: "shared",
          operationId: "before-revision",
          basis: [id],
        });
        await db.memoryGraph.native.publish({
          operationId: "self-correction",
          actor: "automatic",
          nodes: [
            {
              expectedRevision: 1,
              node: {
                ...result[0]!,
                content: "角色种子更正：对建筑好奇",
                metadata: { ...result[0]!.metadata, revision: 2 },
              },
            },
          ],
          edges: [],
        });
        expect((await store.read("a", "shared"))?.activities[0]).toMatchObject({
          state: "waiting",
          reevaluationRequired: true,
        });
        expect(
          (
            await store.freeze({
              agentId: "a",
              scope: "shared",
              operationId: "before-revision",
              basis: [id],
            })
          ).view,
        ).toEqual(before.view);
        await expect(
          store.change({
            agentId: "a",
            operationId: "stale-plan",
            expectedRevision: activity.revision + 1,
            activityId: activity.id,
            change: { state: "active" },
            basis: [id],
          }),
        ).rejects.toThrow("reevaluation-required");
        await expect(
          store.change({
            agentId: "a",
            operationId: "unproved-rebase",
            expectedRevision: activity.revision + 1,
            activityId: activity.id,
            change: { state: "active", reevaluationRequired: false },
            basis: [id],
          }),
        ).rejects.toThrow("reevaluation-unproved");
        const aggregate = (await store.read("a", "shared"))!;
        const indirect = await store.create({
          agentId: "a",
          operationId: "indirect-plan",
          expectedRevision: aggregate.revision,
          activity: {
            id: "indirect",
            scope: "shared",
            kind: "plan",
            title: "依赖记忆而非原消息",
            goal: "依据当前认识选择资料",
            sources: [config],
            memoryDependencies: [{ id: nodeId, revision: 2 }],
          },
        });
        await db.memoryGraph.native.publish({
          operationId: "withdraw-internal-evidence",
          actor: "manual",
          nodes: [],
          edges: [],
          invalidations: [
            { kind: "source-withdrawal", targetId: id, reason: "撤回这条依据" },
          ],
        });
        expect(
          (await store.read("a", "shared"))?.activities.find(
            (a) => a.id === indirect.id,
          ),
        ).toMatchObject({ reevaluationRequired: true, state: "waiting" });
        await expect(
          db.memoryGraph.native.ingest({ ...source, ownerId: "person:fake" }),
        ).rejects.toThrow("memory_invalid_source");
        await expect(
          store.internalSource({
            operationId: "fake-choice",
            source: {
              agentId: "a",
              ownerId: "self:kaguya",
              scope: "shared",
              type: "internal-choice",
              text: "我选择了科研",
              basis: [config],
              occurredAt: now.toISOString(),
            },
          }),
        ).rejects.toThrow("unproven-internal-choice");
        expect(
          await db.information.find({
            kinds: ["core.message.inbound.text"],
            limit: 10,
          }),
        ).toEqual([]);
      } finally {
        await db.close();
      }
    });
  });
