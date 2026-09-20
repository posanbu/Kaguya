/**
 * 功能概述：验证跨会话正文确认节点不会破坏已投递消息的引用链。
 * 主要职责：只在回执、请求、确认、assistant 目标和身份一致时返回正文；伪造确认或缺失回执不猜测。
 * Web 用例验证同平台消息 ID 仍须匹配 conversationId，且回执、请求和 assistant 每一层都不能跨会话。
 * 代码库关系：直接测试 message-quote 的纯解析器，供 Composer 历史与入站引用共享。
 * 输入输出与副作用：只构造合成原子，无数据库、模型或平台 I/O。
 */
import { expect, it } from "vitest";
import type {
  DeepReadonly,
  InformationAtom,
  JsonObject,
  InformationId,
} from "@kaguya/schema";
import { resolveMessageQuote, sameMessageTarget } from "./message-quote.js";
const target = {
  adapterId: "test",
  platform: "qq",
  destination: { kind: "group" as const, groupId: "100" },
};
function atom(
  id: string,
  kind: string,
  payload: JsonObject,
  relation?: string,
  parent?: string,
): DeepReadonly<InformationAtom> {
  return {
    informationId: id as InformationId,
    kind,
    source: "test",
    occurredAt: "2026-09-13T00:00:00.000Z",
    payload,
    references:
      relation && parent
        ? [{ relation, informationId: parent as InformationId }]
        : [],
  };
}
it("follows a verified confirmation before exposing the sent assistant text", () => {
  const assistant = atom("assistant", "core.message.assistant.text", {
    text: "approved",
    source: target,
    originatingModuleInstanceId: "composer",
    turn: null,
  });
  const confirmed = atom(
    "confirmed",
    "agent.message.content.confirmed",
    { assistantInformationId: "assistant" },
    "core:caused-by",
    "assistant",
  );
  const request = atom(
    "request",
    "core.delivery.requested",
    { ...target, message: { kind: "text", text: "approved" }, turn: null },
    "core:caused-by",
    "confirmed",
  );
  const receipt = atom(
    "receipt",
    "core.delivery.delivered",
    {
      ok: true,
      platform: "qq",
      adapterId: "test",
      target: target.destination,
      platformMessageId: "sent",
    },
    "core:status-of",
    "request",
  );
  const atoms = [assistant, confirmed, request, receipt];
  expect(
    resolveMessageQuote(
      atoms,
      "sent",
      target,
      "2026-09-14T00:00:00.000Z",
    )?.provenance.map((a) => a.informationId),
  ).toEqual(["receipt", "request", "confirmed", "assistant"]);
  expect(
    resolveMessageQuote(
      [
        assistant,
        { ...confirmed, payload: { assistantInformationId: "different" } },
        request,
        receipt,
      ],
      "sent",
      target,
      "2026-09-14T00:00:00.000Z",
    ),
  ).toBeUndefined();
  expect(
    resolveMessageQuote(
      atoms.slice(0, 3),
      "sent",
      target,
      "2026-09-14T00:00:00.000Z",
    ),
  ).toBeUndefined();
});

const webTarget = {
  adapterId: "web.ui.main",
  platform: "web",
  destination: {
    kind: "web",
    conversationId: "11111111-1111-4111-8111-111111111111",
  },
};
const otherWebTarget = {
  ...webTarget,
  destination: {
    kind: "web",
    conversationId: "22222222-2222-4222-8222-222222222222",
  },
};
const cutoff = "2026-09-14T00:00:00.000Z";

it("resolves an inbound quote only inside its Web conversation", () => {
  const quoted = atom("quoted", "core.message.inbound.text", {
    text: "same conversation",
    source: { ...webTarget, senderId: "web", platformMessageId: "shared-id" },
  });
  const other = atom("other", "core.message.inbound.text", {
    text: "other conversation",
    source: {
      ...otherWebTarget,
      senderId: "web",
      platformMessageId: "shared-id",
    },
  });
  expect(
    resolveMessageQuote([quoted, other], "shared-id", webTarget, cutoff)
      ?.message,
  ).toBe(quoted);
  expect(
    resolveMessageQuote([other], "shared-id", webTarget, cutoff),
  ).toBeUndefined();
  const legacy = { ...webTarget, destination: { kind: "web" } };
  expect(sameMessageTarget(legacy, legacy)).toBe(true);
  expect(sameMessageTarget(legacy, webTarget)).toBe(false);
  expect(sameMessageTarget(webTarget, legacy)).toBe(false);
});

it("requires the entire delivered Web quote chain to stay in the same conversation", () => {
  const assistant = atom("web-assistant", "core.message.assistant.text", {
    text: "reply",
    source: webTarget,
    originatingModuleInstanceId: "composer",
    turn: null,
  });
  const request = atom(
    "web-request",
    "core.delivery.requested",
    {
      ...webTarget,
      message: { kind: "text", text: "reply" },
      turn: null,
    },
    "core:caused-by",
    assistant.informationId,
  );
  const receipt = atom(
    "web-receipt",
    "core.delivery.delivered",
    {
      ok: true,
      platform: webTarget.platform,
      adapterId: webTarget.adapterId,
      target: webTarget.destination,
      platformMessageId: "web-sent",
    },
    "core:status-of",
    request.informationId,
  );
  expect(
    resolveMessageQuote(
      [assistant, request, receipt],
      "web-sent",
      webTarget,
      cutoff,
    )?.message,
  ).toBe(assistant);
  const mismatches = [
    [
      assistant,
      request,
      {
        ...receipt,
        payload: { ...receipt.payload, target: otherWebTarget.destination },
      },
    ],
    [
      assistant,
      {
        ...request,
        payload: {
          ...request.payload,
          destination: otherWebTarget.destination,
        },
      },
      receipt,
    ],
    [
      {
        ...assistant,
        payload: { ...assistant.payload, source: otherWebTarget },
      },
      request,
      receipt,
    ],
  ];
  for (const atoms of mismatches) {
    expect(
      resolveMessageQuote(atoms, "web-sent", webTarget, cutoff),
    ).toBeUndefined();
  }
});
