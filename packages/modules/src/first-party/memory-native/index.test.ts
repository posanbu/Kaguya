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

describe("native Memory formation", () => {
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
