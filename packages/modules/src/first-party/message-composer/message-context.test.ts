/**
 * 功能概述：验证编写选择器完整保留冻结 turn，不将最后一条消息替换为 intent 的复制正文。
 * 主要职责：测试完整输入授权、历史 cutoff、已投递 assistant 过滤和缺失上下文拒绝。
 * 代码库关系：调用真实 turnMessageContextSelector，ledger fixture 仅提供授权事实与查询结果。
 * 输入输出与副作用：只读内存样本并记录查询，无数据库或网络。
 */
import { describe, expect, it, vi } from "vitest";
import type { InformationSelectorContext } from "@kaguya/sdk";
import { turnMessageContextSelector } from "./message-context.js";
import { atom, fixture, target } from "./test-fixtures.js";
import { assistantTextInformationKind } from "../information-kinds.js";
function ledger(
  f: ReturnType<typeof fixture>,
): InformationSelectorContext["ledger"] {
  return {
    find: vi.fn(async () => []),
    related: vi.fn(async (q) =>
      q.from.includes(f.intent.informationId)
        ? [f.turn]
        : q.from.includes(f.turn.informationId)
          ? f.messages
          : [],
    ),
    retrieve: vi.fn(async () => []),
  };
}
describe("turnMessageContextSelector", () => {
  it("selects all 35 frozen inputs without applying history budgets", async () => {
    const f = fixture(Array.from({ length: 35 }, (_, i) => `body-${i}`));
    const reader = ledger(f);
    const ids = await turnMessageContextSelector.select({
      sourceAtom: f.intent,
      ledger: reader,
    });
    expect(ids).toEqual([
      f.intent.informationId,
      f.turn.informationId,
      ...f.messages.map((m) => m.informationId),
    ]);
    expect(reader.find).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredBefore: "2026-09-09T00:00:02.000Z",
        payloadContains: { source: target },
      }),
    );
  });
  it("rejects missing turn and missing frozen input authorization", async () => {
    const f = fixture();
    const reader = ledger(f);
    reader.related = async () => [];
    await expect(
      turnMessageContextSelector.select({
        sourceAtom: f.intent,
        ledger: reader,
      }),
    ).rejects.toThrow("frozen turn");
    reader.related = async (q) =>
      q.from.includes(f.intent.informationId) ? [f.turn] : f.messages.slice(1);
    await expect(
      turnMessageContextSelector.select({
        sourceAtom: f.intent,
        ledger: reader,
      }),
    ).rejects.toThrow("input reference");
  });
  it("excludes undelivered assistant history", async () => {
    const f = fixture();
    const reader = ledger(f);
    reader.find = async () => [
      atom("undelivered", assistantTextInformationKind.kind, {
        text: "hidden",
        source: target,
        originatingModuleInstanceId: "composer",
        turn: null,
      }),
    ];
    const ids = await turnMessageContextSelector.select({
      sourceAtom: f.intent,
      ledger: reader,
    });
    expect(ids).not.toContain("undelivered");
  });
});
