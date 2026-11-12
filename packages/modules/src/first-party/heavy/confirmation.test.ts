/**
 * 功能概述：用真实 Core 的 selector 读取许可检查人工确认后的旧投递去重。
 * 主要职责：当前确认先沿 caused-by 载入助手，再查询旧投递；其他 selector 的读取不授予本次许可。
 * 代码库关系：直接执行 Heavy 的生产 selector，使用真实 PGlite 账本及消息 schema。
 * 输入输出与副作用：只注册合成事实，无模型或发送；await 表示持久完成，每例关闭 Core 和数据库。
 */
import { afterEach, expect, it } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { defineInformationKind, defineInformationSelector } from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import { assistantTextInformationKind } from "../kinds/message.js";
import { messageConfirmedInformationKind } from "../message-authorization.js";
import { legacyAssistantDeliverySelector } from "./index.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse())
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length)
    throw new AggregateError(errors, "confirmation cleanup failed");
});
const runtime = defineInformationKind({
  kind: "core.runtime.context",
  displayName: "Context",
  description: "Synthetic context",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const completed = defineInformationKind({
  kind: "core.model.task.completed",
  displayName: "Completed",
  description: "Synthetic model terminal",
  payloadSchema: z.object({}).strict(),
  references: {},
  log: { enabled: false },
});
const delivery = defineInformationKind({
  kind: "core.delivery.requested",
  displayName: "Delivery",
  description: "Synthetic legacy delivery",
  payloadSchema: z.object({}).strict(),
  references: { "core:caused-by": { required: true, multiple: false } },
  log: { enabled: false },
});
it("loads confirmation provenance within each selector before traversing assistant deliveries", async () => {
  const db = await createTestingDatabase();
  cleanup.push(() => db.close());
  await db.prepareSchema();
  const registry = new InformationKindRegistry();
  for (const kind of [
    runtime,
    completed,
    delivery,
    assistantTextInformationKind,
  ])
    registry.registerBuiltin(kind);
  registry.register(messageConfirmedInformationKind);
  let id = 0;
  const core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: () => `confirmation-${++id}`,
  });
  cleanup.push(() => core.close());
  await core.start();
  const base = {
    occurredAt: "2026-01-01T00:00:00Z",
    source: "test:confirmation",
  };
  const context = await core.register(runtime, {
    ...base,
    payload: {},
    references: [],
  });
  const model = await core.register(completed, {
    ...base,
    payload: {},
    references: [],
  });
  const assistant = await core.register(assistantTextInformationKind, {
    ...base,
    payload: {
      text: "confirmed body",
      source: {
        platform: "qq",
        adapterId: "qq",
        destination: { kind: "group", groupId: "100" },
      },
      originatingModuleInstanceId: "heavy.default",
      turn: null,
    },
    references: [
      { relation: "core:context", informationId: context.informationId },
      { relation: "core:caused-by", informationId: model.informationId },
    ],
  });
  const confirmed = await core.register(messageConfirmedInformationKind, {
    ...base,
    payload: { assistantInformationId: assistant.informationId },
    references: [
      { relation: "core:context", informationId: context.informationId },
      { relation: "core:caused-by", informationId: assistant.informationId },
    ],
  });
  // A previous read must not be used as implicit permission by the production selector.
  await core.select(
    defineInformationSelector({
      selectorId: "test.confirmation-prior-read",
      select: async ({ sourceAtom, ledger }) =>
        (
          await ledger.related({
            from: [sourceAtom.informationId],
            relation: "core:caused-by",
            direction: "outgoing",
            limit: 2,
          })
        ).map((atom) => atom.informationId),
    }),
    confirmed.informationId,
  );
  expect(
    await core.select(legacyAssistantDeliverySelector, confirmed.informationId),
  ).toEqual([]);
  const oldDelivery = await core.register(delivery, {
    ...base,
    payload: {},
    references: [
      { relation: "core:caused-by", informationId: confirmed.informationId },
    ],
  });
  expect(
    (
      await core.select(
        legacyAssistantDeliverySelector,
        confirmed.informationId,
      )
    ).map((atom) => atom.informationId),
  ).toEqual([oldDelivery.informationId]);
  const forged = await core.register(messageConfirmedInformationKind, {
    ...base,
    payload: { assistantInformationId: "another-assistant" },
    references: [
      { relation: "core:context", informationId: context.informationId },
      { relation: "core:caused-by", informationId: assistant.informationId },
    ],
  });
  await expect(
    core.select(legacyAssistantDeliverySelector, forged.informationId),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: "target-authorization-required",
    }),
  });
});
