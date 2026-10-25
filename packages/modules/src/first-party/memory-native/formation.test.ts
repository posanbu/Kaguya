import { describe, it, expect, vi } from "vitest";
import {
  nativeMemorySnapshotSchema,
  nativeMemoryNodeSchema,
  personEvidenceSchema,
} from "@kaguya/schema";
import type {
  NativeMemoryAccess,
  MemorySource,
  MemoryPublication,
} from "@kaguya/memory";
import { publishFormation } from "./formation.js";
const at = "2026-10-22T00:00:00.000Z";
const group = JSON.stringify(["qq", "qq", "group", "one"]);
const existing = () =>
  nativeMemorySnapshotSchema.parse({
    version: 1,
    status: "enabled",
    frozenAt: at,
    scope: group,
    owners: ["person:a"],
    fixed: [],
    recalled: [],
    degraded: [],
    budget: { dynamicCharacters: 0, omittedNodeIds: [] },
  });
const source = (): MemorySource => ({
  id: "utterance",
  ownerId: "person:a",
  scope: group,
  text: "我在学建筑",
  occurredAt: at,
  collectedAt: at,
  sourceType: "inbound",
  participants: [
    {
      accountId: "a",
      ownerId: "person:a",
      role: "speaker",
      nickname: null,
      card: null,
    },
  ],
  replyTo: null,
});
const proposal = () => ({
  key: "study",
  kind: "person",
  ownerId: "person:a",
  scope: "shared",
  level: 1,
  content: "本人说在学建筑",
  sourceIds: ["utterance"],
  aliases: [],
  tags: [],
  status: "active",
  evidence: {
    basis: "self-report",
    temporality: "stable",
    observedAt: at,
    validFrom: null,
    validUntil: null,
    sourceScope: group,
    supersedes: [] as string[],
  },
});
async function run(nodes: unknown[], sources = [source()], prior = existing()) {
  const publish = vi.fn(async (_input: MemoryPublication) => []);
  const memory: NativeMemoryAccess = {
    enabled: true,
    publish,
    index: async () => {},
    freeze: async () => prior,
    prepare: async () => prior,
    people: async () => [],
    published: async () => undefined,
  };
  const result = await publishFormation(
    { batchId: "batch", scope: prior.scope, sources, existing: prior },
    { status: "completed", output: { nodes, edges: [] } },
    at,
    memory,
  );
  return { result, publish };
}
describe("portrait evidence publication", () => {
  it("shares explicit ordinary stable group self-reports and preserves their observed time", async () => {
    const { result, publish } = await run([proposal()]);
    expect(result.status).toBe("completed");
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      nodes: [
        {
          node: {
            metadata: {
              evidence: {
                basis: "self-report",
                observedAt: at,
                sourceScope: group,
              },
            },
          },
        },
      ],
    });
  });
  it.each([
    { basis: "inference", temporality: "stable" },
    { basis: "third-party", temporality: "stable" },
    { basis: "self-report", temporality: "recent" },
  ])("keeps $basis/$temporality in the source scope", async (evidence) => {
    const n = proposal();
    const value = { ...n, evidence: { ...n.evidence, ...evidence } };
    expect((await run([value])).result.status).toBe("rejected");
    expect((await run([{ ...value, scope: group }])).result.status).toBe(
      "completed",
    );
  });
  it("rejects attribution to a different speaker and private-to-shared promotion", async () => {
    expect(
      (await run([proposal()], [{ ...source(), ownerId: "person:b" }])).result
        .status,
    ).toBe("rejected");
    const privateScope = JSON.stringify(["qq", "qq", "private", "a"]);
    const n = proposal();
    const prior = { ...existing(), scope: privateScope };
    expect(
      (
        await run(
          [{ ...n, evidence: { ...n.evidence, sourceScope: privateScope } }],
          [{ ...source(), scope: privateScope }],
          prior,
        )
      ).result.status,
    ).toBe("rejected");
  });
  it("requires a correction to retire the old detail and keeps legacy evidence unclassified", async () => {
    const old = nativeMemoryNodeSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      content: "此前说在学建筑",
      metadata: {
        system: "native-v1",
        kind: "person",
        ownerId: "person:a",
        scope: group,
        level: 1,
        revision: 1,
        occurredAt: at,
        sourceIds: ["utterance"],
      },
    });
    expect(old.metadata.evidence).toBeUndefined();
    const prior = existing();
    prior.recalled = [{ node: old, traces: [], truncated: false }];
    const n = proposal();
    n.scope = group;
    n.evidence.supersedes = [old.id];
    expect((await run([n], [source()], prior)).result.status).toBe("rejected");
    const archived = {
      ...proposal(),
      key: old.id,
      scope: group,
      status: "archived",
    };
    expect((await run([archived, n], [source()], prior)).result.status).toBe(
      "completed",
    );
  });
  it("rejects contradictory explicit validity dates", () => {
    expect(
      personEvidenceSchema.safeParse({
        ...proposal().evidence,
        validFrom: "2026-10-23T00:00:00Z",
        validUntil: at,
      }).success,
    ).toBe(false);
  });
});
