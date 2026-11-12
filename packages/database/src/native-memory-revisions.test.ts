/**
 * 功能概述：验证 native 历史上界、来源失效、经历事务、分页及真实 PostgreSQL 提交可见性。
 * 主要职责：双数据库用例保留原文/epoch/哈希，验证合并拆分不能覆盖既有节点或复用归档前驱；
 * 真实 PG barrier 将 publication 停在提交前，
 * 证明较晚冻结不会因较早分配 position 而吸入未见知识。所有阻塞在 finally 释放后再关闭连接。
 * 代码库关系：直接调用生产 NativeMemoryStore/Access，仅向量候选使用离线替身；不调用外部模型。
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeMemoryAccess,
  memoryPublicationSchema,
  type NativeMemoryNode,
} from "@kaguya/memory";
import { freezeInformationAtom, informationAtomSchema } from "@kaguya/schema";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "./testing.js";
import { KaguyaDatabase } from "./index.js";
import type { SqlDatabase } from "./driver.js";
import { observationManifestSchema } from "@kaguya/sdk";
const opened: KaguyaDatabase[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    opened.splice(0).map((db) => db.close()),
  );
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason);
  if (errors.length)
    throw new AggregateError(errors, "Database cleanup failed");
});
const url = process.env.KAGUYA_TEST_DATABASE_URL;
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = JSON.stringify(["qq", "qq", "group", "G"]);
const input = {
  scope,
  owners: ["person:a"],
  asOf: "2030-01-01T00:00:00Z",
  query: "钢琴",
  explicitIds: [id(2)],
};
const node = (
  n: number,
  level = 1,
  sourceIds: string[] = [],
): NativeMemoryNode => ({
  id: id(n),
  content: `钢琴经历${n}`,
  metadata: {
    system: "native-v1",
    kind: "person",
    ownerId: "person:a",
    scope,
    level,
    revision: 1,
    status: "active",
    locked: false,
    sourceIds,
    aliases: ["阿同"],
    tags: [],
    occurredAt: "2026-01-01T00:00:00Z",
  },
});
async function source(
  db: KaguyaDatabase,
  sourceId: string,
  text = "原文",
  occurredAt = "2020-01-01T00:00:00Z",
) {
  await db.information.synchronizeKinds(["core.message.inbound.text"]);
  await db.information.append(
    freezeInformationAtom(
      informationAtomSchema.parse({
        informationId: sourceId,
        kind: "core.message.inbound.text",
        occurredAt,
        source: "test:memory",
        payload: {
          text,
          source: {
            platform: "qq",
            adapterId: "qq",
            senderId: "a",
            selfId: "bot",
            destination: { kind: "group", groupId: "G" },
          },
        },
        references: [],
      }),
    ),
    [],
  );
}
async function setup(create: () => Promise<KaguyaDatabase>) {
  const db = await create();
  opened.push(db);
  await db.prepareSchema();
  return db;
}
const put = (
  db: KaguyaDatabase,
  operationId: string,
  nodes: NativeMemoryNode[],
  extra = {},
) =>
  db.memoryGraph.native.publish({
    operationId,
    actor: "manual",
    nodes: nodes.map((n) => ({
      node: n,
      expectedRevision: n.metadata.revision - 1,
    })),
    ...extra,
  });

describe.each(backends)("native revision boundary ($name)", ({ create }) => {
  it.each([
    ["raw", "initial"],
    ["canonical", "initial"],
    ["raw", "revision"],
    ["canonical", "revision"],
    ["raw", "legacy-read"],
    ["canonical", "legacy-read"],
    ["source-table", "legacy-read"],
    ["late-canonical", "legacy-read"],
    ["recover-after-split", "legacy-read"],
    ["rebind-after-split", "legacy-read"],
    ["markerless-conversation", "legacy-read"],
    ["markerless-B", "legacy-read"],
    ["nested-only", "legacy-read"],
  ])(
    "owns source proof across all kinds: %s / %s",
    async (normalization, mode) => {
      const db = await setup(create);
      const kinds = [
        "memory.identity.platform.account.entity",
        "memory.identity.platform.account.binding",
      ];
      await db.information.synchronizeKinds(kinds);
      for (const [informationId, kind, payload, references] of [
        [
          "account",
          kinds[0],
          { platform: "qq", adapterId: "qq", accountId: "a" },
          [],
        ],
        [
          "binding",
          kinds[1],
          { personInformationId: "A" },
          [{ relation: "core:binds", informationId: "account" }],
        ],
      ] as const)
        await db.information.append(
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId,
              kind,
              payload,
              references,
              occurredAt: "2020-01-01T00:00:00Z",
              source: "test:memory",
            }),
          ),
          references.map((r) => ({
            relation: r.relation,
            required: true,
            multiple: false,
          })),
        );
      await source(db, "S");
      if (normalization === "canonical")
        await db.memoryGraph.native.ingest({
          id: "S",
          scope,
          ownerId: "person:A",
          text: "原文",
          occurredAt: "2020-01-01T00:00:00Z",
          collectedAt: "2026-01-01T00:00:00Z",
          sourceType: "inbound",
          participants: [],
          replyTo: null,
        });
      if (normalization!.startsWith("markerless")) {
        const ownerId =
          normalization === "markerless-B"
            ? "person:B"
            : `conversation:${scope}`;
        await db.information.synchronizeKinds(["memory.native.source.v1"]);
        await db.information.append(
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: "memory-native-source:S",
              kind: "memory.native.source.v1",
              source: "memory:normalization",
              occurredAt: "2020-01-01T00:00:00Z",
              references: [],
              payload: {
                memorySource: {
                  id: "S",
                  scope,
                  ownerId,
                  text: "原文",
                  occurredAt: "2020-01-01T00:00:00Z",
                  collectedAt: "2026-01-01T00:00:00Z",
                  sourceType: "inbound",
                  participants: [],
                  replyTo: null,
                },
              },
            }),
          ),
          [],
        );
      }
      const nodes = [
        node(31, 0, ["S"]),
        node(32, 1, ["S"]),
        node(33, 1, ["S"]),
        node(34, 0, ["S"]),
        node(35, 1),
      ];
      for (const n of nodes) {
        n.metadata.ownerId = `conversation:${scope}`;
        n.metadata.kind = "conversation";
        // 两种客户端字段都不能定义服务端归属。
        n.metadata.proofOwners = [
          { ownerId: "person:forged", sourceIds: ["S"] },
        ];
      }
      nodes[2]!.metadata.kind = "experience";
      nodes[2]!.metadata.experience = {
        state: "open",
        policyVersion: "manual.v1",
        predecessors: [],
        proofOwners: [],
      };
      nodes[3]!.metadata.kind = "person";
      nodes[3]!.metadata.ownerId = "person:summary-owner";
      const edge = {
        sourceId: nodes[4]!.id,
        targetId: nodes[1]!.id,
        relation: "derived-from",
      };
      let published: NativeMemoryNode[];
      if (mode === "initial") {
        published = await put(db, "proof-initial", nodes, { edges: [edge] });
        expect(
          published
            .slice(0, 4)
            .every((n) =>
              n.metadata.proofOwners?.some(
                (p) => p.ownerId === "person:A" && p.sourceIds.includes("S"),
              ),
            ),
        ).toBe(true);
        expect(
          published.some((n) =>
            n.metadata.proofOwners?.some((p) => p.ownerId === "person:forged"),
          ),
        ).toBe(false);
      } else {
        // 直接登记升级前的 fixture，不修改 immutable Atom，也不关闭 append-only 保护。
        for (const n of nodes) {
          delete n.metadata.proofOwners;
          if (n.metadata.experience) delete n.metadata.experience.proofOwners;
        }
        if (normalization === "nested-only")
          nodes[2]!.metadata.experience!.proofOwners = [
            { ownerId: nodes[2]!.metadata.ownerId, sourceIds: ["S"] },
          ];
        const proposal = memoryPublicationSchema.parse({
          operationId: "proof-initial",
          actor: "manual",
          nodes: nodes.map((node) => ({ node, expectedRevision: 0 })),
          edges: [edge],
        });
        const canonical = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(canonical)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => [k, canonical(v)]),
                )
              : value;
        const hash = createHash("sha256")
          .update(JSON.stringify(canonical(proposal)))
          .digest("hex");
        published = proposal.nodes.map((n) => n.node);
        await db.information.synchronizeKinds(["memory.native.revision.v1"]);
        await db.information.append(
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: "legacy-proof-publication",
              kind: "memory.native.revision.v1",
              source: "memory:manual",
              occurredAt: "2026-01-01T00:00:00Z",
              references: [],
              payload: {
                operationId: proposal.operationId,
                nodes: published,
                edges: proposal.edges,
                removeEdges: proposal.removeEdges,
              },
            }),
          ),
          [],
        );
        for (const n of published)
          await db.sql.query(
            "INSERT INTO memory_nodes(id,metadata,content) VALUES($1,$2::jsonb,$3)",
            [n.id, JSON.stringify(n.metadata), n.content],
          );
        await db.sql.query(
          "INSERT INTO memory_edges(source_id,target_id,relation,metadata) VALUES($1,$2,$3,'{}'::jsonb)",
          [edge.sourceId, edge.targetId, edge.relation],
        );
        await db.sql.query(
          "INSERT INTO memory_native_publications(operation_id,input_hash,information_id,nodes) VALUES($1,$2,$3,$4::jsonb)",
          [
            proposal.operationId,
            hash,
            "legacy-proof-publication",
            JSON.stringify(published),
          ],
        );
      }
      if (["source-table", "late-canonical"].includes(normalization!)) {
        const storedSource = {
          id: "S",
          scope,
          ownerId: "person:A",
          text: "原文",
          occurredAt: "2020-01-01T00:00:00Z",
          collectedAt: "2026-01-01T00:00:00Z",
          sourceType: "inbound" as const,
          participants: [],
          replyTo: null,
        };
        await db.sql.query(
          "INSERT INTO memory_native_sources(id,scope,source) VALUES($1,$2,$3::jsonb)",
          ["S", scope, JSON.stringify(storedSource)],
        );
        if (normalization === "late-canonical")
          await db.memoryGraph.native.ingest(storedSource);
      }
      const original = (
        await db.sql.query(
          "SELECT p.*,a.payload FROM memory_native_publications p JOIN information_atoms a USING(information_id) WHERE operation_id='proof-initial'",
        )
      ).rows;
      if (mode === "revision")
        await put(
          db,
          "proof-revision",
          nodes.map((n) => ({
            ...n,
            metadata: { ...n.metadata, revision: 2 },
          })),
        );
      const context = {
        ...input,
        owners: [`conversation:${scope}`, "person:summary-owner"],
        explicitIds: nodes.map((n) => n.id),
      };
      const access = createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      });
      const before = await access.freeze(context),
        beforeBytes = JSON.stringify(before);
      const unverifiable =
        mode === "legacy-read" && normalization !== "canonical";
      expect(
        (
          await db.memoryGraph.native.current(
            context,
            nodes.map((n) => n.id),
          )
        ).length,
      ).toBe(unverifiable ? 0 : 5);
      await put(db, "proof-split", [], {
        invalidations: [
          {
            kind: "identity-split",
            targetId: "person:A",
            reason: "来源身份拆分",
          },
        ],
      });
      if (
        ["recover-after-split", "rebind-after-split"].includes(normalization!)
      ) {
        if (normalization === "rebind-after-split")
          await db.information.append(
            freezeInformationAtom(
              informationAtomSchema.parse({
                informationId: "binding-B",
                kind: kinds[1],
                payload: { personInformationId: "B" },
                references: [
                  { relation: "core:binds", informationId: "account" },
                ],
                occurredAt: "2026-01-01T00:00:00Z",
                source: "test:memory",
              }),
            ),
            [{ relation: "core:binds", required: true, multiple: false }],
          );
        await db.memoryGraph.native.recover();
        const canonical = (
          await db.sql.query<{
            payload: {
              sourceOwners: string[];
              memorySource: { ownerId: string };
            };
          }>(
            "SELECT payload FROM information_atoms WHERE information_id='memory-native-source:S'",
          )
        ).rows[0]!.payload;
        expect(canonical.memorySource.ownerId).toBe(
          normalization === "rebind-after-split"
            ? "person:B"
            : `conversation:${scope}`,
        );
        expect(canonical.sourceOwners).toContain("person:A");
        await put(db, "proof-normalized", [
          {
            ...node(98),
            metadata: { ...node(98).metadata, scope: "unrelated-private" },
          },
        ]);
      }
      const after = await db.memoryGraph.native.cutoff(context);
      const assertMasked = async (cutoff?: typeof after) => {
        const ctx = { ...context, ...(cutoff ? { cutoff } : {}) };
        expect(await db.memoryGraph.native.readFixed(ctx)).toEqual([]);
        expect(await db.memoryGraph.native.forFormation(ctx)).toEqual([]);
        expect(
          await db.memoryGraph.native.current(
            ctx,
            nodes.map((n) => n.id),
          ),
        ).toEqual([]);
        expect(await db.memoryGraph.native.candidates(ctx)).toEqual([]);
        expect(await db.memoryGraph.native.personCandidates(ctx)).toEqual([]);
        expect(
          await db.memoryGraph.native.expand(
            ctx,
            nodes.map((n) => n.id),
          ),
        ).toEqual([]);
        const frozen = await createNativeMemoryAccess({
          enabled: true,
          store: db.memoryGraph.native,
          retrievers: [
            {
              identity: "stale-source-owner",
              role: "semantic",
              search: async () => published,
            },
          ],
        }).freeze(ctx);
        expect(frozen.fixed).toEqual([]);
        expect(frozen.recalled).toEqual([]);
      };
      await assertMasked();
      await expect(
        db.memoryGraph.native.publish({
          operationId: "automatic-after-split",
          actor: "automatic",
          nodes: [
            {
              expectedRevision: 0,
              node: {
                ...node(36, 1, ["S"]),
                metadata: {
                  ...node(36, 1, ["S"]).metadata,
                  ownerId: `conversation:${scope}`,
                },
              },
            },
          ],
        }),
      ).rejects.toThrow("memory_source_invalidated");
      // 后续发布迫使显式 cutoff 使用历史读取，不能只测 current 快路径。
      await put(db, "proof-later", [node(99)]);
      await assertMasked(after);
      expect(
        (
          await db.memoryGraph.native.current(
            { ...context, cutoff: before.cutoff! },
            nodes.map((n) => n.id),
          )
        ).length,
      ).toBe(unverifiable ? 0 : 5);
      expect(JSON.stringify(before)).toBe(beforeBytes);
      expect(
        (
          await db.sql.query(
            "SELECT p.*,a.payload FROM memory_native_publications p JOIN information_atoms a USING(information_id) WHERE operation_id='proof-initial'",
          )
        ).rows,
      ).toEqual(original);
      expect(await put(db, "proof-initial", nodes, { edges: [edge] })).toEqual(
        original[0]!.nodes,
      );
    },
    30000,
  );
  it("rejects unsupported evidence despite client-supplied source ownership", async () => {
    const db = await setup(create);
    await db.information.synchronizeKinds(["test.untrusted"]);
    await db.information.append(
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: "untrusted",
          kind: "test.untrusted",
          source: "test:memory",
          occurredAt: "2020-01-01T00:00:00Z",
          payload: {},
          references: [],
        }),
      ),
      [],
    );
    const n = node(1, 1, ["untrusted"]);
    n.metadata.proofOwners = [
      { ownerId: "person:forged", sourceIds: ["untrusted"] },
    ];
    await expect(put(db, "unsupported", [n])).rejects.toThrow(
      "memory_source_proof_missing",
    );
    expect(await db.memoryGraph.native.history(n.id)).toEqual([]);
    for (const source of [
      { id: "untrusted", ownerId: " " },
      { id: "other-source", ownerId: "person:A" },
    ]) {
      await db.sql.query(
        "INSERT INTO memory_native_sources(id,scope,source) VALUES('untrusted',$1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET source=EXCLUDED.source",
        [scope, JSON.stringify(source)],
      );
      await expect(put(db, "unsupported", [n])).rejects.toThrow(
        "memory_source_proof_missing",
      );
    }
    await db.information.synchronizeKinds(["memory.native.source.v1"]);
    await db.information.append(
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: "memory-native-source:untrusted",
          kind: "memory.native.source.v1",
          source: "test:memory",
          occurredAt: "2020-01-01T00:00:00Z",
          references: [],
          payload: {
            memorySource: { id: "untrusted", ownerId: "person:A" },
            sourceProofVersion: 1,
            sourceOwners: ["person:A", 17],
          },
        }),
      ),
      [],
    );
    await expect(put(db, "unsupported", [n])).rejects.toThrow(
      "memory_source_proof_missing",
    );
  });

  it.each([true, false])(
    "splits legacy source kinds only with stored server proof: %s",
    async (verified) => {
      const db = await setup(create);
      await db.information.synchronizeKinds(["test.legacy.evidence"]);
      for (const informationId of ["old-S1", "old-S2"])
        await db.information.append(
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId,
              kind: "test.legacy.evidence",
              source: "test:memory",
              occurredAt: "2020-01-01T00:00:00Z",
              payload: {},
              references: [],
            }),
          ),
          [],
        );
      const root = node(1, 1, ["old-S1", "old-S2"]);
      root.metadata.kind = "experience";
      root.metadata.experience = {
        state: "open",
        policyVersion: "legacy",
        predecessors: [],
        ...(verified
          ? {
              proofOwners: [
                { ownerId: "person:A", sourceIds: ["old-S1"] },
                { ownerId: "person:B", sourceIds: ["old-S2"] },
              ],
            }
          : {}),
      };
      if (verified)
        root.metadata.proofOwners = root.metadata.experience.proofOwners!;
      else
        root.metadata.experience.proofOwners = [
          {
            ownerId: root.metadata.ownerId,
            sourceIds: root.metadata.sourceIds,
          },
        ];
      // 旧证据类型可复用已存完整服务端映射；旧 nested 派生 owner 不足以证明完整性。
      await db.sql.query(
        "INSERT INTO memory_nodes(id,metadata,content) VALUES($1,$2::jsonb,$3)",
        [root.id, JSON.stringify(root.metadata), root.content],
      );
      const outputs = [node(2, 1, ["old-S1"]), node(3, 1, ["old-S2"])];
      for (const n of outputs) {
        n.metadata.kind = "experience";
        n.metadata.experience = {
          state: "open",
          policyVersion: "manual.v1",
          predecessors: [root.id],
        };
      }
      const result = put(
        db,
        "legacy-split",
        [
          {
            ...root,
            metadata: { ...root.metadata, revision: 2, status: "archived" },
          },
          ...outputs,
        ],
        {
          experienceOperation: {
            kind: "split",
            inputIds: [root.id],
            outputIds: outputs.map((n) => n.id),
          },
        },
      );
      if (!verified) {
        await expect(result).rejects.toThrow("memory_source_proof_missing");
        expect(await db.memoryGraph.native.history(outputs[0]!.id)).toEqual([]);
        const removed = await put(db, "remove-unproved", [
          {
            ...root,
            metadata: { ...root.metadata, revision: 2, sourceIds: [] },
          },
        ]);
        expect(removed[0]!.metadata.proofOwners).toBeUndefined();
        expect(removed[0]!.metadata.experience!.proofOwners).toEqual(
          root.metadata.experience!.proofOwners,
        );
        await expect(
          put(db, "readd-unproved", [
            { ...root, metadata: { ...root.metadata, revision: 3 } },
          ]),
        ).rejects.toThrow("memory_source_proof_missing");
        expect(await db.memoryGraph.native.history(root.id)).toHaveLength(1);
        return;
      }
      await result;
      await put(db, "legacy-A-split", [], {
        invalidations: [
          {
            kind: "identity-split",
            targetId: "person:A",
            reason: "旧来源拆分",
          },
        ],
      });
      expect(
        (
          await db.memoryGraph.native.current(
            input,
            outputs.map((n) => n.id),
          )
        ).map((n) => n.id),
      ).toEqual([outputs[1]!.id]);
    },
  );
  it("keeps historical text and edges while current revisions change", async () => {
    const db = await setup(create),
      a = node(1, 0),
      b = node(2),
      c = node(3);
    await put(db, "first", [a, b, c], {
      edges: [{ sourceId: a.id, targetId: b.id, relation: "related" }],
    });
    const access = createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    });
    const old = await access.freeze(input);
    await put(
      db,
      "second",
      [{ ...b, content: "新的结论", metadata: { ...b.metadata, revision: 2 } }],
      {
        expectedVersions: { [a.id]: 1, [c.id]: 1 },
        removeEdges: [{ sourceId: a.id, targetId: b.id, relation: "related" }],
        edges: [{ sourceId: a.id, targetId: c.id, relation: "related" }],
      },
    );
    expect(
      (
        await db.memoryGraph.native.current({ ...input, cutoff: old.cutoff! }, [
          b.id,
        ])
      )[0]!.content,
    ).toBe(b.content);
    expect(
      (
        await db.memoryGraph.native.expand({ ...input, cutoff: old.cutoff! }, [
          a.id,
        ])
      ).map((x) => x.node.id),
    ).toEqual([b.id]);
    expect(
      (await db.memoryGraph.native.expand(input, [a.id])).map((x) => x.node.id),
    ).toEqual([c.id]);
    expect(old.recalled.find((x) => x.node.id === b.id)?.node.content).toBe(
      b.content,
    );
  });
  it("withdraws proof descendants on every read and rechecks stale auxiliary candidates", async () => {
    const db = await setup(create);
    await source(db, "S");
    const a = node(1, 0),
      b = node(2, 1, ["S"]),
      c = node(3, 1),
      other = {
        ...node(4, 0),
        metadata: { ...node(4, 0).metadata, ownerId: "person:b" },
      };
    await put(db, "first", [a, b, c, other], {
      edges: [
        { sourceId: a.id, targetId: b.id, relation: "summarizes" },
        { sourceId: b.id, targetId: c.id, relation: "related" },
      ],
    });
    const prior = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    const access = createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
      retrievers: [
        {
          identity: "stale",
          role: "semantic",
          search: async () => {
            await put(db, "withdraw", [], {
              invalidations: [
                {
                  kind: "source-withdrawal",
                  targetId: "S",
                  reason: "原作者撤回",
                },
              ],
            });
            return [a, b];
          },
        },
      ],
    });
    const fresh = await access.freeze(input);
    expect(fresh.fixed).toEqual([]);
    expect(fresh.recalled.some((r) => [a.id, b.id].includes(r.node.id))).toBe(
      false,
    );
    expect(
      (await db.memoryGraph.native.candidates(input)).every(
        (r) => ![a.id, b.id].includes(r.node.id),
      ),
    ).toBe(true);
    expect(await db.memoryGraph.native.expand(input, [a.id, b.id])).toEqual([]);
    expect(await db.memoryGraph.native.current(input, [b.id])).toEqual([]);
    expect(await db.memoryGraph.native.current(input, [c.id])).toHaveLength(1);
    expect(
      (
        await db.memoryGraph.native.personCandidates({ ...input, owners: [] })
      ).map((x) => x.summary.id),
    ).toEqual([other.id]);
    expect(prior.fixed.map((n) => n.id)).toContain(a.id);
    expect(
      (
        await db.memoryGraph.native.readFixed({
          ...input,
          cutoff: prior.cutoff!,
        })
      ).map((n) => n.id),
    ).toContain(a.id);
    await put(db, "split-identity", [], {
      invalidations: [
        { kind: "identity-split", targetId: "person:b", reason: "账号拆分" },
      ],
    });
    expect(
      await db.memoryGraph.native.personCandidates({ ...input, owners: [] }),
    ).toEqual([]);
  });
  it("pages over 100 revisions at a fixed upper without exposing co-published nodes", async () => {
    const db = await setup(create),
      n = node(1),
      secret = node(2);
    await put(db, "r1", [n, secret]);
    const hash = (
      await db.sql.query<{ input_hash: string }>(
        "SELECT input_hash FROM memory_native_publications WHERE operation_id='r1'",
      )
    ).rows[0]!.input_hash;
    for (let revision = 2; revision <= 105; revision++)
      await put(db, `r${revision}`, [
        {
          ...n,
          content: `修订${revision}`,
          metadata: { ...n.metadata, revision },
        },
      ]);
    let page = await db.memoryGraph.native.historyPage(n.id, { limit: 17 });
    const upper = page.upper;
    const revisions = page.items.map((r) => r.node.metadata.revision);
    await put(db, "r106", [
      { ...n, metadata: { ...n.metadata, revision: 106 } },
    ]);
    while (page.nextCursor) {
      page = await db.memoryGraph.native.historyPage(n.id, {
        limit: 17,
        cursor: page.nextCursor,
      });
      expect(page.upper).toBe(upper);
      expect(page.items.every((r) => r.node.id === n.id)).toBe(true);
      revisions.push(...page.items.map((r) => r.node.metadata.revision));
    }
    expect(revisions).toEqual(Array.from({ length: 105 }, (_, i) => 105 - i));
    expect(
      JSON.stringify(await db.memoryGraph.native.history(n.id)),
    ).not.toContain(secret.content);
    await db.prepareSchema();
    expect(
      (
        await db.sql.query<{ input_hash: string }>(
          "SELECT input_hash FROM memory_native_publications WHERE operation_id='r1'",
        )
      ).rows[0]!.input_hash,
    ).toBe(hash);
    expect(await put(db, "r1", [n, secret])).toEqual([n, secret]);
  }, 30000);
  it("merges and splits explicit evidence atomically and rejects scope or stale revision changes", async () => {
    const db = await setup(create);
    await source(db, "S1");
    await source(db, "S2");
    const experience = (n: number, sources: string[]): NativeMemoryNode => ({
      ...node(n, 1, sources),
      metadata: {
        ...node(n, 1, sources).metadata,
        kind: "experience",
        experience: {
          state: "open",
          policyVersion: "manual.v1",
          predecessors: [],
        },
      },
    });
    const e1 = experience(1, ["S1"]),
      e2 = experience(2, ["S2"]);
    await put(db, "initial", [e1, e2]);
    const archive = (n: NativeMemoryNode) => ({
      ...n,
      metadata: {
        ...n.metadata,
        revision: n.metadata.revision + 1,
        status: "archived" as const,
      },
    });
    const e3 = experience(3, ["S1", "S2"]);
    e3.metadata.experience!.predecessors = [e1.id, e2.id];
    const merge = {
      experienceOperation: {
        kind: "merge",
        inputIds: [e1.id, e2.id],
        outputIds: [e3.id],
      },
    };
    await expect(
      put(
        db,
        "private-merge",
        [
          archive(e1),
          archive(e2),
          { ...e3, metadata: { ...e3.metadata, scope: "other-private" } },
        ],
        merge,
      ),
    ).rejects.toThrow("memory_experience_scope");
    const existingOutput = experience(6, ["S1", "S2"]);
    await put(db, "existing-output", [existingOutput]);
    await expect(
      put(
        db,
        "overwrite-output",
        [
          archive(e1),
          archive(e2),
          {
            ...existingOutput,
            metadata: { ...existingOutput.metadata, revision: 2 },
          },
        ],
        {
          experienceOperation: {
            ...merge.experienceOperation,
            outputIds: [existingOutput.id],
          },
        },
      ),
    ).rejects.toThrow("memory_invalid_experience");
    await put(db, "merge", [archive(e1), archive(e2), e3], merge);
    const duplicate = experience(7, ["S1", "S2"]);
    duplicate.metadata.experience!.predecessors = [e1.id, e2.id];
    await expect(
      put(
        db,
        "reuse-archived",
        [
          {
            ...archive(e1),
            metadata: { ...archive(e1).metadata, revision: 3 },
          },
          {
            ...archive(e2),
            metadata: { ...archive(e2).metadata, revision: 3 },
          },
          duplicate,
        ],
        {
          experienceOperation: {
            ...merge.experienceOperation,
            outputIds: [duplicate.id],
          },
        },
      ),
    ).rejects.toThrow("memory_invalid_experience");
    await expect(put(db, "stale", [archive(e1)])).rejects.toThrow(
      "memory_revision_conflict",
    );
    const e4 = experience(4, ["S1"]),
      e5 = experience(5, ["S2"]);
    e4.metadata.experience!.predecessors = [e3.id];
    e5.metadata.experience!.predecessors = [e3.id];
    await put(db, "split", [archive(e3), e4, e5], {
      experienceOperation: {
        kind: "split",
        inputIds: [e3.id],
        outputIds: [e4.id, e5.id],
      },
    });
    expect(
      (
        await db.memoryGraph.native.current(input, [
          e1.id,
          e2.id,
          e3.id,
          e4.id,
          e5.id,
        ])
      ).map((n) => n.id),
    ).toEqual([e4.id, e5.id]);
    expect(await db.memoryGraph.native.history(e1.id)).toHaveLength(2);
    const sealed = {
      ...e4,
      metadata: {
        ...e4.metadata,
        revision: 2,
        experience: { ...e4.metadata.experience!, state: "sealed" as const },
      },
    };
    await put(db, "seal", [sealed], {
      experienceOperation: {
        kind: "seal",
        inputIds: [e4.id],
        outputIds: [e4.id],
      },
    });
    await put(
      db,
      "reopen",
      [
        {
          ...sealed,
          metadata: {
            ...sealed.metadata,
            revision: 3,
            experience: { ...sealed.metadata.experience!, state: "open" },
          },
        },
      ],
      {
        experienceOperation: {
          kind: "reopen",
          inputIds: [e4.id],
          outputIds: [e4.id],
        },
      },
    );
  });
  it("keeps current read body counts independent of unrelated scope history", async () => {
    const db = await setup(create);
    await put(db, "visible", [node(1)]);
    const bodies: string[] = [];
    const instrument = (
      tx: import("./driver.js").SqlTransaction,
    ): import("./driver.js").SqlTransaction => ({
      exec: tx.exec.bind(tx),
      query: async (sql, values) => {
        const result = await tx.query(sql, values);
        for (const row of result.rows)
          if ("content" in row || "nodes" in row || "node" in row)
            bodies.push(JSON.stringify(row));
        return result as never;
      },
    });
    const measured = new KaguyaDatabase({
      query: instrument(db.sql).query,
      exec: db.sql.exec.bind(db.sql),
      close: async () => {},
      transaction: (run) => db.sql.transaction((tx) => run(instrument(tx))),
    });
    const access = createNativeMemoryAccess({
      enabled: true,
      store: measured.memoryGraph.native,
    });
    await access.freeze(input);
    const count = bodies.length;
    bodies.length = 0;
    for (let revision = 1; revision <= 30; revision++)
      await put(db, `foreign-${revision}`, [
        {
          ...node(9),
          content: "私聊正文不能随A群读取",
          metadata: { ...node(9).metadata, scope: "foreign-private", revision },
        },
      ]);
    await access.freeze(input);
    expect(bodies.length).toBe(count);
    expect(bodies.join("")).not.toContain("私聊正文");
    bodies.length = 0;
    await measured.memoryGraph.native.current(input, [id(1)]);
    expect(bodies).toHaveLength(1);
  }, 20000);
  it("blocks cross-scope proof chains and rejects laundering a withdrawn dependency", async () => {
    const db = await setup(create);
    await source(db, "dependency");
    await source(db, "new-evidence");
    const a = node(1, 0, ["new-evidence"]),
      b = { ...node(2), metadata: { ...node(2).metadata, scope: "private" } },
      c = {
        ...node(3, 1, ["dependency"]),
        metadata: { ...node(3, 1, ["dependency"]).metadata, scope: "private" },
      };
    await put(db, "chain", [a, b, c], {
      edges: [
        { sourceId: a.id, targetId: b.id, relation: "derived-from" },
        { sourceId: b.id, targetId: c.id, relation: "derived-from" },
      ],
    });
    const prior = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    await put(db, "withdraw-chain", [], {
      invalidations: [
        {
          kind: "source-withdrawal",
          targetId: "dependency",
          reason: "原话撤回",
        },
      ],
    });
    expect(await db.memoryGraph.native.readFixed(input)).toEqual([]);
    expect(await db.memoryGraph.native.forFormation(input)).toEqual([]);
    expect(
      (
        await db.memoryGraph.native.readFixed({
          ...input,
          cutoff: prior.cutoff!,
        })
      ).map((n) => n.id),
    ).toEqual([a.id]);
    await expect(
      db.memoryGraph.native.publish({
        operationId: "launder",
        actor: "automatic",
        nodes: [
          {
            node: {
              ...a,
              content: "去掉依赖后的旧结论",
              metadata: { ...a.metadata, revision: 2 },
            },
            expectedRevision: 1,
          },
        ],
        expectedVersions: { [b.id]: 1 },
        removeEdges: [
          { sourceId: a.id, targetId: b.id, relation: "derived-from" },
        ],
      }),
    ).rejects.toThrow("memory_source_invalidated");
  });
  it("does not resurrect a historical revision after its scope changes", async () => {
    const db = await setup(create);
    const n = node(1);
    await put(db, "old-scope", [n]);
    await put(db, "moved", [
      { ...n, metadata: { ...n.metadata, scope: "private", revision: 2 } },
    ]);
    const upper = await db.memoryGraph.native.cutoff(input);
    await put(db, "later", [node(2)]);
    expect(
      await db.memoryGraph.native.current({ ...input, cutoff: upper }, [n.id]),
    ).toEqual([]);
  });
  it("budgets newest pending corrections, marks truncation and preserves source handles", async () => {
    const db = await setup(create);
    for (let i = 0; i < 4; i++)
      await source(
        db,
        `pending-${i}`,
        i === 3 ? "最新更正" + "长".repeat(130000) : "旧".repeat(30000),
      );
    const frozen = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    expect(frozen.pendingEvidence![0]!.informationId).toBe("pending-3");
    expect(frozen.pendingEvidence![0]!.text).toContain("最新更正");
    expect(frozen.pendingEvidence!.every((e) => e.truncated)).toBe(true);
    expect(frozen.evidenceHasMore).toBe(true);
    expect(frozen.budget.dynamicCharacters).toBe(2000);
    expect(frozen.evidenceOmittedInformationIds).toEqual([
      "pending-1",
      "pending-0",
    ]);
    expect(frozen.pendingEvidence![0]!.originalCharacters).toBe(130004);
  });
  it("rejects missing Memory proof, private historical nodes and forged owners", async () => {
    const db = await setup(create);
    await source(db, "proof-source");
    await db.memoryGraph.native.recover();
    const batch = (await db.memoryGraph.native.claim(scope, true))!;
    const owner = batch.sources[0]!.ownerId;
    const secret = {
      ...node(1),
      metadata: { ...node(1).metadata, ownerId: owner, scope: "private-other" },
    };
    await put(db, "secret", [secret]);
    const snapshot = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).prepare({ ...input, owners: [owner] });
    const contract = {
      consumerId: "memory.native",
      policyVersion: "native-formation.v1",
      address: {
        platform: "qq",
        adapterId: "qq",
        destination: { kind: "group" as const, groupId: "G" },
      },
      kinds: ["memory.native.source.v1"],
      resultKind: "memory.native.observation.completed.v1",
    };
    await expect(db.observations.freezeNext(contract)).rejects.toThrow(
      "Observation contract",
    );
    await db.information.synchronizeKinds([
      "memory.native.formation.requested.v1",
    ]);
    for (const [i, existing] of [
      {
        ...snapshot,
        recalled: [{ node: secret, traces: [], truncated: false }],
      },
      { ...snapshot, owners: [owner, "person:forged"] },
    ].entries()) {
      const requestId = `request-proof-${i}`,
        payload = {
          batchId: batch.id,
          scope,
          sources: batch.sources,
          existing,
        };
      await db.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId: requestId,
            kind: "memory.native.formation.requested.v1",
            source: "test:memory",
            occurredAt: "2026-01-01T00:00:00Z",
            payload,
            references: [],
          }),
        ),
        [],
      );
      const manifest = observationManifestSchema.parse({
        version: 1,
        proofKind: "memory-native",
        runInformationId: requestId,
        frozenInformationId: requestId,
        sourceInformationIds: ["memory-native-source:proof-source"],
        knowledgeCutoff: {
          informationId: requestId,
          memoryPublicationPosition: existing.cutoff!.publicationPosition,
          memoryRevisions: existing.recalled.map((r) => ({
            id: r.node.id,
            revision: r.node.metadata.revision,
          })),
        },
        content: payload,
      });
      await expect(
        db.observations.freezeNext({ ...contract, manifest }),
      ).rejects.toThrow("Observation contract");
    }
  });
});

it.skipIf(!url)(
  "orders canonical-source commits before Memory publications (real PostgreSQL)",
  async () => {
    const db = await setup(() => createPostgresTestingDatabase(url!));
    await source(db, "S");
    const n = node(1, 0, ["S"]);
    n.metadata.ownerId = `conversation:${scope}`;
    n.metadata.kind = "conversation";
    await db.information.synchronizeKinds(["memory.native.revision.v1"]);
    await db.information.append(
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: "legacy-prefix",
          kind: "memory.native.revision.v1",
          source: "memory:manual",
          occurredAt: "2026-01-01T00:00:00Z",
          references: [],
          payload: {
            operationId: "legacy-prefix",
            nodes: [n],
            edges: [],
            removeEdges: [],
          },
        }),
      ),
      [],
    );
    await db.sql.query(
      "INSERT INTO memory_nodes(id,metadata,content) VALUES($1,$2::jsonb,$3)",
      [n.id, JSON.stringify(n.metadata), n.content],
    );
    await db.sql.query(
      "INSERT INTO memory_native_publications(operation_id,input_hash,information_id,nodes) VALUES('legacy-prefix','legacy-fixture','legacy-prefix',$1::jsonb)",
      [JSON.stringify([n])],
    );
    let release!: () => void,
      entered = false,
      waiterPid: number | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = new KaguyaDatabase({
      query: db.sql.query.bind(db.sql),
      exec: db.sql.exec.bind(db.sql),
      close: async () => {},
      transaction: (run) =>
        db.sql.transaction(async (tx) => {
          const result = await run(tx);
          entered = true;
          await gate;
          return result;
        }),
    });
    const other = new KaguyaDatabase({
      query: db.sql.query.bind(db.sql),
      exec: db.sql.exec.bind(db.sql),
      close: async () => {},
      transaction: (run) =>
        db.sql.transaction(async (tx) => {
          waiterPid = (
            await tx.query<{ pid: number }>("SELECT pg_backend_pid() pid")
          ).rows[0]!.pid;
          return run(tx);
        }),
    });
    const pending = writer.memoryGraph.native.ingest({
      id: "S",
      scope,
      ownerId: "person:A",
      text: "原文",
      occurredAt: "2020-01-01T00:00:00Z",
      collectedAt: "2026-01-01T00:00:00Z",
      sourceType: "inbound",
      participants: [],
      replyTo: null,
    });
    const tasks: Promise<unknown>[] = [pending];
    let backgroundError: unknown, mainError: unknown;
    void pending.catch((error) => {
      backgroundError = error;
    });
    try {
      await vi.waitFor(
        () => {
          if (backgroundError) throw backgroundError;
          expect(entered).toBe(true);
        },
        { timeout: 8000, interval: 20 },
      );
      const competing = put(other, "after-canonical", [node(2)]);
      tasks.push(competing);
      void competing.catch((error) => {
        backgroundError = error;
      });
      await vi.waitFor(
        async () => {
          if (backgroundError) throw backgroundError;
          expect(waiterPid).toBeDefined();
          expect(
            (
              await db.sql.query(
                "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                [waiterPid],
              )
            ).rowCount,
          ).toBe(1);
        },
        { timeout: 8000, interval: 20 },
      );
      const context = { ...input, owners: [n.metadata.ownerId] };
      const before = await createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      }).freeze(context);
      expect(before.fixed).toEqual([]);
      release();
      await Promise.all(tasks);
      expect(
        (await db.memoryGraph.native.current(context, [n.id])).map((n) => n.id),
      ).toEqual([n.id]);
      expect(
        await db.memoryGraph.native.current(
          { ...context, cutoff: before.cutoff! },
          [n.id],
        ),
      ).toEqual([]);
    } catch (error) {
      mainError = error;
    } finally {
      release();
      const finished = await Promise.allSettled(tasks);
      const errors = [
        ...new Set([
          ...(mainError ? [mainError] : []),
          ...finished.flatMap((r) =>
            r.status === "rejected" ? [r.reason] : [],
          ),
        ]),
      ];
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Canonical commit barrier failed");
    }
  },
  30000,
);

it.skipIf(!url)(
  "freezes a committed Memory prefix while an earlier position is uncommitted (real PostgreSQL)",
  async () => {
    const db = await setup(() => createPostgresTestingDatabase(url!));
    const n = node(1);
    await put(db, "baseline", [n]);
    let release!: () => void,
      entered = false;
    const gate = new Promise<void>((r) => (release = r));
    const wrapped: SqlDatabase = {
      query: db.sql.query.bind(db.sql),
      exec: db.sql.exec.bind(db.sql),
      close: async () => {},
      transaction: (run) =>
        db.sql.transaction(async (tx) => {
          const result = await run(tx);
          entered = true;
          await gate;
          return result;
        }),
    };
    const writer = new KaguyaDatabase(wrapped);
    const pending = put(writer, "blocked", [
      { ...n, content: "未提交更正", metadata: { ...n.metadata, revision: 2 } },
    ]);
    let publicationError: unknown;
    void pending.catch((error) => {
      publicationError = error;
    });
    try {
      await vi.waitFor(
        () => {
          if (publicationError) throw publicationError;
          expect(entered).toBe(true);
        },
        { timeout: 8000, interval: 20 },
      );
      const access = createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      });
      const frozen = await access.freeze(input);
      await source(db, "later-K");
      const k = (
        await db.sql.query<{ position: string }>(
          "SELECT position::text FROM information_lifecycle WHERE information_id='later-K'",
        )
      ).rows[0]!.position;
      expect(BigInt(k)).toBeGreaterThan(
        BigInt(frozen.cutoff!.publicationPosition),
      );
      release();
      await pending;
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: frozen.cutoff! },
            [n.id],
          )
        )[0]!.content,
      ).toBe(n.content);
      expect(
        (await access.freeze(input)).fixed
          .concat((await access.freeze(input)).recalled.map((r) => r.node))
          .some((n) => n.content === "未提交更正"),
      ).toBe(true);
      const cursor = Buffer.from(
        JSON.stringify({
          nodeId: n.id,
          upper: frozen.cutoff!.publicationPosition,
          before: k,
        }),
      ).toString("base64url");
      expect(
        (await db.memoryGraph.native.historyPage(n.id, { cursor })).items.map(
          (r) => r.node.metadata.revision,
        ),
      ).toEqual([1]);
    } finally {
      release();
      await pending;
    }
  },
  20000,
);

describe.each(backends)("native inherited evidence ($name)", ({ create }) => {
  async function splitFixture() {
    const db = await setup(create);
    for (const s of ["S1", "S2", "S3"]) await source(db, s);
    const experience = (n: number, sources: string[]): NativeMemoryNode => ({
      ...node(n, 1, sources),
      metadata: {
        ...node(n, 1, sources).metadata,
        kind: "experience",
        experience: {
          state: "open",
          policyVersion: "manual.v1",
          predecessors: [],
        },
      },
    });
    const root = experience(1, ["S1", "S2"]);
    const dependency = node(2, 2, ["S1"]);
    dependency.metadata.ownerId = "person:dependency";
    await put(db, "inputs", [root, dependency], {
      edges: [
        {
          sourceId: root.id,
          targetId: dependency.id,
          relation: "derived-from",
        },
      ],
    });
    const x = experience(3, ["S1"]),
      y = experience(4, ["S2"]);
    x.metadata.experience!.predecessors = [root.id];
    y.metadata.experience!.predecessors = [root.id];
    await put(
      db,
      "split",
      [
        {
          ...root,
          metadata: { ...root.metadata, revision: 2, status: "archived" },
        },
        x,
        y,
      ],
      {
        experienceOperation: {
          kind: "split",
          inputIds: [root.id],
          outputIds: [x.id, y.id],
        },
      },
    );
    return { db, x, y };
  }
  it.each(["seal", "reopen", "correct", "plain"] as const)(
    "keeps server proof ownership through %s when callers omit, clear or forge it",
    async (kind) => {
      const { db, x, y } = await splitFixture();
      const before = await db.memoryGraph.native.cutoff(input);
      for (const [i, clientProof] of [
        undefined,
        [],
        [{ ownerId: "person:forged", sourceIds: ["S1"] }],
      ].entries()) {
        const revised: NativeMemoryNode = {
          ...x,
          metadata: {
            ...x.metadata,
            revision: i + 2,
            experience: {
              ...x.metadata.experience!,
              state: kind === "seal" ? "sealed" : "open",
              ...(clientProof === undefined
                ? {}
                : { proofOwners: clientProof }),
            },
          },
        };
        const op =
          kind === "plain"
            ? {}
            : {
                experienceOperation: {
                  kind,
                  inputIds: [x.id],
                  outputIds: [x.id],
                },
              };
        const published = await put(db, `edit-${i}`, [revised], op);
        expect(published[0]!.metadata.experience!.proofOwners).toContainEqual({
          ownerId: "person:dependency",
          sourceIds: ["S1"],
        });
        expect(
          published[0]!.metadata.experience!.proofOwners!.some(
            (p) => p.ownerId === "person:forged",
          ),
        ).toBe(false);
        expect(await put(db, `edit-${i}`, [revised], op)).toEqual(published);
      }
      const edited = await db.memoryGraph.native.cutoff(input);
      await put(db, "identity-split", [], {
        invalidations: [
          {
            kind: "identity-split",
            targetId: "person:dependency",
            reason: "拆分证据身份",
          },
        ],
      });
      const invalidated = await db.memoryGraph.native.cutoff(input);
      expect(
        (await db.memoryGraph.native.current(input, [x.id, y.id])).map(
          (n) => n.id,
        ),
      ).toEqual([y.id]);
      await put(db, "later", [node(8)]);
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: invalidated },
            [x.id, y.id],
          )
        ).map((n) => n.id),
      ).toEqual([y.id]);
      expect(
        (
          await db.memoryGraph.native.current({ ...input, cutoff: edited }, [
            x.id,
          ])
        )[0]!.metadata.revision,
      ).toBe(4);
      expect(
        (
          await db.memoryGraph.native.current({ ...input, cutoff: before }, [
            x.id,
          ])
        )[0]!.metadata.revision,
      ).toBe(1);
    },
  );
  it("deactivates removed evidence, restores its proof on re-add, and derives new owners from canonical sources", async () => {
    const { db, x, y } = await splitFixture();
    const edit = (revision: number, sourceIds: string[]) =>
      put(
        db,
        `correct-${revision}`,
        [
          {
            ...x,
            metadata: {
              ...x.metadata,
              revision,
              sourceIds,
              experience: {
                ...x.metadata.experience!,
                proofOwners: [{ ownerId: "person:forged", sourceIds }],
              },
            },
          },
        ],
        {
          experienceOperation: {
            kind: "correct",
            inputIds: [x.id],
            outputIds: [x.id],
          },
        },
      );
    await db.memoryGraph.native.ingest({
      id: "S3",
      scope,
      ownerId: "person:new-source",
      text: "原文",
      occurredAt: "2020-01-01T00:00:00Z",
      collectedAt: "2026-01-01T00:00:00Z",
      sourceType: "inbound",
      participants: [],
      replyTo: null,
    });
    const removed = await edit(2, ["S3"]);
    expect(removed[0]!.metadata.experience!.proofOwners).toEqual([
      { ownerId: `conversation:${scope}`, sourceIds: ["S1", "S3"] },
      { ownerId: "person:a", sourceIds: ["S1"] },
      { ownerId: "person:dependency", sourceIds: ["S1"] },
      { ownerId: "person:new-source", sourceIds: ["S3"] },
    ]);
    await put(db, "identity-split", [], {
      invalidations: [
        {
          kind: "identity-split",
          targetId: "person:dependency",
          reason: "移除来源不影响当前正文",
        },
      ],
    });
    const removedUpper = await db.memoryGraph.native.cutoff(input);
    expect(
      (await db.memoryGraph.native.current(input, [x.id, y.id]))
        .map((n) => n.id)
        .sort(),
    ).toEqual([x.id, y.id]);
    await edit(3, ["S1", "S3"]);
    const readdedUpper = await db.memoryGraph.native.cutoff(input);
    expect(
      (await db.memoryGraph.native.current(input, [x.id, y.id])).map(
        (n) => n.id,
      ),
    ).toEqual([y.id]);
    await put(db, "later", [node(8)]);
    expect(
      (
        await db.memoryGraph.native.current(
          { ...input, cutoff: readdedUpper },
          [x.id, y.id],
        )
      ).map((n) => n.id),
    ).toEqual([y.id]);
    expect(
      (
        await db.memoryGraph.native.current(
          { ...input, cutoff: removedUpper },
          [x.id, y.id],
        )
      ).map((n) => n.id),
    ).toEqual([x.id, y.id]);
    // 真正换成独立来源后，新来源的正规归属仍控制后续身份失效。
    await edit(4, ["S3"]);
    await put(db, "invalidate-new-source", [], {
      invalidations: [
        {
          kind: "identity-split",
          targetId: "person:new-source",
          reason: "新证据身份拆分",
        },
      ],
    });
    expect(
      (await db.memoryGraph.native.current(input, [x.id, y.id])).map(
        (n) => n.id,
      ),
    ).toEqual([y.id]);
  });
  it("preserves transitive merge evidence and excludes inherited archive status", async () => {
    const db = await setup(create);
    for (const s of ["S1", "S2", "S3"]) await source(db, s);
    const experience = (n: number, sources: string[]): NativeMemoryNode => ({
      ...node(n, 1, sources),
      metadata: {
        ...node(n, 1, sources).metadata,
        kind: "experience",
        experience: {
          state: "open",
          policyVersion: "manual.v1",
          predecessors: [],
        },
      },
    });
    const a = experience(1, ["S1"]),
      b = experience(2, ["S3"]),
      c = node(3, 2, ["S2"]);
    await put(db, "inputs", [a, b, c], {
      edges: [{ sourceId: a.id, targetId: c.id, relation: "derived-from" }],
    });
    const archive = (n: NativeMemoryNode) => ({
      ...n,
      metadata: { ...n.metadata, revision: 2, status: "archived" as const },
    });
    const d = experience(4, ["S1", "S3"]);
    d.metadata.experience!.predecessors = [a.id, b.id];
    const op = {
      experienceOperation: {
        kind: "merge",
        inputIds: [a.id, b.id],
        outputIds: [d.id],
      },
    };
    await expect(
      put(db, "missing-proof", [archive(a), archive(b), d], op),
    ).rejects.toThrow("memory_experience_sources");
    d.metadata.sourceIds = ["S1", "S2", "S3"];
    await put(db, "merged", [archive(a), archive(b), d], op);
    expect(await db.memoryGraph.native.current(input, [d.id])).toHaveLength(1);
    const upper = await db.memoryGraph.native.cutoff(input);
    await put(db, "withdraw-inherited", [], {
      invalidations: [
        { kind: "source-withdrawal", targetId: "S2", reason: "撤回间接证据" },
      ],
    });
    expect(await db.memoryGraph.native.current(input, [d.id])).toEqual([]);
    expect(
      await db.memoryGraph.native.current({ ...input, cutoff: upper }, [d.id]),
    ).toHaveLength(1);
  });
  it.each(["source-withdrawal", "identity-split"] as const)(
    "keeps the unrelated split branch after %s, including historical reads",
    async (kind) => {
      const db = await setup(create);
      await source(db, "split-S1");
      await source(db, "split-S2");
      const experience = (n: number, sources: string[]): NativeMemoryNode => ({
        ...node(n, 1, sources),
        metadata: {
          ...node(n, 1, sources).metadata,
          kind: "experience",
          experience: {
            state: "open",
            policyVersion: "manual.v1",
            predecessors: [],
          },
        },
      });
      const e = experience(1, ["split-S1", "split-S2"]),
        dependency = {
          ...node(3, 2, ["split-S1"]),
          metadata: {
            ...node(3, 2, ["split-S1"]).metadata,
            ownerId: "person:dependency",
          },
        };
      await put(db, "split-root", [e, dependency], {
        edges: [
          { sourceId: e.id, targetId: dependency.id, relation: "derived-from" },
        ],
      });
      const access = createNativeMemoryAccess({
          enabled: true,
          store: db.memoryGraph.native,
        }),
        before = await access.freeze(input);
      const x = experience(4, ["split-S1"]),
        y = experience(5, ["split-S2"]);
      x.metadata.experience!.predecessors = [e.id];
      y.metadata.experience!.predecessors = [e.id];
      await put(
        db,
        "split-branches",
        [
          {
            ...e,
            metadata: { ...e.metadata, revision: 2, status: "archived" },
          },
          x,
          y,
        ],
        {
          experienceOperation: {
            kind: "split",
            inputIds: [e.id],
            outputIds: [x.id, y.id],
          },
        },
      );
      const frozen = await access.freeze({
          ...input,
          explicitIds: [x.id, y.id],
        }),
        saved = JSON.stringify(frozen);
      const actual = await db.memoryGraph.native.current(input, [x.id, y.id]);
      expect(actual).toHaveLength(2);
      expect(
        actual.find((n) => n.id === x.id)!.metadata.experience!.proofOwners,
      ).toContainEqual({
        ownerId: "person:dependency",
        sourceIds: ["split-S1"],
      });
      expect(
        actual
          .find((n) => n.id === y.id)!
          .metadata.experience!.proofOwners!.some(
            (p) => p.ownerId === "person:dependency",
          ),
      ).toBe(false);
      await put(db, "split-invalidate", [], {
        invalidations: [
          {
            kind,
            targetId:
              kind === "source-withdrawal" ? "split-S1" : "person:dependency",
            reason: "一侧证据失效",
          },
        ],
      });
      expect(
        (await db.memoryGraph.native.current(input, [x.id, y.id])).map(
          (n) => n.id,
        ),
      ).toEqual([y.id]);
      const upper = await db.memoryGraph.native.cutoff(input);
      await put(db, "later-irrelevant", [node(8)]);
      expect(
        (
          await db.memoryGraph.native.current({ ...input, cutoff: upper }, [
            x.id,
            y.id,
          ])
        ).map((n) => n.id),
      ).toEqual([y.id]);
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: frozen.cutoff! },
            [x.id, y.id],
          )
        ).map((n) => n.id),
      ).toEqual([x.id, y.id]);
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: before.cutoff! },
            [e.id],
          )
        )[0]!.metadata.revision,
      ).toBe(1);
      expect(JSON.stringify(frozen)).toBe(saved);
    },
  );
  it("keeps delivered pending evidence attributed to self before normalization", async () => {
    const db = await setup(create),
      destination = { kind: "group", groupId: "G" };
    await db.information.synchronizeKinds([
      "core.delivery.requested",
      "core.delivery.delivered",
    ]);
    const append = async (
      informationId: string,
      kind: string,
      payload: unknown,
      delivered = false,
    ) =>
      db.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId,
            kind,
            payload,
            occurredAt: "2020-01-01T00:00:00Z",
            source: "test:memory",
            references: delivered
              ? [
                  {
                    relation: "core:status-of",
                    informationId: "delivery-request",
                  },
                ]
              : [],
          }),
        ),
        delivered
          ? [{ relation: "core:status-of", required: true, multiple: false }]
          : [],
      );
    await append("delivery-request", "core.delivery.requested", {
      platform: "qq",
      adapterId: "qq",
      destination,
      message: { text: "我会准备材料" },
    });
    await append(
      "delivered",
      "core.delivery.delivered",
      { platform: "qq", adapterId: "qq", target: destination, ok: true },
      true,
    );
    const frozen = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    expect(frozen.pendingEvidence).toMatchObject([
      {
        informationId: "delivered",
        ownerId: "self:kaguya",
        text: "自身已经发出的消息（不代表已完成其中承诺的行动）：我会准备材料",
      },
    ]);
    await db.memoryGraph.native.recover();
    expect(
      (await db.memoryGraph.native.claim(scope, true))!.sources[0],
    ).toMatchObject({
      id: "delivered",
      ownerId: "self:kaguya",
      sourceType: "delivered",
    });
  });
  it("keeps future occurredAt outside asOf while accepting newly registered earlier evidence", async () => {
    const db = await setup(create),
      access = createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      });
    await source(db, "before", "此前证据", "2029-12-31T23:59:59Z");
    const frozen = await access.freeze(input);
    await source(db, "future", "下一秒的原话", "2030-01-01T00:00:01Z");
    await source(db, "late", "晚登记的较早更正", "2029-12-31T23:59:58Z");
    const current = await access.freeze(input);
    expect(current.pendingEvidence!.map((e) => e.informationId)).toEqual([
      "late",
      "before",
    ]);
    expect(frozen.pendingEvidence!.map((e) => e.informationId)).toEqual([
      "before",
    ]);
    expect(
      (
        await access.freeze({ ...input, asOf: "2030-01-01T00:00:02Z" })
      ).pendingEvidence!.map((e) => e.informationId),
    ).toContain("future");
  });
});
