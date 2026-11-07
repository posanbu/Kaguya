/**
 * 功能概述：通过真实 Core、ModuleHost、原始账本及观察仓储验证静默形成和崩溃恢复。
 * 主要职责：在发布、批次完成、观察确认边界注入一次中断；检查模型去重、唯一发布及连续水位。
 * 40 条来源与迟到更正用例验证跨批稳定经历、封口重开及历史 cutoff，不通过定时休眠推进测试。
 * 代码库关系：复用 cognitiveFixture，仅模型生成使用离线替身；每个等待使用持久状态断言，finally 关闭宿主。
 */
import { expect, it, vi } from "vitest";
import { memoryScope } from "@kaguya/memory";
import {
  cognitiveFixture,
  modelToken,
} from "../test-support/cognitive-fixture.js";
import { inboundTextInformationKind } from "../information-kinds.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { createNativeMemoryModule } from "./index.js";
import { nativeMemoryRequested, nativeMemoryRetry } from "./facts.js";
import {
  freezeInformationAtom,
  informationAtomSchema,
  nativeMemorySnapshotSchema,
  type SceneAddress,
} from "@kaguya/schema";
const wait = { timeout: 8000, interval: 20 };
const address: SceneAddress = {
  platform: "qq",
  adapterId: "qq",
  destination: { kind: "group", groupId: "one" },
};
const contract = (address: SceneAddress) => ({
  consumerId: "memory.native",
  policyVersion: "native-formation.v1",
  address,
  kinds: ["memory.native.source.v1"],
  resultKind: "memory.native.observation.completed.v1",
});
async function fixture(
  empty = false,
  custom?: Parameters<typeof cognitiveFixture>[1],
  beforeStart?: Parameters<typeof cognitiveFixture>[2],
) {
  const f = await cognitiveFixture(
    [
      createNativeMemoryModule({
        modelTaskCapability: modelToken,
        nativeMemoryTemplate: loadFirstPartyPromptTemplates().nativeMemory,
      }),
    ],
    custom ??
      ((request) => {
        const p = nativeMemoryRequested.payloadSchema.parse(
          request.contextAtoms.find(
            (a) => a.kind === nativeMemoryRequested.kind,
          )!.payload,
        );
        return empty
          ? { nodes: [], edges: [] }
          : {
              nodes: [
                {
                  key: "event",
                  kind: "experience",
                  ownerId: p.sources[0]!.ownerId,
                  scope: p.scope,
                  level: 1,
                  content: p.sources.map((s) => s.text).join("；"),
                  sourceIds: p.sources.map((s) => s.id),
                  tags: [],
                  aliases: [],
                  status: "active",
                },
              ],
              edges: [],
            };
      }),
    beforeStart,
  );
  const root = await f.context();
  const send = async (text: string, a = address) =>
    f.core.register(inboundTextInformationKind, {
      source: "test:memory",
      occurredAt: "2020-01-01T00:00:00Z",
      payload: {
        text,
        source: {
          ...a,
          senderId: "human",
          selfId: "bot",
          platformMessageId: text,
        },
      },
      references: [
        { relation: "core:context", informationId: root.informationId },
      ],
    });
  const flush = async (a = address) =>
    f.core.register(nativeMemoryRetry, {
      source: "test:memory",
      occurredAt: "2026-09-09T00:00:10Z",
      payload: { batchId: "scan", scope: memoryScope(a) },
      references: [
        { relation: "core:context", informationId: root.informationId },
      ],
    });
  return {
    ...f,
    get calls() {
      return f.calls;
    },
    get core() {
      return f.core;
    },
    send,
    flush,
  };
}

it.each([
  "publish-before-terminal",
  "terminal-before-batch",
  "batch-before-ack",
  "ack-before-handler-return",
])(
  "recovers %s with one model result, publication and acknowledgment",
  async (boundary) => {
    const f = await fixture();
    let interrupted = false,
      recovered = false;
    let restore = () => {};
    try {
      const native = f.database.memoryGraph.native;
      if (boundary === "publish-before-terminal") {
        const original = native.publish.bind(native);
        const spy = vi
          .spyOn(native, "publish")
          .mockImplementation(async (p) => {
            const result = await original(p);
            if (!recovered) {
              interrupted = true;
              throw new Error("crash-after-publication");
            }
            return result;
          });
        restore = () => spy.mockRestore();
      } else if (boundary === "terminal-before-batch") {
        const original = native.finish.bind(native);
        const spy = vi
          .spyOn(native, "finish")
          .mockImplementation(async (...args) => {
            if (!recovered) {
              interrupted = true;
              throw new Error("crash-before-batch-finish");
            }
            return original(...args);
          });
        restore = () => spy.mockRestore();
      } else {
        const original = f.database.observations.finish.bind(
          f.database.observations,
        );
        const spy = vi
          .spyOn(f.database.observations, "finish")
          .mockImplementation(async (...args) => {
            if (boundary === "ack-before-handler-return") {
              const result = await original(...args);
              if (!recovered) {
                interrupted = true;
                throw new Error("crash-after-ack");
              }
              return result;
            }
            if (!recovered) {
              interrupted = true;
              throw new Error("crash-before-ack");
            }
            return original(...args);
          });
        restore = () => spy.mockRestore();
      }
      await f.send("静默入站原话");
      await native.recover();
      await f.flush();
      await vi.waitFor(() => expect(interrupted).toBe(true), wait);
      await f.stop();
      expect(await f.all("memory.native.revision.v1")).toHaveLength(1);
      expect(await f.all("memory.native.formation.completed.v1")).toHaveLength(
        boundary === "publish-before-terminal" ? 0 : 1,
      );
      expect((await native.status()).counts.pending).toBe(
        ["publish-before-terminal", "terminal-before-batch"].includes(boundary)
          ? 1
          : 0,
      );
      const acknowledged = (
        await f.database.sql.query(
          "SELECT observation_id FROM information_observations WHERE status='completed'",
        )
      ).rows;
      expect(acknowledged).toHaveLength(
        boundary === "ack-before-handler-return" ? 1 : 0,
      );
      recovered = true;
      restore();
      f.setNow("2026-09-09T00:00:20.000Z");
      await f.start();
      await vi.waitFor(
        async () =>
          expect(
            (await f.database.observations.progress(contract(address)))
              ?.throughInformationId,
          ).toMatch(/^memory-native-source:/),
        wait,
      );
      await native.recover();
      await native.recover();
      await vi.waitFor(
        async () => expect((await native.status()).counts.pending).toBe(0),
        wait,
      );
      expect(f.calls).toBe(1);
      expect(await f.all("memory.native.revision.v1")).toHaveLength(1);
      expect(await f.all("memory.native.formation.completed.v1")).toHaveLength(
        1,
      );
      expect(
        await f.all("memory.native.observation.completed.v1"),
      ).toHaveLength(1);
      expect(await f.all("core.test.model.result")).toHaveLength(1);
    } finally {
      restore();
      await f.close();
    }
  },
  20000,
);

it("preserves a rejected conflict and creates one successor with freshly frozen revisions", async () => {
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const f = await fixture(false, async (request) => {
    const p = nativeMemoryRequested.payloadSchema.parse(
      request.contextAtoms.find((a) => a.kind === nativeMemoryRequested.kind)!
        .payload,
    );
    const snapshot = nativeMemorySnapshotSchema.parse(p.existing),
      prior = snapshot.recalled[0]!.node;
    if (calls++ === 0) {
      entered = true;
      await gate;
    }
    return {
      nodes: [
        {
          key: prior.id,
          kind: "experience",
          ownerId: prior.metadata.ownerId,
          scope: p.scope,
          level: 1,
          content: `根据 revision ${prior.metadata.revision} 更新`,
          sourceIds: p.sources.map((s) => s.id),
          tags: [],
          aliases: [],
          status: "active",
        },
      ],
      edges: [],
    };
  });
  try {
    const source = await f.send("我的最新更正");
    await f.database.memoryGraph.native.recover();
    const scope = memoryScope(address),
      node = {
        id: "00000000-0000-4000-8000-000000000019",
        content: "旧结论",
        metadata: {
          system: "native-v1" as const,
          kind: "experience" as const,
          ownerId: `conversation:${scope}`,
          scope,
          level: 1,
          revision: 1,
          status: "active" as const,
          locked: false,
          sourceIds: [source.informationId],
          aliases: [],
          tags: [],
          occurredAt: "2020-01-01T00:00:00Z",
        },
      };
    await f.database.memoryGraph.native.publish({
      operationId: "manual-first",
      actor: "manual",
      nodes: [{ node, expectedRevision: 0 }],
    });
    await f.flush();
    await vi.waitFor(() => expect(entered).toBe(true), wait);
    await f.database.memoryGraph.native.publish({
      operationId: "manual-concurrent",
      actor: "manual",
      nodes: [
        {
          node: {
            ...node,
            content: "人工更正",
            metadata: { ...node.metadata, revision: 2 },
          },
          expectedRevision: 1,
        },
      ],
    });
    release();
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.observation.completed.v1"),
        ).toHaveLength(1),
      wait,
    );
    const terminals = await f.all("memory.native.formation.completed.v1");
    expect(terminals).toHaveLength(2);
    expect(
      terminals.find((a) => a.payload.status === "rejected")!.payload.reason,
    ).toBe("memory_revision_conflict");
    const requests = await f.all(nativeMemoryRequested.kind);
    expect(requests).toHaveLength(2);
    expect(
      requests
        .map(
          (a) =>
            nativeMemorySnapshotSchema.parse(a.payload.existing).recalled[0]!
              .node.metadata.revision,
        )
        .sort(),
    ).toEqual([1, 2]);
    const batches = (
      await f.database.sql.query(
        "SELECT id,status,predecessor_id FROM memory_native_batches",
      )
    ).rows;
    expect(batches.filter((b) => b.status === "rejected")).toHaveLength(1);
    expect(batches.filter((b) => b.predecessor_id)).toHaveLength(1);
    expect(await f.database.memoryGraph.native.history(node.id)).toHaveLength(
      3,
    );
    await f.database.memoryGraph.native.recover();
    await f.restart();
    expect(f.calls).toBe(2);
    expect(await f.all("core.test.model.result")).toHaveLength(2);
  } finally {
    release();
    await f.close();
  }
}, 20000);

it("bridges completed A, preserves a failed gap, and advances through newer B after one successor", async () => {
  let reject = true;
  const f = await fixture(true, (request) => {
    const p = nativeMemoryRequested.payloadSchema.parse(
      request.contextAtoms.find((a) => a.kind === nativeMemoryRequested.kind)!
        .payload,
    );
    return p.sources.some((s) => s.text === "gap") && reject
      ? { nodes: [] }
      : { nodes: [], edges: [] };
  });
  let failAck = true;
  const original = f.database.observations.finish.bind(f.database.observations);
  const spy = vi
    .spyOn(f.database.observations, "finish")
    .mockImplementation(async (...args) => {
      if (failAck) throw new Error("legacy-completed-before-observation");
      return original(...args);
    });
  try {
    const a = await f.send("A");
    await f.database.memoryGraph.native.recover();
    await f.flush();
    await vi.waitFor(
      async () =>
        expect(
          (await f.database.memoryGraph.native.status()).counts.pending,
        ).toBe(0),
      wait,
    );
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.formation.completed.v1"),
        ).toHaveLength(1),
      wait,
    );
    failAck = false;
    await f.send("gap");
    await f.database.memoryGraph.native.recover();
    await f.flush();
    await vi.waitFor(
      async () =>
        expect(
          (await f.database.memoryGraph.native.status()).counts.rejected,
        ).toBe(1),
      wait,
    );
    const rejected = (await f.database.memoryGraph.native.status()).batches[0]!;
    const b = await f.send("B");
    await f.database.memoryGraph.native.recover();
    await f.flush();
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.formation.completed.v1"),
        ).toHaveLength(3),
      wait,
    );
    await f.database.memoryGraph.native.recover();
    await vi.waitFor(
      async () =>
        expect(
          (await f.database.observations.progress(contract(address)))!
            .throughInformationId,
        ).toBe(`memory-native-source:${a.informationId}`),
      wait,
    );
    reject = false;
    await f.database.memoryGraph.native.retry(rejected.id);
    await vi.waitFor(
      async () =>
        expect(
          (await f.database.observations.progress(contract(address)))!
            .throughInformationId,
        ).toBe(`memory-native-source:${b.informationId}`),
      wait,
    );
    await f.database.memoryGraph.native.recover();
    await f.database.memoryGraph.native.recover();
    await f.restart();
    expect(f.calls).toBe(4);
    expect(await f.all("memory.native.revision.v1")).toHaveLength(0);
    expect(await f.all("memory.native.observation.completed.v1")).toHaveLength(
      3,
    );
    expect(
      (
        await f.database.sql.query(
          "SELECT status FROM memory_native_batches WHERE id=$1",
          [rejected.id],
        )
      ).rows[0]!.status,
    ).toBe("rejected");
  } finally {
    spy.mockRestore();
    await f.close();
  }
}, 20000);

it("forms independently of foreground replies and isolates default Web, conversations and adapters", async () => {
  const f = await fixture(true);
  const addresses: SceneAddress[] = [
    { platform: "web", adapterId: "web", destination: { kind: "web" } },
    {
      platform: "web",
      adapterId: "web",
      destination: {
        kind: "web",
        conversationId: "00000000-0000-4000-8000-000000000099",
      },
    },
    address,
    { ...address, adapterId: "qq-second" },
  ];
  try {
    const epoch = (
      await f.database.sql.query("SELECT * FROM memory_native_epoch")
    ).rows;
    for (const [i, a] of addresses.entries())
      await f.send(`不需要回复 ${i}`, a);
    await f.database.memoryGraph.native.recover();
    for (const a of addresses) await f.flush(a);
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.observation.completed.v1"),
        ).toHaveLength(4),
      wait,
    );
    const cursors = await Promise.all(
      addresses.map((a) => f.database.observations.progress(contract(a))),
    );
    expect(new Set(cursors.map((p) => p!.throughInformationId)).size).toBe(4);
    expect(await f.all("memory.native.revision.v1")).toHaveLength(0);
    expect(
      (await f.all("memory.native.formation.completed.v1")).every(
        (a) => a.payload.reason === "empty",
      ),
    ).toBe(true);
    await f.database.prepareSchema();
    await f.database.memoryGraph.native.recover();
    await f.restart();
    expect(
      (await f.database.sql.query("SELECT * FROM memory_native_epoch")).rows,
    ).toEqual(epoch);
    expect(f.calls).toBe(4);
  } finally {
    await f.close();
  }
}, 20000);

it("uses the maximum canonical registration boundary when legacy source order is reversed", async () => {
  const f = await fixture(true);
  try {
    const a = await f.send("legacy A"),
      b = await f.send("new B"),
      scope = memoryScope(address);
    const legacy = {
      id: a.informationId,
      scope,
      ownerId: `conversation:${scope}`,
      text: "legacy A",
      sourceType: "inbound",
      participants: [],
      replyTo: null,
      occurredAt: a.occurredAt,
      collectedAt: "2026-09-09T00:00:10.000Z",
    };
    await f.database.sql.query(
      "INSERT INTO memory_native_sources(id,scope,source) VALUES($1,$2,$3::jsonb)",
      [a.informationId, scope, JSON.stringify(legacy)],
    );
    await f.database.memoryGraph.native.recover();
    expect(
      await f.database.memoryGraph.native.sourceBoundary([
        a.informationId,
        b.informationId,
      ]),
    ).toBe(`memory-native-source:${a.informationId}`);
    await f.flush();
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.observation.completed.v1"),
        ).toHaveLength(1),
      wait,
    );
    expect(
      (await f.database.observations.progress(contract(address)))!
        .throughInformationId,
    ).toBe(`memory-native-source:${a.informationId}`);
    const pages = (
      await f.database.sql.query(
        "SELECT source_ids FROM information_observations WHERE status='completed'",
      )
    ).rows;
    expect(pages[0]!.source_ids).toEqual([
      `memory-native-source:${b.informationId}`,
      `memory-native-source:${a.informationId}`,
    ]);
  } finally {
    await f.close();
  }
}, 20000);

// 升级前已完成的 A 无 canonical；先补收 48 条 C，再补 A，不能把 C 合成一个不可拆的缺口。
it.each(["forward", "reverse"])(
  "closes 48 pre-upgrade sources before completed A through two batches and restart (%s)",
  async (order) => {
    const f = await fixture(true, undefined, async (db) => {
      const scope = memoryScope(address),
        batchId = "00000000-0000-4000-8000-000000000081";
      const append = async (
        informationId: string,
        kind: string,
        payload: unknown,
        references: unknown[] = [],
      ) => {
        await db.information.synchronizeKinds([kind]);
        const atom = freezeInformationAtom(
          informationAtomSchema.parse({
            informationId,
            kind,
            payload,
            references,
            source: "test:upgrade",
            occurredAt: "2020-01-01T00:00:00Z",
          }),
        );
        await db.information.append(
          atom,
          [...new Set(atom.references.map((r) => r.relation))].map(
            (relation) => ({ relation, required: true, multiple: true }),
          ),
        );
      };
      const context = {
        relation: "core:context",
        informationId: "legacy-root",
      };
      await append("legacy-root", "core.runtime.context", {});
      const original = {
        id: "legacy-A",
        scope,
        ownerId: `conversation:${scope}`,
        text: "A",
        sourceType: "inbound",
        participants: [],
        replyTo: null,
        occurredAt: "2020-01-01T00:00:00Z",
        collectedAt: "2026-09-09T00:00:10Z",
      };
      await append(
        "legacy-A",
        "core.message.inbound.text",
        { text: "A", source: { ...address, senderId: "human", selfId: "bot" } },
        [context],
      );
      await db.sql.query(
        "INSERT INTO memory_native_batches(id,scope,sources,status) VALUES($1,$2,$3::jsonb,'completed')",
        [batchId, scope, JSON.stringify([original])],
      );
      await db.sql.query(
        "INSERT INTO memory_native_sources(id,scope,source,batch_id) VALUES($1,$2,$3::jsonb,$4)",
        [original.id, scope, JSON.stringify(original), batchId],
      );
      const existing = {
        version: 1,
        status: "enabled",
        frozenAt: "2026-09-09T00:00:10Z",
        scope,
        owners: [original.ownerId],
        people: [],
        participants: [],
        fixed: [],
        recalled: [],
        degraded: [],
        budget: { dynamicCharacters: 0, omittedNodeIds: [] },
      };
      await append(
        "legacy-request",
        "memory.native.formation.requested.v1",
        { batchId, scope, sources: [original], existing },
        [
          context,
          { relation: "core:caused-by", informationId: original.id },
          { relation: "core:uses-context", informationId: original.id },
        ],
      );
      await append(
        "legacy-terminal",
        "memory.native.formation.completed.v1",
        { batchId, scope, status: "completed", reason: "empty", nodeIds: [] },
        [
          context,
          { relation: "core:caused-by", informationId: "legacy-request" },
          { relation: "core:status-of", informationId: "legacy-request" },
        ],
      );
      for (let i = 1; i <= 48; i++)
        await append(
          `backlog-${i}`,
          "core.message.inbound.text",
          {
            text: `C${i}`,
            source: { ...address, senderId: "human", selfId: "bot" },
          },
          [context],
        );
    });
    let holdFirst = order === "reverse";
    const originalFinish = f.database.observations.finish.bind(
      f.database.observations,
    );
    const ack = vi
      .spyOn(f.database.observations, "finish")
      .mockImplementation(async (id, result) => {
        const page = await f.database.observations.read(id);
        if (
          holdFirst &&
          (
            page?.manifest?.content.sources as { id: string }[] | undefined
          )?.some((s) => s.id === "backlog-1")
        )
          throw new Error("hold-first-batch-until-restart");
        return originalFinish(id, result);
      });
    try {
      await vi.waitFor(
        async () =>
          expect(
            await f.all("memory.native.observation.completed.v1"),
          ).toHaveLength(1),
        wait,
      );
      const pending = await f.database.observations.pending(contract(address));
      expect(pending).toHaveLength(48);
      expect(
        pending.every(
          (p) => p.sourceInformationIds.length === 1 && !p.complete,
        ),
      ).toBe(true);
      await f.flush();
      if (order === "reverse") {
        await vi.waitFor(
          async () =>
            expect(
              await f.all("memory.native.formation.completed.v1"),
            ).toHaveLength(2),
          wait,
        );
        await f.stop();
        await f.start();
        await f.flush();
        await vi.waitFor(
          async () =>
            expect(
              (
                await f.database.sql.query(
                  "SELECT observation_id FROM information_observations WHERE status='completed'",
                )
              ).rows,
            ).toHaveLength(25),
          wait,
        );
        expect(
          (await f.database.observations.progress(contract(address)))!
            .throughPosition,
        ).toBe("0");
        await f.stop();
        holdFirst = false;
        await f.start();
      }
      await vi.waitFor(
        async () =>
          expect(
            (await f.database.observations.progress(contract(address)))!
              .throughInformationId,
          ).toBe("memory-native-source:legacy-A"),
        wait,
      );
      expect(f.calls).toBe(2);
      expect(
        await f.all("memory.native.observation.completed.v1"),
      ).toHaveLength(49);
      await f.database.memoryGraph.native.recover();
      await f.restart();
      expect(f.calls).toBe(2);
      expect(await f.database.observations.pending(contract(address))).toEqual(
        [],
      );
      expect(
        (await f.database.observations.progress(contract(address)))!
          .throughInformationId,
      ).toBe("memory-native-source:legacy-A");
    } finally {
      ack.mockRestore();
      await f.close();
    }
  },
  30000,
);

it("revises one experience after source 33, reopens for late correction, and replays the frozen revision", async () => {
  const scope = memoryScope(address);
  const f = await fixture(
    false,
    (request) => {
      const p = nativeMemoryRequested.payloadSchema.parse(
        request.contextAtoms.find((a) => a.kind === nativeMemoryRequested.kind)!
          .payload,
      );
      expect(p.formationPolicy).toBe("experience-operations.v1");
      const snapshot = nativeMemorySnapshotSchema.parse(p.existing);
      const prior = snapshot.recalled.find(
        (r) => r.node.metadata.kind === "experience",
      )?.node;
      const corrected = p.sources.some((s) => s.text === "第40条：更正为周五");
      const late = p.sources.some((s) => s.text === "迟到更正：最终周六");
      const key = prior?.id ?? "appointment";
      return {
        nodes: [
          {
            key,
            kind: "experience",
            ownerId: `conversation:${scope}`,
            scope,
            level: 1,
            content: late ? "约定周六" : corrected ? "约定周五" : "约定周四",
            sourceIds: [
              ...new Set([
                ...(prior?.metadata.sourceIds ?? []),
                ...p.sources.map((s) => s.id),
              ]),
            ],
            tags: [],
            aliases: [],
            status: "active",
            experience: {
              state: corrected ? "sealed" : "open",
              policyVersion: "experience.v1",
            },
          },
        ],
        edges: [],
        ...(prior
          ? {
              experienceOperation: {
                kind: late ? "reopen" : "seal",
                inputIds: [key],
                outputIds: [key],
              },
            }
          : {}),
      };
    },
    async (db) => {
      await db.information.synchronizeKinds(["core.message.inbound.text"]);
      for (let i = 1; i <= 40; i++)
        await db.information.append(
          freezeInformationAtom(
            informationAtomSchema.parse({
              informationId: `correction-${i}`,
              kind: "core.message.inbound.text",
              source: "test:synthetic",
              occurredAt: "2021-01-01T00:00:00Z",
              payload: {
                text: i === 40 ? "第40条：更正为周五" : `讨论${i}`,
                source: { ...address, senderId: "human", selfId: "bot" },
              },
              references: [],
            }),
          ),
          [],
        );
    },
  );
  try {
    await f.flush();
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.formation.completed.v1"),
        ).toHaveLength(2),
      wait,
    );
    const read = {
      scope,
      owners: [`conversation:${scope}`],
      query: "约定",
      asOf: "2030-01-01T00:00:00Z",
    };
    const requests = await f.all(nativeMemoryRequested.kind);
    expect(
      requests
        .map((r) => (r.payload.sources as unknown[]).length)
        .sort((a, b) => a - b),
    ).toEqual([16, 24]);
    expect(
      (await f.all("memory.native.formation.completed.v1")).every(
        (r) => r.payload.status === "completed",
      ),
    ).toBe(true);
    const before = await f.database.memoryGraph.native.forFormation(read);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      content: "约定周五",
      metadata: { revision: 2, experience: { state: "sealed" } },
    });
    const cutoff = await f.database.memoryGraph.native.cutoff(read);
    const late = await f.send("迟到更正：最终周六"); // occurredAt=2020, registered after the 2021 messages.
    await f.database.memoryGraph.native.recover(); // Run the independent maintenance boundary without a timer sleep.
    await f.flush();
    await vi.waitFor(
      async () =>
        expect(
          await f.all("memory.native.formation.completed.v1"),
        ).toHaveLength(3),
      wait,
    );
    const current = await f.database.memoryGraph.native.current(read, [
      before[0]!.id,
    ]);
    expect(current[0]).toMatchObject({
      id: before[0]!.id,
      content: "约定周六",
      metadata: { revision: 3, experience: { state: "open" } },
    });
    expect(current[0]!.metadata.sourceIds).toContain(late.informationId);
    expect(
      await f.database.memoryGraph.native.current({ ...read, cutoff }, [
        before[0]!.id,
      ]),
    ).toEqual(before);
    await vi.waitFor(
      async () =>
        expect(
          (await f.database.observations.progress(contract(address)))
            ?.throughInformationId,
        ).toBe(`memory-native-source:${late.informationId}`),
      wait,
    );
    await f.restart();
    expect(f.calls).toBe(3);
    expect(
      await f.database.memoryGraph.native.history(before[0]!.id),
    ).toHaveLength(3);
    expect(await f.all("memory.native.formation.completed.v1")).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 30000);
