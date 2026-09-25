/**
 * 功能概述：使用真实 InformationCore、ModuleHost 和 PGlite 验证群聊认知的可靠后台闭环。
 * fixture 安装 identity、raw writeback 与 cognition 模块，submit 沿正规入站路径登记消息；
 * 测试证明多人转述和纠正保留各自账号，回复关系从入站账本补充到 provider 输入，raw 文档保持原契约；
 * 跨群或事件截止点之外的回复目标只保留原生 ID，不扩展冻结证据窗口，嵌套回复元数据同样深冻结。
 * 每个用例最多五次串行投递，各有 8 秒完成态等待，测试总预算 60 秒覆盖初始化和关闭；
 * provider 是只记录严格输入的本地替身，不评价模型的提取质量；所有数据库与订阅在用例后关闭。
 */
import { randomUUID } from "node:crypto";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  ModuleHost,
} from "@kaguya/engine";
import {
  memoryCapability,
  memoryCognitionCapability,
  memoryDocumentReaderCapability,
  type MemoryCognitionInput,
} from "@kaguya/memory";
import { z } from "@kaguya/schema";
import {
  catalogInformationKinds,
  defineInformationKind,
  defineInformationModuleCatalog,
} from "@kaguya/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityModule } from "../identity/index.js";
import { inboundTextInformationKind } from "../information-kinds.js";
import { memoryWritebackModule } from "../memory-writeback/index.js";
import { memoryCognitionModule } from "./index.js";

const contextKind = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "测试上下文",
  description: "群聊认知的测试上下文",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
// 同一可靠投递路径统一使用 Planner/PGlite 的 8 秒有界条件等待，不改变业务重试或截止点。
const DURABLE_WAIT = { timeout: 8000, interval: 20 } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
});
async function fixture() {
  const database = await createTestingDatabase();
  cleanups.push(() => database.close());
  await database.prepareSchema();
  const catalog = defineInformationModuleCatalog(
    identityModule,
    memoryWritebackModule,
    memoryCognitionModule,
  );
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(contextKind);
  for (const definition of catalogInformationKinds(catalog)) {
    if (definition.kind.startsWith("core."))
      registry.registerBuiltin(definition);
    else registry.register(definition);
  }
  const core = new InformationCore({
    registry,
    store: database.information,
    nextInformationId: randomUUID,
  });
  cleanups.push(() => core.close());
  const evolve = vi.fn(async (input: MemoryCognitionInput) => ({
    facts: [
      {
        text: "各参与者的说法及纠正",
        sourceInformationIds: [...input.sourceInformationIds],
      },
    ],
  }));
  const host = new ModuleHost({
    core,
    catalog,
    capabilities: [
      { capability: memoryCapability, value: database.memory },
      { capability: memoryDocumentReaderCapability, value: database.memory },
      {
        capability: memoryCognitionCapability,
        value: { identity: { providerId: "fixture", revision: "v1" }, evolve },
      },
    ],
  });
  cleanups.push(() => host.stop());
  await core.start();
  await host.start(
    catalog.definitions.map(({ manifest }) => ({
      instanceId: manifest.definitionId,
      definitionId: manifest.definitionId,
      settings: {},
    })),
  );
  let expectedCompleted = 0;
  async function submit(
    text: string,
    senderId: string,
    second: number,
    groupId = "group",
    replyTo?: { platformMessageId: string; senderId?: string },
  ) {
    const context = await core.register(contextKind, {
      source: "core:test",
      occurredAt: new Date().toISOString(),
      payload: {},
      references: [],
    });
    const source = await core.register(inboundTextInformationKind, {
      source: "adapter:test",
      occurredAt: new Date(
        Date.parse("2026-09-01T00:00:00.000Z") + second * 1000,
      ).toISOString(),
      payload: {
        text,
        source: {
          platform: "qq",
          adapterId: "qq.main",
          senderId,
          platformMessageId: context.informationId,
          destination: { kind: "group", groupId },
          ...(replyTo ? { replyTo } : {}),
        },
      },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    expectedCompleted += 1;
    await vi.waitFor(async () => {
      const completed = await database.information.find({
        kinds: ["memory.cognition.completed"],
        limit: 100,
      });
      expect(completed).toHaveLength(expectedCompleted);
      expect(
        completed.every((atom) => atom.payload.status === "completed"),
      ).toBe(true);
    }, DURABLE_WAIT);
    return source;
  }
  return { database, evolve, submit };
}

describe("durable multi-participant cognition", () => {
  it("keeps original speakers and corrections without crossing groups or a late event cutoff", async () => {
    const f = await fixture();
    await f.submit("另一个群的私人话题", "speaker-c", 1, "other-group");
    const first = await f.submit("我不喝咖啡", "speaker-a", 2);
    const firstRaw = await f.database.memory.getBySource(first.informationId);
    const hearsay = await f.submit("A不是喜欢咖啡吗", "speaker-b", 3);
    const correction = await f.submit(
      "那是以前，我现在不喝了",
      "speaker-a",
      4,
      "group",
      {
        platformMessageId: first.payload.source.platformMessageId,
        senderId: "speaker-a",
      },
    );
    const input = f.evolve.mock.calls.at(-1)![0];
    expect(input.sourceInformationIds).toEqual([
      first.informationId,
      hearsay.informationId,
      correction.informationId,
    ]);
    expect(
      input.documents.map((doc) => [doc.address.accountId, doc.content]),
    ).toEqual([
      ["speaker-a", "我不喝咖啡"],
      ["speaker-b", "A不是喜欢咖啡吗"],
      ["speaker-a", "那是以前，我现在不喝了"],
    ]);
    expect(input.documents.map((doc) => doc.address.platformMessageId)).toEqual(
      [first, hearsay, correction].map(
        (atom) => atom.payload.source.platformMessageId,
      ),
    );
    expect(input.documents[2]!.replyTo).toEqual({
      platformMessageId: first.payload.source.platformMessageId,
      senderId: "speaker-a",
      sourceInformationId: first.informationId,
    });
    expect(input.documents[0]).not.toHaveProperty("replyTo");
    expect(Object.isFrozen(input.documents)).toBe(true);
    expect(Object.isFrozen(input.documents[2]!.replyTo)).toBe(true);
    expect(await f.database.memory.getBySource(first.informationId)).toEqual(
      firstRaw,
    );
    const correctionRaw = await f.database.memory.getBySource(
      correction.informationId,
    );
    expect(correctionRaw).toMatchObject({
      sourceInformationId: correction.informationId,
      content: "那是以前，我现在不喝了",
      address: { accountId: "speaker-a" },
    });
    expect(correctionRaw).not.toHaveProperty("replyTo");
    const late = await f.submit("这是较早发生但较晚送达的消息", "speaker-b", 0);
    expect(f.evolve.mock.calls.at(-1)![0].sourceInformationIds).toEqual([
      late.informationId,
    ]);
    const completed = await f.database.information.find({
      kinds: ["memory.cognition.completed"],
      limit: 100,
    });
    const correctionSnapshot = completed.find((atom) =>
      atom.references.some(
        (ref) =>
          ref.relation === "agent:evidence" &&
          ref.informationId === correction.informationId,
      ),
    );
    expect(
      correctionSnapshot?.references
        .filter((ref) => ref.relation === "agent:evidence")
        .map((ref) => ref.informationId),
    ).toEqual(input.sourceInformationIds);
  }, 60000);

  it("keeps cross-group and out-of-cutoff reply targets unresolved without expanding evidence", async () => {
    const f = await fixture();
    const otherGroup = await f.submit(
      "其他群的原文",
      "speaker-a",
      1,
      "other-group",
    );
    const crossGroupReply = await f.submit(
      "引用其他群的消息 ID",
      "speaker-b",
      2,
      "group",
      {
        platformMessageId: otherGroup.payload.source.platformMessageId,
        senderId: "speaker-a",
      },
    );
    const crossGroupInput = f.evolve.mock.calls.at(-1)![0];
    expect(crossGroupInput.sourceInformationIds).toEqual([
      crossGroupReply.informationId,
    ]);
    expect(crossGroupInput.documents[0]!.replyTo).toEqual({
      platformMessageId: otherGroup.payload.source.platformMessageId,
      senderId: "speaker-a",
      sourceInformationId: null,
    });
    const futureTarget = await f.submit("晚于截止点的原文", "speaker-a", 10);
    const lateReply = await f.submit(
      "带有窗口外回复目标的迟到消息",
      "speaker-b",
      3,
      "group",
      {
        platformMessageId: futureTarget.payload.source.platformMessageId,
        senderId: "speaker-a",
      },
    );
    const lateInput = f.evolve.mock.calls.at(-1)![0];
    expect(lateInput.sourceInformationIds).toEqual([
      crossGroupReply.informationId,
      lateReply.informationId,
    ]);
    expect(lateInput.documents[1]!.replyTo).toEqual({
      platformMessageId: futureTarget.payload.source.platformMessageId,
      senderId: "speaker-a",
      sourceInformationId: null,
    });
    expect(Object.isFrozen(lateInput.documents[1]!.replyTo)).toBe(true);
  }, 60000);
});
