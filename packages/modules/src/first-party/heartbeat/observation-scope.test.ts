/**
 * 功能概述：验证 Heartbeat 的浏览器会话范围与观察选择，防止 Web 输入跨 conversationId 合并。
 * 主要职责：scopeOf 用例覆盖会话稳定性与旧范围兼容；Selector 用例在含多会话的内存账本中检查实际返回来源。
 * 代码库关系：直接调用 observation.ts；索引值按数据库约定预置，不依赖被测函数生成测试范围。
 * 输入输出与副作用：使用固定时间与合成入站，无数据库、计时等待、模型或平台 I/O。
 */
import { expect, it, vi } from "vitest";
import { freezeInformationAtom, informationIdSchema } from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { inboundTextInformationKind } from "../information-kinds.js";
import { heartbeatObservationSelector, scopeOf } from "./observation.js";

const conversationA = "11111111-1111-4111-8111-111111111111";
const conversationB = "22222222-2222-4222-8222-222222222222";
const address = (conversationId?: string) => ({
  platform: "web",
  adapterId: "web.ui.main",
  destination: {
    kind: "web" as const,
    ...(conversationId ? { conversationId } : {}),
  },
});

function inbound(id: string, conversationId?: string) {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse(id),
    kind: inboundTextInformationKind.kind,
    occurredAt: "2026-09-19T00:00:00.000Z",
    source: "adapter:web.ui.main",
    payload: inboundTextInformationKind.payloadSchema.parse({
      text: id,
      source: {
        ...address(conversationId),
        senderId: "web",
        platformMessageId: id,
      },
    }),
    references: [],
  });
}

it("keeps Web scope stable within a conversation and preserves legacy scopes", () => {
  expect(scopeOf(address(conversationA))).toBe(
    `web:web.ui.main:web:${conversationA}`,
  );
  expect(scopeOf(address(conversationA))).not.toBe(
    scopeOf(address(conversationB)),
  );
  expect(
    scopeOf({ ...address(conversationA), adapterId: "web.ui.other" }),
  ).not.toBe(scopeOf(address(conversationA)));
  expect(scopeOf(address())).toBe("web:web.ui.main:web:");
  expect(
    scopeOf({
      platform: "qq",
      adapterId: "qq.main",
      destination: { kind: "group", groupId: "group" },
    }),
  ).toBe("qq:qq.main:group:group");
});

it("selects only the current Web conversation inputs from a shared ledger", async () => {
  const first = inbound("a-first", conversationA);
  const second = inbound("a-second", conversationA);
  const other = inbound("b-first", conversationB);
  const legacy = inbound("legacy");
  const rows = [
    { atom: first, scopeKey: `web:web.ui.main:web:${conversationA}` },
    { atom: second, scopeKey: `web:web.ui.main:web:${conversationA}` },
    { atom: other, scopeKey: `web:web.ui.main:web:${conversationB}` },
    { atom: legacy, scopeKey: "web:web.ui.main:web:" },
  ];
  const find = vi.fn<InformationSelectorLedger["find"]>(async (query) => {
    const matched = rows
      .filter(
        (row) =>
          query.kinds?.includes(row.atom.kind) &&
          row.scopeKey === query.scopeKey,
      )
      .map((row) => row.atom);
    return query.order === "desc" ? matched.reverse() : matched;
  });
  const ledger: InformationSelectorLedger = {
    find,
    related: async () => [],
    retrieve: async () => [],
  };

  expect(
    await heartbeatObservationSelector.select({ sourceAtom: second, ledger }),
  ).toEqual([first.informationId, second.informationId]);
  expect(
    await heartbeatObservationSelector.select({ sourceAtom: other, ledger }),
  ).toEqual([other.informationId]);
  expect(
    await heartbeatObservationSelector.select({ sourceAtom: legacy, ledger }),
  ).toEqual([legacy.informationId]);
  expect(find).toHaveBeenCalledWith(
    expect.objectContaining({
      kinds: [inboundTextInformationKind.kind],
      scopeKey: `web:web.ui.main:web:${conversationA}`,
      payloadContains: { source: address(conversationA) },
    }),
  );
});
