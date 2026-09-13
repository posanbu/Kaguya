/**
 * 功能概述：验证跨会话正文确认节点不会破坏已投递消息的引用链。
 * 主要职责：只在回执、请求、确认、assistant 目标和身份一致时返回正文；伪造确认或缺失回执不猜测。
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
import { resolveMessageQuote } from "./message-quote.js";
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
