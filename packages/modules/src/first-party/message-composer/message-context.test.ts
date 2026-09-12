/**
 * 功能概述：验证编写选择器完整保留冻结 turn，不将最后一条消息替换为 intent 的复制正文。
 * 主要职责：测试完整输入授权、历史 cutoff、已投递 assistant 过滤、引用链溯源及跨作用域/失败/未来/歧义拒绝。
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

// 用真实 references 驱动查询，串联 selector 与 compiler，避免 fixture 替实现猜测因果。
function quoteFixture() {
  const f = fixture(["CURRENT_INPUT"]);
  const input = quoteAtom("input-0", f.messages[0]!.kind, {
    ...f.messages[0]!.payload,
    source: {
      ...target,
      senderId: "user",
      platformMessageId: "current",
      replyTo: { platformMessageId: "sent-1" },
    },
  });
  const turn = quoteAtom(
    f.turn.informationId,
    f.turn.kind,
    {
      ...f.turn.payload,
      inputs: [
        {
          informationId: input.informationId,
          occurredAt: input.occurredAt,
          ...input.payload,
          identity: {
            terminalInformationId: "identity-1",
            status: "complete",
            scopeMode: "ephemeral",
          },
        },
      ],
    },
    f.turn.references.map((reference) => ({ ...reference })),
  );
  const assistant = quoteAtom(
    "quoted-assistant",
    assistantTextInformationKind.kind,
    {
      text: "DELIVERED_REPLY",
      source: target,
      originatingModuleInstanceId: "composer",
      turn: null,
    },
  );
  const request = quoteAtom(
    "delivery-request",
    "core.delivery.requested",
    {
      ...target,
      message: { kind: "text", text: "DELIVERED_REPLY" },
      turn: null,
    },
    [{ relation: "core:caused-by", informationId: assistant.informationId }],
  );
  const receipt = quoteAtom(
    "delivery-receipt",
    "core.delivery.delivered",
    {
      platform: target.platform,
      adapterId: target.adapterId,
      target: target.destination,
      ok: true,
      platformMessageId: "sent-1",
    },
    [{ relation: "core:status-of", informationId: request.informationId }],
  );
  return { intent: f.intent, input, turn, assistant, request, receipt };
}

type TestAtom = ReturnType<typeof atom>;
function quoteAtom(
  id: string,
  kind: string,
  payload: unknown,
  references: TestAtom["references"] = [],
): TestAtom {
  return atom(
    id,
    kind,
    JSON.parse(JSON.stringify(payload)),
    references.map((reference) => ({ ...reference })),
  );
}
function graphLedger(
  atoms: readonly TestAtom[],
): InformationSelectorContext["ledger"] {
  const contains = (value: unknown, pattern: unknown): boolean => {
    if (pattern === null || typeof pattern !== "object")
      return value === pattern;
    return (
      value !== null &&
      typeof value === "object" &&
      Object.entries(pattern).every(([key, expected]) =>
        contains((value as Record<string, unknown>)[key], expected),
      )
    );
  };
  return {
    find: vi.fn(async (query) =>
      atoms
        .filter(
          (entry) =>
            (!query.kinds || query.kinds.includes(entry.kind)) &&
            (!query.occurredBefore ||
              Date.parse(entry.occurredAt) <
                Date.parse(query.occurredBefore)) &&
            (!query.payloadContains ||
              contains(entry.payload, query.payloadContains)),
        )
        .slice(0, query.limit),
    ),
    related: vi.fn(async (query) =>
      atoms
        .filter((entry) =>
          query.direction === "outgoing"
            ? atoms.some(
                (from) =>
                  query.from.includes(from.informationId) &&
                  from.references.some(
                    (reference) =>
                      reference.informationId === entry.informationId &&
                      reference.relation === query.relation,
                  ),
              )
            : entry.references.some(
                (reference) =>
                  query.from.includes(reference.informationId) &&
                  reference.relation === query.relation,
              ),
        )
        .slice(0, query.limit),
    ),
    retrieve: vi.fn(async () => []),
  };
}

import { compileMessagePrompt } from "./message-prompt.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { identity } from "./test-fixtures.js";
const quoteTemplates = loadFirstPartyPromptTemplates().messageComposer;

it("selects original successful delivery chain and renders its full quote provenance without changing assistant source", async () => {
  const f = quoteFixture();
  const atoms = Object.values(f);
  const before = JSON.stringify(atoms);
  const ids = await turnMessageContextSelector.select({
    sourceAtom: f.intent,
    ledger: graphLedger(atoms),
  });
  for (const entry of [f.receipt, f.request, f.assistant])
    expect(ids).toContain(entry.informationId);
  const result = compileMessagePrompt(
    quoteTemplates,
    identity,
    atoms.filter((entry) => ids.includes(entry.informationId)),
    f.intent.informationId,
  );
  const turn = result.variables.find((entry) => entry.name === "turn")!;
  expect(turn.content).toContain("【入站引用参考】");
  expect(turn.content).toContain("Kaguya：DELIVERED_REPLY");
  expect(turn.informationIds).toEqual([
    f.input.informationId,
    f.receipt.informationId,
    f.request.informationId,
    f.assistant.informationId,
  ]);
  expect(JSON.stringify(atoms)).toBe(before);
  expect(f.assistant.payload.source).toEqual(target);
});

it.each([
  "receipt-scope",
  "request-scope",
  "assistant-scope",
  "failed",
  "future",
  "future-request",
  "future-assistant",
  "ambiguous-receipt",
  "ambiguous-request",
  "ambiguous-assistant",
  "missing-reference",
])("rejects %s delivery quotes in selector and compiler", async (scenario) => {
  const f = quoteFixture();
  const atoms: TestAtom[] = [
    f.intent,
    f.input,
    f.turn,
    f.assistant,
    f.request,
    f.receipt,
  ];
  const replace = (original: TestAtom, changed: TestAtom) => {
    atoms[atoms.indexOf(original)] = changed;
  };
  if (scenario === "receipt-scope")
    replace(
      f.receipt,
      quoteAtom(
        f.receipt.informationId,
        f.receipt.kind,
        { ...f.receipt.payload, target: { kind: "group", groupId: "other" } },
        [...f.receipt.references],
      ),
    );
  if (scenario === "request-scope")
    replace(
      f.request,
      quoteAtom(
        f.request.informationId,
        f.request.kind,
        { ...f.request.payload, adapterId: "other" },
        [...f.request.references],
      ),
    );
  if (scenario === "assistant-scope")
    replace(
      f.assistant,
      quoteAtom(f.assistant.informationId, f.assistant.kind, {
        ...f.assistant.payload,
        source: { ...target, platform: "other" },
      }),
    );
  if (scenario === "failed")
    replace(
      f.receipt,
      quoteAtom(
        f.receipt.informationId,
        "core.delivery.failed",
        { ...f.receipt.payload, ok: false },
        [...f.receipt.references],
      ),
    );
  if (scenario.startsWith("future")) {
    const entry =
      scenario === "future-request"
        ? f.request
        : scenario === "future-assistant"
          ? f.assistant
          : f.receipt;
    replace(entry, { ...entry, occurredAt: "2026-09-09T00:00:03.000Z" });
  }
  if (scenario === "ambiguous-receipt")
    atoms.push(
      quoteAtom("second-receipt", f.receipt.kind, { ...f.receipt.payload }, [
        ...f.receipt.references,
      ]),
    );
  if (scenario === "ambiguous-request")
    replace(
      f.receipt,
      quoteAtom(
        f.receipt.informationId,
        f.receipt.kind,
        { ...f.receipt.payload },
        [
          ...f.receipt.references,
          { relation: "core:status-of", informationId: "other-request" },
        ],
      ),
    );
  if (scenario === "ambiguous-assistant")
    replace(
      f.request,
      quoteAtom(
        f.request.informationId,
        f.request.kind,
        { ...f.request.payload },
        [
          ...f.request.references,
          { relation: "core:caused-by", informationId: "other-assistant" },
        ],
      ),
    );
  if (scenario === "missing-reference")
    replace(
      f.receipt,
      quoteAtom(f.receipt.informationId, f.receipt.kind, {
        ...f.receipt.payload,
      }),
    );
  const ids = await turnMessageContextSelector.select({
    sourceAtom: f.intent,
    ledger: graphLedger(atoms),
  });
  if (scenario === "ambiguous-receipt") {
    expect(ids).toContain(f.receipt.informationId);
    expect(ids).toContain("second-receipt");
  } else expect(ids).not.toContain(f.receipt.informationId);
  expect(ids).not.toContain(f.request.informationId);
  for (const selected of [
    atoms,
    atoms.filter((entry) => ids.includes(entry.informationId)),
  ]) {
    const turn = compileMessagePrompt(
      quoteTemplates,
      identity,
      selected,
      f.intent.informationId,
    ).variables.find((entry) => entry.name === "turn")!;
    expect(turn.content).not.toContain("【入站引用参考】");
    expect(turn.informationIds).toEqual([f.input.informationId]);
  }
});

it("keeps ordinary historical inbound quotes and their original provenance", async () => {
  const f = quoteFixture();
  const inbound = quoteAtom("old-inbound", f.input.kind, {
    text: "ORDINARY_QUOTE",
    source: { ...target, senderId: "old-user", platformMessageId: "sent-1" },
  });
  const atoms = [f.intent, f.input, f.turn, inbound];
  const ids = await turnMessageContextSelector.select({
    sourceAtom: f.intent,
    ledger: graphLedger(atoms),
  });
  expect(ids).toContain(inbound.informationId);
  const turn = compileMessagePrompt(
    quoteTemplates,
    identity,
    atoms.filter((entry) => ids.includes(entry.informationId)),
    f.intent.informationId,
  ).variables.find((entry) => entry.name === "turn")!;
  expect(turn.content).toContain("ORDINARY_QUOTE");
  expect(turn.informationIds).toEqual([
    f.input.informationId,
    inbound.informationId,
  ]);
});

it("retains lookup ambiguity evidence when recent history contains only one matching inbound", async () => {
  const f = quoteFixture();
  const first = quoteAtom("recent-match", f.input.kind, {
    text: "RECENT_MATCH",
    source: { ...target, senderId: "user-a", platformMessageId: "sent-1" },
  });
  const second = quoteAtom("older-match", f.input.kind, {
    text: "OLDER_MATCH",
    source: { ...target, senderId: "user-b", platformMessageId: "sent-1" },
  });
  const atoms = [f.intent, f.turn, f.input, first, second];
  const reader = graphLedger(atoms);
  const find = reader.find;
  reader.find = vi.fn(async (query) =>
    query.kinds?.includes(assistantTextInformationKind.kind)
      ? [first]
      : find(query),
  );
  const ids = await turnMessageContextSelector.select({
    sourceAtom: f.intent,
    ledger: reader,
  });
  expect(ids).toContain(first.informationId);
  expect(ids).toContain(second.informationId);
  const turn = compileMessagePrompt(
    quoteTemplates,
    identity,
    atoms.filter((entry) => ids.includes(entry.informationId)),
    f.intent.informationId,
  ).variables.find((entry) => entry.name === "turn")!;
  expect(turn.content).not.toContain("【入站引用参考】");
  expect(turn.informationIds).toEqual([f.input.informationId]);
});
