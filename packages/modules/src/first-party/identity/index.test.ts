/**
 * 功能概述：验证 Identity 在 Web 会话连续性和匿名身份边界之间的契约。
 * 主要职责：内存 registerOnce/commitTerminal 替身复用命名槽，直接运行 identityModule 的真实入站 handler；
 * 断言同会话复用范围、不同会话及适配器隔离、旧 Web 逐条独立、QQ canonical 身份保持不变。
 * 代码库关系：使用 information-kinds 的真实载荷 schema；持久化槽原子性由 Core 测试负责。
 * 输入输出与副作用：仅生成合成原子和内存槽，不访问数据库、不启动 Runner，也不使用轮询或固定等待。
 */
import { expect, it } from "vitest";
import {
  freezeInformationAtom,
  informationIdSchema,
  type DeepReadonly,
  type InformationAtom,
  type PlatformDestination,
} from "@kaguya/schema";
import type { InformationModuleHandlerContext } from "@kaguya/sdk";
import {
  chatScopeEntityInformationKind,
  inboundTextInformationKind,
  personEntityInformationKind,
  platformAccountEntityInformationKind,
} from "../information-kinds.js";
import { identityModule } from "./index.js";

const conversationA = "11111111-1111-4111-8111-111111111111";
const conversationB = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const slots = new Map<string, DeepReadonly<InformationAtom>>();
  const lifecycle = {
    signal: new AbortController().signal,
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    report: async () => undefined,
    use: () => {
      throw new Error("Identity must not use external capabilities");
    },
  };
  const instance = await identityModule.create(
    {
      instanceId: "identity.test",
      settings: {},
      activation: {
        instanceId: "identity.test",
        definitionId: identityModule.manifest.definitionId,
      },
    },
    lifecycle,
  );
  const registerOnce: InformationModuleHandlerContext["registerOnce"] = async (
    operation,
    key,
    definition,
    input,
  ) => {
    const slot = JSON.stringify([operation, key]);
    if (!slots.has(slot)) {
      slots.set(
        slot,
        freezeInformationAtom({
          informationId: informationIdSchema.parse(`identity-${slots.size}`),
          kind: definition.kind,
          occurredAt: lifecycle.now().toISOString(),
          source: "module:identity.test",
          payload: definition.payloadSchema.parse(input.payload),
          references: [...(input.references ?? [])],
        }),
      );
    }
    return slots.get(slot)! as never;
  };
  return {
    all: (kind: string) => [...slots.values()].filter((a) => a.kind === kind),
    async inbound(
      id: string,
      destination: PlatformDestination,
      platform = "web",
      adapterId = "web.ui.main",
    ) {
      const atom = freezeInformationAtom({
        informationId: informationIdSchema.parse(id),
        kind: inboundTextInformationKind.kind,
        occurredAt: lifecycle.now().toISOString(),
        source: "adapter:test",
        payload: inboundTextInformationKind.payloadSchema.parse({
          text: "hello",
          source: {
            platform,
            adapterId,
            destination,
            senderId: "same-sender",
            platformMessageId: id,
          },
        }),
        references: [],
      });
      await instance.subscriptions[0]!.handle(atom, {
        ...lifecycle,
        definitionId: identityModule.manifest.definitionId,
        instanceId: "identity.test",
        sourceAtom: atom,
        registerOnce,
        commitTerminal: registerOnce,
        select: async () => [],
        register: async () => {
          throw new Error("Identity must use idempotent registration");
        },
      });
      return slots.get(JSON.stringify(["core.identity.context", id]))!;
    },
  };
}

it("reuses a Web conversation scope without creating a persistent person", async () => {
  const f = await fixture();
  const destination = { kind: "web" as const, conversationId: conversationA };
  const first = await f.inbound("first", destination);
  const second = await f.inbound("second", destination);
  const other = await f.inbound("other", {
    kind: "web",
    conversationId: conversationB,
  });
  const adapter = await f.inbound("adapter", destination, "web", "web.other");
  expect(first.payload.scopeInformationId).toBe(
    second.payload.scopeInformationId,
  );
  expect(first.payload.scopeInformationId).not.toBe(
    other.payload.scopeInformationId,
  );
  expect(first.payload.scopeInformationId).not.toBe(
    adapter.payload.scopeInformationId,
  );
  expect(await f.inbound("first", destination)).toBe(first);
  expect(f.all(chatScopeEntityInformationKind.kind)).toHaveLength(3);
  for (const terminal of [first, second, other, adapter]) {
    expect(terminal.payload).toMatchObject({
      scopeMode: "ephemeral",
      status: "unresolved",
    });
    expect(terminal.payload.personInformationId).toBeUndefined();
    expect(terminal.payload.accountInformationId).toBeUndefined();
  }
  expect(f.all(personEntityInformationKind.kind)).toHaveLength(0);
  expect(f.all(platformAccountEntityInformationKind.kind)).toHaveLength(0);
});

it("preserves per-inbound scopes for legacy Web and canonical identities for QQ", async () => {
  const f = await fixture();
  const legacyFirst = await f.inbound("legacy-first", { kind: "web" });
  const legacySecond = await f.inbound("legacy-second", { kind: "web" });
  expect(legacyFirst.payload.scopeInformationId).not.toBe(
    legacySecond.payload.scopeInformationId,
  );
  const destination = { kind: "private" as const, userId: "same-sender" };
  const qqFirst = await f.inbound("qq-first", destination, "qq", "qq.main");
  const qqSecond = await f.inbound("qq-second", destination, "qq", "qq.main");
  expect(qqFirst.payload).toMatchObject({
    scopeMode: "canonical",
    status: "complete",
  });
  expect(qqSecond.payload).toEqual(qqFirst.payload);
  expect(f.all(personEntityInformationKind.kind)).toHaveLength(1);
  expect(f.all(platformAccountEntityInformationKind.kind)).toHaveLength(1);
});
