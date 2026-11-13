/**
 * 功能概述：用真实隔离存储验证后台形成器的经历操作协议，不调用外部模型或发送消息。
 * 主要职责：fixture 建立真实来源和账号绑定；form 调用生产 publishFormation；proposal 保留明确证据。
 * 用例覆盖增补、封口、重开、更正、合并拆分、重复发布、并发冲突、失败保持和旧冻结读取。
 * 代码库关系：直接使用 database 源码工厂避免误测旧 dist；Memory Access 负责冻结，数据库负责事务及失效过滤。
 * 输入输出与副作用：默认使用独立 PGlite；配置测试 URL 时另跑独立 PostgreSQL schema，finally 关闭并清理。
 * 所有写入均逐次等待真实事务结果，并发用例等待双方完成，不使用固定 sleep 或后台轮询。
 */
import { describe, expect, it } from "vitest";
import {
  createNativeMemoryAccess,
  type MemoryPublication,
  type MemorySource,
  type NativeMemoryNode,
  type NativeMemorySnapshot,
} from "@kaguya/memory";
import { freezeInformationAtom, informationAtomSchema } from "@kaguya/schema";
import {
  createPostgresTestingDatabase,
  createTestingDatabase,
} from "../../../../database/src/testing.js";
import {
  experienceFormationOutputSchema,
  formationOutputSchema,
  formationSchemaFor,
  nativeMemoryRequested,
  revisableFormationOutputSchema,
} from "./facts.js";
import { publishFormation, stableId } from "./formation.js";

const at = "2026-10-22T00:00:00.000Z";
const scope = JSON.stringify(["qq", "qq", "group", "experience-test"]);
const policy = "experience-operations.v1" as const;
const read = {
  scope,
  owners: ["person:a", "person:b", `conversation:${scope}`],
  asOf: "2030-01-01T00:00:00.000Z",
  query: "经历",
};
const url = process.env.KAGUYA_TEST_DATABASE_URL;
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];

async function fixture(create: () => ReturnType<typeof createTestingDatabase>) {
  const db = await create();
  try {
    await db.prepareSchema();
    await db.information.synchronizeKinds([
      "core.message.inbound.text",
      "memory.identity.platform.account.entity",
      "memory.identity.platform.account.binding",
    ]);
    const append = async (
      informationId: string,
      kind: string,
      payload: Record<string, unknown>,
      references: { relation: string; informationId: string }[] = [],
    ) =>
      db.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId,
            kind,
            payload,
            references,
            occurredAt: at,
            source: "test:experience-operations",
          }),
        ),
        references.map((r) => ({
          relation: r.relation,
          required: true,
          multiple: false,
        })),
      );
    for (const accountId of ["a", "b"]) {
      await append(
        `account:${accountId}`,
        "memory.identity.platform.account.entity",
        {
          platform: "qq",
          adapterId: "qq",
          accountId,
        },
      );
      await append(
        `binding:${accountId}`,
        "memory.identity.platform.account.binding",
        { personInformationId: accountId },
        [{ relation: "core:binds", informationId: `account:${accountId}` }],
      );
    }
    const memory = createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    });
    const source = async (
      id: string,
      text: string,
      speaker = "a",
    ): Promise<MemorySource> => {
      await append(id, "core.message.inbound.text", {
        text,
        source: {
          platform: "qq",
          adapterId: "qq",
          senderId: speaker,
          selfId: "bot",
          destination: { kind: "group", groupId: "experience-test" },
        },
      });
      const value: MemorySource = {
        id,
        text,
        ownerId: `person:${speaker}`,
        scope,
        occurredAt: at,
        collectedAt: at,
        sourceType: "inbound",
        participants: [
          {
            accountId: speaker,
            ownerId: `person:${speaker}`,
            role: "speaker",
            nickname: null,
            card: null,
          },
        ],
        replyTo: null,
      };
      await db.memoryGraph.native.ingest(value);
      return value;
    };
    const freeze = () => memory.prepare(read);
    const form = async (
      batchId: string,
      existing: NativeMemorySnapshot,
      output: unknown,
      sources: MemorySource[] = [],
      status = "completed",
    ) =>
      publishFormation(
        { batchId, scope, formationPolicy: policy, existing, sources },
        { status, output },
        at,
        memory,
      );
    return { db, memory, source, freeze, form, close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
}

const proposal = (
  key: string,
  sourceIds: string[],
  content = "一次学习经历",
  state: "open" | "sealed" = "open",
  status: "active" | "archived" = "active",
) => ({
  key,
  kind: "experience" as const,
  ownerId: "person:a",
  scope,
  level: 1,
  content,
  sourceIds,
  tags: [],
  aliases: [],
  status,
  expressionType: null,
  experience: { state, policyVersion: "experience.v1" as const },
});
const revision = (
  snapshot: NativeMemorySnapshot,
  id: string,
): NativeMemoryNode => {
  const result = [
    ...snapshot.fixed,
    ...snapshot.recalled.map((r) => r.node),
  ].find((node) => node.id === id);
  if (!result) throw new Error(`Missing experience ${id}`);
  return result;
};

it("selects the new operation schema only for requests that persist its policy", () => {
  expect(formationSchemaFor({})).toBe(formationOutputSchema);
  expect(formationSchemaFor({ cutoff: { publicationPosition: "1" } })).toBe(
    revisableFormationOutputSchema,
  );
  expect(
    formationSchemaFor({ cutoff: { publicationPosition: "1" } }, policy),
  ).toBe(experienceFormationOutputSchema);
  const output = {
    nodes: [],
    edges: [],
    experienceOperation: {
      kind: "merge",
      inputIds: ["a", "b"],
      outputIds: ["c"],
    },
  };
  expect(formationOutputSchema.safeParse(output).success).toBe(false);
  expect(revisableFormationOutputSchema.safeParse(output).success).toBe(false);
  expect(experienceFormationOutputSchema.safeParse(output).success).toBe(true);
  const old = nativeMemoryRequested.payloadSchema.parse({
    batchId: "old",
    scope,
    sources: [],
    existing: {},
  });
  expect(old).not.toHaveProperty("formationPolicy");
});

describe.each(backends)(
  "automatic experience operations ($name)",
  ({ create }) => {
    it("keeps inferred portraits scoped and retracts dependent summaries without rewriting old snapshots", async () => {
      const f = await fixture(create);
      try {
        const experiment = await f.source("experiment", "实验又得重跑了");
        const meeting = await f.source("meeting", "导师让我组会前整理结果");
        const evidence = {
          basis: "inference" as const,
          temporality: "recent" as const,
          observedAt: at,
          validFrom: null,
          validUntil: null,
          sourceScope: scope,
          supersedes: [],
        };
        const detail = {
          key: "understanding",
          kind: "person",
          ownerId: "person:a",
          scope,
          level: 1,
          content: "结合实验与组会线索，看来在参与科研。具体职位待确认。",
          sourceIds: [meeting.id],
          aliases: [],
          tags: [],
          status: "active",
          evidence,
        };
        expect(
          await f.form(
            "portrait",
            await f.freeze(),
            {
              nodes: [
                {
                  ...detail,
                  key: "experiment-evidence",
                  level: 2,
                  content: "本人表示实验需要重跑。",
                  sourceIds: [experiment.id],
                  evidence: { ...evidence, basis: "self-report" },
                },
                detail,
                { ...detail, key: "summary", level: 0 },
              ],
              edges: [
                {
                  sourceId: "summary",
                  targetId: "understanding",
                  relation: "summarizes",
                },
                {
                  sourceId: "understanding",
                  targetId: "experiment-evidence",
                  relation: "derived-from",
                },
              ],
            },
            [experiment, meeting],
          ),
        ).toMatchObject({ status: "completed" });
        const snapshot = await f.memory.freeze({ ...read, query: "" });
        if (!snapshot.cutoff) throw new Error("Missing publication cutoff");
        expect(snapshot.fixed[0]?.metadata.evidence?.basis).toBe("inference");
        const privateRead = {
          ...read,
          scope: JSON.stringify(["qq", "qq", "private", "a"]),
          query: "",
        };
        expect((await f.memory.freeze(privateRead)).fixed).toEqual([]);
        await f.memory.publish({
          operationId: "withdraw-experiment",
          actor: "manual",
          nodes: [],
          invalidations: [
            {
              kind: "source-withdrawal",
              targetId: experiment.id,
              reason: "原线索撤回",
            },
          ],
        });
        expect((await f.memory.freeze({ ...read, query: "" })).fixed).toEqual(
          [],
        );
        const old = await f.memory.freeze({
          ...read,
          query: "",
          cutoff: snapshot.cutoff,
        });
        expect(old.fixed).toEqual(snapshot.fixed);
        expect(
          await f.db.memoryGraph.native.history(
            stableId("portrait", "summary"),
          ),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it("checks the frozen input versions even when archive revisions match current rows", async () => {
      const f = await fixture(create);
      try {
        const a = await f.source("source:a", "第一部分");
        const b = await f.source("source:b", "第二部分");
        await f.form(
          "initial",
          await f.freeze(),
          {
            nodes: [proposal("first", [a.id]), proposal("second", [b.id])],
            edges: [],
          },
          [a, b],
        );
        const first = stableId("initial", "first");
        const second = stableId("initial", "second");
        await f.form("correct-first", await f.freeze(), {
          nodes: [proposal(first, [a.id], "第一部分的较新更正")],
          edges: [],
          experienceOperation: {
            kind: "correct",
            inputIds: [first],
            outputIds: [first],
          },
        });
        const current = await f.freeze();
        const inputs = [revision(current, first), revision(current, second)];
        expect(inputs.map((n) => n.metadata.revision)).toEqual([2, 1]);
        const output: NativeMemoryNode = {
          ...inputs[0]!,
          id: stableId("merge", "output"),
          content: "合并两部分",
          metadata: {
            ...inputs[0]!.metadata,
            revision: 1,
            sourceIds: [a.id, b.id],
            experience: {
              state: "open",
              policyVersion: "experience.v1",
              predecessors: [first, second],
            },
          },
        };
        const publication = {
          operationId: "stale-frozen-merge",
          actor: "automatic",
          expectedVersions: { [first]: 1, [second]: 1 },
          nodes: [
            ...inputs.map((node) => ({
              expectedRevision: node.metadata.revision,
              node: {
                ...node,
                metadata: {
                  ...node.metadata,
                  revision: node.metadata.revision + 1,
                  status: "archived" as const,
                },
              },
            })),
            { node: output, expectedRevision: 0 },
          ],
          experienceOperation: {
            kind: "merge",
            inputIds: [first, second],
            outputIds: [output.id],
          },
        } satisfies MemoryPublication;
        await expect(f.memory.publish(publication)).rejects.toThrow(
          "memory_revision_conflict",
        );
        expect(
          await f.memory.published(publication.operationId),
        ).toBeUndefined();
        expect(await f.db.memoryGraph.native.history(first)).toHaveLength(2);
        expect(await f.db.memoryGraph.native.history(second)).toHaveLength(1);
        const changedArchive: Partial<
          Pick<
            NativeMemoryNode["metadata"],
            "kind" | "scope" | "ownerId" | "sourceIds"
          >
        >[] = [
          { kind: "person" },
          { scope: "shared" },
          { ownerId: "person:b" },
          { sourceIds: [b.id] },
        ];
        for (const [index, metadata] of changedArchive.entries()) {
          const archive = publication.nodes[0]!;
          const operationId = `changed-archive:${index}`;
          await expect(
            f.memory.publish({
              ...publication,
              operationId,
              expectedVersions: { [first]: 2, [second]: 1 },
              nodes: [
                {
                  ...archive,
                  node: {
                    ...archive.node,
                    metadata: { ...archive.node.metadata, ...metadata },
                  },
                },
                ...publication.nodes.slice(1),
              ],
            }),
          ).rejects.toThrow("memory_experience_sources");
          expect(await f.memory.published(operationId)).toBeUndefined();
        }
        expect(await f.db.memoryGraph.native.history(first)).toHaveLength(2);
        expect(await f.db.memoryGraph.native.history(second)).toHaveLength(1);
        expect(
          await f.memory.publish({
            ...publication,
            operationId: "current-frozen-merge",
            expectedVersions: { [first]: 2, [second]: 1 },
          }),
        ).toHaveLength(3);
        expect((await f.freeze()).recalled.map((r) => r.node.id)).toEqual([
          output.id,
        ]);
      } finally {
        await f.close();
      }
    });

    it("publishes merge/split/seal/reopen/correct atomically with stable IDs and one publication per operation", async () => {
      const f = await fixture(create);
      try {
        const a = await f.source("source:a", "我学习了第一部分");
        const b = await f.source("source:b", "我学习了第二部分");
        expect(
          await f.form(
            "initial",
            await f.freeze(),
            {
              nodes: [proposal("first", [a.id]), proposal("second", [b.id])],
              edges: [],
            },
            [a, b],
          ),
        ).toMatchObject({ status: "completed", reason: "published" });
        const first = stableId("initial", "first"),
          second = stableId("initial", "second");
        const initial = await f.freeze();
        const merge = {
          nodes: [
            proposal(first, [a.id], "一次学习经历", "open", "archived"),
            proposal(second, [b.id], "一次学习经历", "open", "archived"),
            proposal("merged", [a.id, b.id], "完成两部分学习"),
          ],
          edges: [],
          experienceOperation: {
            kind: "merge",
            inputIds: [first, second],
            outputIds: ["merged"],
          },
        };
        const merged = stableId("merge", "merged");
        const mergedResult = await f.form("merge", initial, merge);
        expect(mergedResult).toEqual({
          status: "completed",
          reason: "published",
          nodeIds: [first, second, merged],
        });
        expect(await f.form("merge", initial, merge)).toEqual(mergedResult);
        const mergedSnapshot = await f.freeze();
        expect(mergedSnapshot.recalled.map((r) => r.node.id)).toEqual([merged]);
        expect(
          revision(mergedSnapshot, merged).metadata.experience,
        ).toMatchObject({
          predecessors: [first, second],
          proofOwners: [{ ownerId: "person:a", sourceIds: [a.id, b.id] }],
        });
        const split = {
          nodes: [
            proposal(
              merged,
              [a.id, b.id],
              "完成两部分学习",
              "open",
              "archived",
            ),
            proposal("left", [a.id]),
            proposal("right", [b.id]),
          ],
          edges: [],
          experienceOperation: {
            kind: "split",
            inputIds: [merged],
            outputIds: ["left", "right"],
          },
        };
        const left = stableId("split", "left"),
          right = stableId("split", "right");
        expect(await f.form("split", mergedSnapshot, split)).toMatchObject({
          status: "completed",
          reason: "published",
        });
        expect(
          (await f.freeze()).recalled.map((r) => r.node.id).sort(),
        ).toEqual([left, right].sort());
        for (const [kind, state] of [
          ["seal", "sealed"],
          ["reopen", "open"],
        ] as const) {
          expect(
            await f.form(kind, await f.freeze(), {
              nodes: [proposal(left, [a.id], "一次学习经历", state)],
              edges: [],
              experienceOperation: {
                kind,
                inputIds: [left],
                outputIds: [left],
              },
            }),
          ).toMatchObject({ status: "completed", reason: "published" });
          expect(
            revision(await f.freeze(), left).metadata.experience?.state,
          ).toBe(state);
        }
        const correction = await f.source(
          "source:correction",
          "更正，第一部分仍未完成",
        );
        expect(
          await f.form(
            "correct",
            await f.freeze(),
            {
              nodes: [
                proposal(left, [a.id, correction.id], "第一部分尚未完成"),
              ],
              edges: [],
              experienceOperation: {
                kind: "correct",
                inputIds: [left],
                outputIds: [left],
              },
            },
            [correction],
          ),
        ).toMatchObject({ status: "completed", reason: "published" });
        expect(revision(await f.freeze(), left)).toMatchObject({
          id: left,
          content: "第一部分尚未完成",
          metadata: {
            revision: 4,
            sourceIds: [a.id, correction.id],
            experience: { predecessors: [merged], state: "open" },
          },
        });
        expect(await f.db.memoryGraph.native.history(left)).toHaveLength(4);
        expect(await f.db.memoryGraph.native.history(merged)).toHaveLength(2);
        const historic = await f.db.memoryGraph.native.current(
          { ...read, cutoff: initial.cutoff! },
          [first, second, merged, left],
        );
        expect(historic.map((n) => n.id).sort()).toEqual(
          [first, second].sort(),
        );
        expect(historic.every((n) => n.metadata.revision === 1)).toBe(true);
        const beforeInvalidation = await f.freeze();
        await f.memory.publish({
          operationId: "withdraw-first-source",
          actor: "manual",
          nodes: [],
          invalidations: [
            { kind: "source-withdrawal", targetId: a.id, reason: "原陈述撤回" },
          ],
        });
        expect((await f.freeze()).recalled.map((r) => r.node.id)).toEqual([
          right,
        ]);
        await f.memory.publish({
          operationId: "split-person",
          actor: "manual",
          nodes: [],
          invalidations: [
            {
              kind: "identity-split",
              targetId: "person:a",
              reason: "账号归属拆分",
            },
          ],
        });
        expect((await f.freeze()).recalled).toEqual([]);
        expect(
          (
            await f.db.memoryGraph.native.current(
              { ...read, cutoff: beforeInvalidation.cutoff! },
              [left, right],
            )
          )
            .map((n) => n.id)
            .sort(),
        ).toEqual([left, right].sort());
      } finally {
        await f.close();
      }
    });

    it("keeps the successful competing correction and exposes only old revisions at the frozen cutoff", async () => {
      const f = await fixture(create);
      try {
        const source = await f.source("original", "此前的陈述");
        await f.form(
          "initial",
          await f.freeze(),
          { nodes: [proposal("event", [source.id], "旧结论")], edges: [] },
          [source],
        );
        const id = stableId("initial", "event");
        const frozen = await f.freeze();
        const competing = ["更正甲", "更正乙"].map((content, index) =>
          f.form(`worker:${index}`, frozen, {
            nodes: [proposal(id, [source.id], content)],
            edges: [],
            experienceOperation: {
              kind: "correct",
              inputIds: [id],
              outputIds: [id],
            },
          }),
        );
        const results = await Promise.all(competing);
        expect(results.filter((r) => r.reason === "published")).toHaveLength(1);
        expect(
          results.filter((r) => r.reason === "memory_revision_conflict"),
        ).toHaveLength(1);
        const winner = results.findIndex((r) => r.reason === "published");
        expect(revision(await f.freeze(), id)).toMatchObject({
          content: ["更正甲", "更正乙"][winner],
          metadata: { revision: 2 },
        });
        expect(await f.db.memoryGraph.native.history(id)).toHaveLength(2);
        expect(
          await f.db.memoryGraph.native.current(
            { ...read, cutoff: frozen.cutoff! },
            [id],
          ),
        ).toMatchObject([{ content: "旧结论", metadata: { revision: 1 } }]);
        expect(revision(frozen, id).content).toBe("旧结论");
      } finally {
        await f.close();
      }
    });

    it("keeps old valid facts on failure, empty output and no-change without creating revisions", async () => {
      const f = await fixture(create);
      try {
        const source = await f.source("original", "已经确认的经历");
        await f.form(
          "initial",
          await f.freeze(),
          { nodes: [proposal("event", [source.id])], edges: [] },
          [source],
        );
        const id = stableId("initial", "event");
        const frozen = await f.freeze();
        expect(await f.form("failed", frozen, undefined, [], "failed")).toEqual(
          { status: "failed", reason: "model-unavailable", nodeIds: [] },
        );
        expect(await f.form("empty", frozen, { nodes: [], edges: [] })).toEqual(
          { status: "completed", reason: "empty", nodeIds: [] },
        );
        expect(
          await f.form("same", frozen, {
            nodes: [proposal(id, [source.id])],
            edges: [],
          }),
        ).toEqual({ status: "completed", reason: "no-change", nodeIds: [] });
        expect(
          await f.form("invalid-seal", frozen, {
            nodes: [proposal(id, [source.id], "一次学习经历", "open")],
            edges: [],
            experienceOperation: {
              kind: "seal",
              inputIds: [id],
              outputIds: [id],
            },
          }),
        ).toEqual({
          status: "rejected",
          reason: "memory_invalid_experience",
          nodeIds: [],
        });
        expect(revision(await f.freeze(), id)).toEqual(revision(frozen, id));
        expect(await f.db.memoryGraph.native.history(id)).toHaveLength(1);
        for (const operation of ["failed", "empty", "same", "invalid-seal"])
          expect(await f.memory.published(operation)).toBeUndefined();
      } finally {
        await f.close();
      }
    });

    it("rejects a bystander's unreferenced statement attributed to the questioned person", async () => {
      const f = await fixture(create);
      try {
        const bystander = await f.source("bystander", "我喜欢音乐", "b");
        expect(bystander.replyTo).toBeNull();
        expect(
          await f.form(
            "forged-owner",
            await f.freeze(),
            {
              nodes: [proposal("event", [bystander.id], "甲喜欢音乐")],
              edges: [],
            },
            [bystander],
          ),
        ).toEqual({
          status: "rejected",
          reason: "invalid-scope-or-evidence",
          nodeIds: [],
        });
        expect((await f.freeze()).recalled).toEqual([]);
        expect(await f.memory.published("forged-owner")).toBeUndefined();
      } finally {
        await f.close();
      }
    });
  },
);
