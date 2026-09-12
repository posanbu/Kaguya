/**
 * 功能概述：为消息编写契约与整轮回归提供可验证的冻结账本样本。
 * 主要职责：fixture 构造 intent、turn 和全部入站原子；atom 统一冻结 ID、时间与引用。
 * 代码库关系：本目录测试共享此构造器，真实编译器仍通过 information-kinds schema 校验输入。
 * 输入输出与副作用：输入正文数组，返回独立冻结样本；不使用数据库、网络或全局可变状态。
 */
import {
  freezeInformationAtom,
  informationIdSchema,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import {
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";
export const target = {
  adapterId: "adapter",
  platform: "qq",
  destination: { kind: "group" as const, groupId: "group-1" },
};
export const identity = {
  name: "Kaguya",
  aliases: ["辉夜"],
  persona: "温和自然",
};
export function atom(
  id: string,
  kind: string,
  payload: InformationAtom["payload"],
  references: InformationAtom["references"] = [],
): DeepReadonly<InformationAtom> {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse(id),
    kind,
    payload,
    references,
    source: "test:composer",
    occurredAt: "2026-09-09T00:00:01.000Z",
  });
}
export function fixture(texts = ["FIRST_INPUT", "LAST_INPUT"]) {
  const messages = texts.map((text, index) =>
    atom(`input-${index}`, inboundTextInformationKind.kind, {
      text,
      source: {
        ...target,
        senderId: `sender-${index}`,
        selfId: "bot-1",
        platformMessageId: `platform-${index}`,
        ...(index > 0
          ? { replyTo: { platformMessageId: `platform-${index - 1}` } }
          : {}),
      },
    }),
  );
  const turn = atom(
    "turn-1",
    turnContextCompletedInformationKind.kind,
    {
      candidateInformationId: "candidate-1",
      claimInformationId: "claim-1",
      scopeKey: "test-scope",
      asOf: "2026-09-09T00:00:02.000Z",
      inputs: messages.map((message) => ({
        informationId: message.informationId,
        occurredAt: message.occurredAt,
        ...message.payload,
        identity: {
          terminalInformationId: "identity-1",
          status: "complete",
          scopeMode: "ephemeral",
        },
      })),
      text: "LEGACY_LAST_BODY_MUST_NOT_APPEAR",
      source: inboundTextInformationKind.payloadSchema.parse(
        messages[0]!.payload,
      ).source,
      messageCount: messages.length,
      isPrivate: false,
      isGroup: true,
      mentionedSelf: false,
      repliedToSelf: false,
      namedSelf: false,
      recentSelfReplies: 0,
      recentWindowMessages: 0,
      idleReachedAverage: false,
      frequency: 1,
      muted: false,
      safe: true,
      destinationAvailable: true,
      stale: false,
      attempt: 0,
      totalWaitBudget: 0,
    },
    messages.map((message) => ({
      relation: "core:uses-context",
      informationId: message.informationId,
    })),
  );
  const intent = atom(
    "intent-1",
    messageIntentRequestedInformationKind.kind,
    {
      target,
      turn: {
        candidateInformationId: "candidate-1",
        claimInformationId: "claim-1",
        contextInformationId: turn.informationId,
      },
      memoryInformationIds: [],
    },
    [
      { relation: "core:uses-context", informationId: turn.informationId },
      {
        relation: "core:context",
        informationId: informationIdSchema.parse("runtime-context"),
      },
    ],
  );
  return { intent, turn, messages, atoms: [intent, turn, ...messages] };
}
