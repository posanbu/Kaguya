/**
 * 功能概述：保护规划前知识检索的 canonical 身份、scope 和有界原文旁路。
 * 主要职责：检验多人同群、未解析/临时身份拒绝、错误检索来源隔离及 knowledge 未启用的空结果。
 * 代码库关系：使用真实 selectKnowledgeMemory 和 heartflowMemorySelector，防止 Core 可读授权被误当作聊天范围授权。
 * 输入输出与副作用：以冻结 Information 原子驱动只读替身，无网络或数据库。
 */
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";
import { atom, target } from "../message-composer/test-fixtures.js";
import { heartflowMemorySelector } from "../heartflow/index.js";
import { selectKnowledgeMemory } from "./selector.js";

const cutoff = "2026-09-09T00:00:02.000Z";
const recorded = "2026-09-09T00:00:04.000Z";
function inbound(id: string, groupId = target.destination.groupId) {
  return atom(id, "core.message.inbound.text", {
    text: "以前答应去喝咖啡",
    source: {
      ...target,
      destination: { kind: "group", groupId },
      senderId: id,
      platformMessageId: id,
    },
  });
}
function reader(
  options: {
    scopeMode?: string;
    status?: string;
    retrieved?: ReturnType<typeof atom>[];
  } = {},
): InformationSelectorLedger {
  return {
    related: vi.fn(async () => [
      atom("identity", "agent.person.context.completed", {
        status: options.status ?? "complete",
        scopeMode: options.scopeMode ?? "canonical",
        scopeInformationId: "scope-1",
        personInformationId: "person-1",
      }),
    ]),
    find: vi.fn(async () => [
      atom("scope-1", "agent.chat.scope.entity", {
        ...target,
        scopeMode: "canonical",
      }),
    ]),
    retrieve: vi.fn(async () => options.retrieved ?? []),
  };
}

describe("planning knowledge recall", () => {
  it("keeps other speakers in the same scope while rejecting future, foreign and current evidence", async () => {
    const current = [inbound("current-a"), inbound("current-b")];
    const future = {
      ...inbound("future"),
      occurredAt: "2026-09-10T00:00:00.000Z",
    };
    const ledger = reader({
      retrieved: [
        inbound("different-speaker"),
        inbound("foreign", "other-group"),
        current[0]!,
        future,
        atom("wiki", "core.memory.text", { text: "unsupported summary" }),
      ],
    });
    const selected = await selectKnowledgeMemory(ledger, {
      inbounds: current,
      occurredBefore: cutoff,
      recordedBefore: recorded,
      limit: 8,
    });
    expect(selected.map((item) => item.informationId)).toEqual([
      "different-speaker",
    ]);
    expect(ledger.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          scopeInformationId: "scope-1",
          entityInformationId: "person-1",
          occurredBefore: cutoff,
          recordedBefore: recorded,
        }),
      }),
    );
    expect(ledger.related).toHaveBeenCalledTimes(1);
  });

  it.each([{ scopeMode: "ephemeral" }, { status: "ambiguous" }])(
    "does not query knowledge for unusable identity %o",
    async (options) => {
      const ledger = reader(options);
      await expect(
        selectKnowledgeMemory(ledger, {
          inbounds: [inbound("current")],
          occurredBefore: cutoff,
          recordedBefore: recorded,
          limit: 8,
        }),
      ).resolves.toEqual([]);
      expect(ledger.retrieve).not.toHaveBeenCalled();
    },
  );

  it("keeps sparse recall available when knowledge strategy is disabled", async () => {
    const current = inbound("current");
    const candidate = atom("candidate", "agent.turn.candidate", {
      asOf: cutoff,
    });
    const ledger = reader();
    const identityReader = ledger.related;
    ledger.related = async (query) =>
      query.from[0] === candidate.informationId
        ? [current]
        : identityReader(query);
    ledger.retrieve = vi.fn(async (query) => {
      if (query.strategyId === "kaguya.memory.knowledge")
        throw new Error("disabled");
      return [inbound("raw-source"), inbound("foreign", "other-group")];
    });
    await expect(
      heartflowMemorySelector.select({ sourceAtom: candidate, ledger }),
    ).resolves.toEqual(["raw-source"]);
  });

  it("shares the eight-source budget across knowledge and sparse paths", async () => {
    const current = inbound("current");
    const candidate = atom("candidate", "agent.turn.candidate", {
      asOf: cutoff,
    });
    const ledger = reader();
    const identityReader = ledger.related;
    ledger.related = async (query) =>
      query.from[0] === candidate.informationId
        ? [current]
        : identityReader(query);
    ledger.retrieve = vi.fn(async (query) =>
      query.strategyId === "kaguya.memory.knowledge"
        ? Array.from({ length: 6 }, (_, i) => inbound(`knowledge-${i}`))
        : Array.from({ length: 8 }, (_, i) => inbound(`raw-${i}`)),
    );
    const selected = await heartflowMemorySelector.select({
      sourceAtom: candidate,
      ledger,
    });
    expect(selected).toHaveLength(8);
    expect(selected.filter((id) => id.startsWith("knowledge-"))).toHaveLength(
      4,
    );
    expect(ledger.retrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({ strategyId: "kaguya.memory.sparse", limit: 4 }),
    );
  });
});
