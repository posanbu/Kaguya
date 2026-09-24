/**
 * 功能概述：保护规划前知识检索的 canonical 身份、scope 和有界原文旁路。
 * 主要职责：检验数据库角色设定召回、多人预算公平与失败隔离，以及多人同群、未解析/临时身份拒绝、错误检索来源隔离及 knowledge 未启用的空结果。
 * 代码库关系：使用真实 selectKnowledgeMemory 和 heartflowMemorySelector，防止 Core 可读授权被误当作聊天范围授权。
 * 身份终态样本引用 personContextCompletedInformationKind，与检索器共享事件定义，避免命名空间迁移后样本被过滤。
 * 输入输出与副作用：以冻结 Information 原子驱动只读替身，无网络或数据库。
 */
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";
import { atom, target } from "../message-composer/test-fixtures.js";
import { heartflowMemorySelector } from "../heartflow/index.js";
import { selectKnowledgeMemory } from "./selector.js";
import { personContextCompletedInformationKind } from "../information-kinds.js";
import { GLOBAL_MEMORY_SCOPE_ID, USER_STATEMENT_KIND } from "@kaguya/schema";

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
      atom("identity", personContextCompletedInformationKind.kind, {
        status: options.status ?? "complete",
        scopeMode: options.scopeMode ?? "canonical",
        scopeInformationId: "scope-1",
        personInformationId: "person-1",
      }),
    ]),
    find: vi.fn(async () => [
      atom("scope-1", "memory.identity.chat.scope.entity", {
        ...target,
        scopeMode: "canonical",
      }),
    ]),
    retrieve: vi.fn(async () => options.retrieved ?? []),
  };
}

describe("planning knowledge recall", () => {
  it("recalls the same global manual evidence in Web and native chats even with unresolved identity", async () => {
    const payload = {
      requestId: "3cf97a61-741c-4294-af7b-f8a430d1bc09",
      sessionId: "178933a7-7c91-4d34-a21b-b0d6f441cbfa",
      scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
      sourceType: "character_setting",
      submitter: "webui:management",
      text: "小夏喜欢天文",
      originalSourceInformationId: "original",
      scope: {
        platform: "web",
        adapterId: "web.ui.main",
        destination: { kind: "web" },
      },
    };
    const reference = [
      { relation: "agent:scope", informationId: GLOBAL_MEMORY_SCOPE_ID },
    ];
    const manual = atom(
      "global-manual",
      USER_STATEMENT_KIND,
      payload,
      reference,
    );
    const ledger = reader({
      status: "ambiguous",
      retrieved: [
        manual,
        atom("forged", USER_STATEMENT_KIND, payload),
        atom(
          "old-scope",
          USER_STATEMENT_KIND,
          { ...payload, scopeInformationId: "other-scope" },
          reference,
        ),
        inbound("foreign", "other-group"),
      ],
    });
    const web = atom("web", "core.message.inbound.text", {
      text: "小夏喜欢什么？",
      source: {
        platform: "web",
        adapterId: "webui",
        destination: { kind: "web" },
        senderId: "browser",
        platformMessageId: "web",
      },
    });
    for (const current of [
      web,
      inbound("qq-a"),
      inbound("qq-b", "another-group"),
    ]) {
      expect(
        await selectKnowledgeMemory(ledger, {
          inbounds: [current],
          occurredBefore: cutoff,
          recordedBefore: recorded,
          limit: 8,
        }),
      ).toEqual([manual]);
    }
  });
  it("returns empty Web memory when the knowledge strategy is disabled", async () => {
    const ledger = reader();
    ledger.retrieve = vi.fn(async () => {
      throw new Error("disabled");
    });
    const current = atom("web-current", "core.message.inbound.text", {
      text: "小夏喜欢什么？",
      source: {
        platform: "web",
        adapterId: "webui",
        destination: { kind: "web" },
        senderId: "browser",
        platformMessageId: "web-current",
      },
    });
    await expect(
      selectKnowledgeMemory(ledger, {
        inbounds: [current],
        occurredBefore: cutoff,
        recordedBefore: recorded,
        limit: 8,
      }),
    ).resolves.toEqual([]);
    expect(ledger.retrieve).toHaveBeenCalledOnce();
  });
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
        atom("wiki", "memory.text", { text: "unsupported summary" }),
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
    expect(ledger.related).toHaveBeenCalledTimes(2);
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
      expect(ledger.retrieve).toHaveBeenCalledOnce();
      expect(ledger.retrieve).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            scopeInformationId: "memory:access:global",
            userStatementsOnly: true,
          }),
        }),
      );
    },
  );

  it("keeps sparse recall available when knowledge strategy is disabled", async () => {
    const current = inbound("current");
    const candidate = atom("candidate", "agent.turn.candidate", {
      asOf: cutoff,
      scopeKey: "qq:adapter:group:group-1",
      platform: target.platform,
      adapterId: target.adapterId,
      destination: target.destination,
      unreadThroughInformationId: current.informationId,
    });
    const ledger = reader();
    const entityReader = ledger.find;
    ledger.find = vi.fn(async (query) =>
      query.kinds?.includes("core.message.inbound.text")
        ? [current]
        : entityReader(query),
    );
    ledger.retrieve = vi.fn(async (query) => {
      if (query.strategyId === "memory.knowledge") throw new Error("disabled");
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
      scopeKey: "qq:adapter:group:group-1",
      platform: target.platform,
      adapterId: target.adapterId,
      destination: target.destination,
      unreadThroughInformationId: current.informationId,
    });
    const ledger = reader();
    const entityReader = ledger.find;
    ledger.find = vi.fn(async (query) =>
      query.kinds?.includes("core.message.inbound.text")
        ? [current]
        : entityReader(query),
    );
    ledger.retrieve = vi.fn(async (query) =>
      query.strategyId === "memory.knowledge"
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
      expect.objectContaining({ strategyId: "memory.sparse", limit: 4 }),
    );
  });
});

it("retrieves stored character evidence by agent name without copying another person's preference", async () => {
  const payload = {
    requestId: "3cf97a61-741c-4294-af7b-f8a430d1bc09",
    sessionId: "178933a7-7c91-4d34-a21b-b0d6f441cbfa",
    scopeInformationId: GLOBAL_MEMORY_SCOPE_ID,
    sourceType: "character_setting",
    submitter: "webui:management",
    text: "辉夜喜欢天文，会关心行星观测",
    originalSourceInformationId: "original",
    scope: {
      platform: "web",
      adapterId: "web.ui.main",
      destination: { kind: "web" },
    },
  };
  const self = atom("self-interest", USER_STATEMENT_KIND, payload, [
    { relation: "agent:scope", informationId: GLOBAL_MEMORY_SCOPE_ID },
  ]);
  const other = atom(
    "other-interest",
    USER_STATEMENT_KIND,
    { ...payload, sourceType: "user_statement", text: "小夏喜欢天文" },
    [...self.references],
  );
  const ledger = reader();
  ledger.retrieve = vi.fn(async (request) =>
    request.input.query === "辉夜" ? [other, self] : [],
  );
  const result = await selectKnowledgeMemory(ledger, {
    inbounds: [inbound("current")],
    occurredBefore: cutoff,
    recordedBefore: recorded,
    limit: 4,
    agentNames: ["Kaguya", "辉夜"],
  });
  expect(result).toEqual([self]);
  expect(ledger.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        query: "辉夜",
        userStatementsOnly: true,
        recordedBefore: recorded,
        occurredBefore: cutoff,
      }),
    }),
  );
});

it("uses up to four recent participants and shares evidence slots without starving later speakers", async () => {
  const ledger = reader();
  ledger.related = vi.fn(async ({ from }) => [
    atom(`identity-${from[0]}`, personContextCompletedInformationKind.kind, {
      status: "complete",
      scopeMode: "canonical",
      scopeInformationId: "scope-1",
      personInformationId: `person-${from[0]}`,
    }),
  ]);
  ledger.retrieve = vi.fn(async (request) =>
    request.input.entityInformationId
      ? Array.from({ length: 4 }, (_, i) =>
          inbound(`${request.input.entityInformationId}-${i}`),
        )
      : [],
  );
  const selected = await selectKnowledgeMemory(ledger, {
    inbounds: Array.from({ length: 6 }, (_, i) => inbound(`speaker-${i}`)),
    occurredBefore: cutoff,
    recordedBefore: recorded,
    limit: 4,
  });
  expect(selected.map((a) => a.informationId)).toEqual([
    "person-speaker-5-0",
    "person-speaker-4-0",
    "person-speaker-3-0",
    "person-speaker-2-0",
  ]);
  expect(ledger.related).toHaveBeenCalledTimes(4);
});

it("keeps another participant's evidence when one identity lookup fails", async () => {
  const ledger = reader({ retrieved: [inbound("available-background")] });
  const related = ledger.related;
  ledger.related = vi.fn(async (request) => {
    if (request.from[0] === "bad") throw new Error("unavailable");
    return related(request);
  });
  const selected = await selectKnowledgeMemory(ledger, {
    inbounds: [inbound("good"), inbound("bad")],
    occurredBefore: cutoff,
    recordedBefore: recorded,
    limit: 4,
  });
  expect(selected.map((a) => a.informationId)).toEqual([
    "available-background",
  ]);
});
