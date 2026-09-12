/**
 * 功能概述：构造消息 Prompt 评测用的完整冻结 turn 与最小意图，不复制目标消息正文到意图。
 * 主要职责：messageFixture 将正文数组转换为同一会话内的入站原子和 turn.inputs，并附上明确的 turn 身份。
 * 代码库关系：provider.cjs 将结果交给真实 compileMessagePrompt，生产 schema 决定字段有效性。
 * 输入输出与副作用：每次返回独立内存对象，旧版摘要放置哨兵以检测错误读取；无文件与网络副作用。
 */
function messageFixture(texts) {
  const target = {
    adapterId: "eval",
    platform: "qq",
    destination: { kind: "group", groupId: "group-1" },
  };
  const make = (informationId, kind, payload) => ({
    informationId,
    kind,
    payload,
    references: [],
    source: "eval:prompt",
    occurredAt: "2026-09-09T00:00:01.000Z",
  });
  const messages = texts.map((text, i) =>
    make(`input-${i}`, "core.message.inbound.text", {
      text,
      source: {
        ...target,
        senderId: `sender-${i}`,
        platformMessageId: `platform-${i}`,
        selfId: "bot-1",
      },
    }),
  );
  const turn = make("turn-1", "agent.turn.context.completed", {
    candidateInformationId: "candidate-1",
    claimInformationId: "claim-1",
    scopeKey: "eval-scope",
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
    text: "LEGACY_COPIED_BODY",
    source: messages[0]?.payload.source,
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
  });
  const intent = make("intent-1", "agent.message.intent.requested", {
    target,
    turn: {
      candidateInformationId: "candidate-1",
      claimInformationId: "claim-1",
      contextInformationId: "turn-1",
    },
    memoryInformationIds: [],
  });
  return { atoms: [intent, turn, ...messages], intentId: intent.informationId };
}
module.exports = { messageFixture };
