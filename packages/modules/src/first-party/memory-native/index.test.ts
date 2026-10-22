/** Real durable queues and publication, with only model generation replaced. */
/** Real durable queues and publication, with only model generation replaced. */
import { describe, it, expect, vi } from "vitest";
import {
  cognitiveFixture,
  modelToken,
} from "../test-support/cognitive-fixture.js";
import { identityModule } from "../identity/index.js";
import { createNativeMemoryModule } from "./index.js";
import { inboundTextInformationKind } from "../information-kinds.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { nativeMemoryRequested } from "./facts.js";
import { nativeMemorySnapshotSchema } from "@kaguya/schema";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";

describe("native Memory formation", () => {
  it.each(["queued", "pending", "legacy-pending", "legacy-queued"])(
    "forms a small batch from a context-free timer after restart (%s)",
    async (mode) => {
      const f = await cognitiveFixture(
        [
          identityModule,
          createNativeMemoryModule({
            modelTaskCapability: modelToken,
            nativeMemoryTemplate: loadFirstPartyPromptTemplates().nativeMemory,
          }),
        ],
        (request) => {
          const p = nativeMemoryRequested.payloadSchema.parse(
            request.contextAtoms.find(
              (a) => a.kind === nativeMemoryRequested.kind,
            )!.payload,
          );
          return {
            nodes: [
              {
                key: "timer-summary",
                kind: "person",
                ownerId: p.sources[0]!.ownerId,
                scope: p.scope,
                level: 0,
                content: "本人在本群说今天在看建筑方案，未说明职业。",
                sourceIds: p.sources.map((s) => s.id),
                tags: [],
                aliases: [],
                status: "active",
              },
            ],
            edges: [],
          };
        },
      );
      try {
        const root = await f.context();
        await f.core.register(inboundTextInformationKind, {
          source: "adapter:test",
          occurredAt: "2026-09-09T00:00:10.000Z",
          payload: {
            text: "今天在看建筑方案",
            source: {
              adapterId: "qq",
              platform: "qq",
              destination: { kind: "group", groupId: "one" },
              senderId: "human",
              selfId: "bot",
              platformMessageId: "timer-source",
            },
          },
          references: [
            { relation: "core:context", informationId: root.informationId },
          ],
        });
        await vi.waitFor(async () =>
          expect(
            await f.all(oneShotRequestedInformationKind.kind),
          ).toHaveLength(1),
        );
        expect(await f.all(nativeMemoryRequested.kind)).toHaveLength(0);
        const schedule = (
          await f.all(oneShotRequestedInformationKind.kind)
        )[0]!;
        if (mode.endsWith("pending")) {
          // Old flush failures left a claimed batch without a formation request.
          const input = schedule.payload.input as { scope: string };
          expect(
            await f.database.memoryGraph.native.claim(
              input.scope,
              true,
              "2026-09-09T00:01:11.000Z",
            ),
          ).toBeDefined();
        }
        if (mode.startsWith("legacy")) {
          await f.database.sql.query(
            "UPDATE memory_native_sources SET source=source-'sourceType'-'participants'-'replyTo'",
          );
          await f.database.sql.query(
            "UPDATE memory_native_batches SET sources=(SELECT jsonb_agg(s-'sourceType'-'participants'-'replyTo') FROM jsonb_array_elements(sources) s)",
          );
        }
        await f.restart();
        f.setNow("2026-09-09T00:01:11.000Z");
        await f.core.register(oneShotDueInformationKind, {
          source: "core:test",
          occurredAt: "2026-09-09T00:01:11.000Z",
          payload: {
            scheduleInformationId: schedule.informationId,
            dueAt: "2026-09-09T00:01:10.000Z",
            deliveredAt: "2026-09-09T00:01:11.000Z",
          },
          references: [
            {
              relation: "core:status-of",
              informationId: schedule.informationId,
            },
          ],
        });
        await vi.waitFor(
          async () =>
            expect(
              await f.all("memory.native.formation.completed.v1"),
            ).toHaveLength(1),
          { timeout: 5000 },
        );
        expect(
          (await f.all(nativeMemoryRequested.kind))[0]!.references,
        ).toContainEqual({
          relation: "core:context",
          informationId: root.informationId,
        });
        expect(await f.all("execution.exhausted")).toHaveLength(0);
        expect(
          (await f.all("memory.native.formation.completed.v1"))[0]!.payload
            .status,
        ).toBe("completed");
        expect(
          (await f.database.memoryGraph.native.status()).counts.fixed,
        ).toBe(1);
        expect(
          (
            await f.database.information.oneShotSchedules.listOpen({
              limit: 10,
            })
          ).arms,
        ).toHaveLength(0);
        await f.restart();
        expect(f.calls).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  it("forms after eight sources, revises the same summary after restart, and keeps one level zero", async () => {
    let attempts = 0;
    const f = await cognitiveFixture(
      [
        identityModule,
        createNativeMemoryModule({
          modelTaskCapability: modelToken,
          nativeMemoryTemplate: loadFirstPartyPromptTemplates().nativeMemory,
        }),
      ],
      (request) => {
        if (attempts++ === 0) return { nodes: [] };
        const p = nativeMemoryRequested.payloadSchema.parse(
          request.contextAtoms.find(
            (a) => a.kind === nativeMemoryRequested.kind,
          )!.payload,
        );
        expect(p.sources[0]).toMatchObject({
          sourceType: "inbound",
          participants: [
            {
              role: "speaker",
              accountId: "human",
              nickname: "音乐同学",
              card: "小乐",
            },
          ],
        });
        expect(p.sources[0]!.participants[0]!.ownerId).toBe(
          p.sources[0]!.ownerId,
        );
        const existing = nativeMemorySnapshotSchema.parse(p.existing);
        return {
          nodes: [
            {
              key: existing.fixed[0]?.id ?? "person-summary",
              kind: "person",
              ownerId: p.sources[0]!.ownerId,
              scope: p.scope,
              level: 0,
              content: `人物喜欢音乐，已整理 ${p.sources[0]!.text}`,
              sourceIds: p.sources.map((s) => s.id),
              tags: [],
              aliases: [],
              status: "active",
            },
          ],
          edges: [],
        };
      },
    );
    const send = async (n: number) => {
      const root = await f.context();
      await f.core.register(inboundTextInformationKind, {
        source: "adapter:test",
        occurredAt: "2026-09-09T00:00:10.000Z",
        payload: {
          text: `音乐 ${n}`,
          source: {
            adapterId: "qq",
            platform: "qq",
            destination: { kind: "group", groupId: "one" },
            senderId: "human",
            sender: { userId: "human", nickname: "音乐同学", card: "小乐" },
            selfId: "bot",
            platformMessageId: `m-${n}`,
          },
        },
        references: [
          { relation: "core:context", informationId: root.informationId },
        ],
      });
    };
    try {
      for (let i = 0; i < 7; i++) await send(i);
      await vi.waitFor(async () =>
        expect(
          (await f.database.memoryGraph.native.status()).counts.queued,
        ).toBe(7),
      );
      expect(await f.all(nativeMemoryRequested.kind)).toHaveLength(0);
      await send(7);
      await vi.waitFor(
        async () =>
          expect(
            (await f.database.memoryGraph.native.status()).counts.rejected,
          ).toBe(1),
        { timeout: 8000 },
      );
      const rejected = (await f.database.memoryGraph.native.status())
        .batches[0]!;
      await f.database.memoryGraph.native.retry(rejected.id);
      await vi.waitFor(
        async () =>
          expect(
            (await f.database.memoryGraph.native.status()).counts.fixed,
          ).toBe(1),
        { timeout: 8000 },
      );
      const first = (
        await f.database.memoryGraph.listNodes({ system: "native-v1" })
      )[0]!;
      await f.restart();
      for (let i = 8; i < 16; i++) await send(i);
      await vi.waitFor(
        async () =>
          expect(
            (await f.database.memoryGraph.getNode(first.id))?.metadata.revision,
          ).toBe(2),
        { timeout: 8000 },
      );
      expect((await f.database.memoryGraph.native.status()).counts.fixed).toBe(
        1,
      );
    } finally {
      await f.close();
    }
  }, 20000);
});
