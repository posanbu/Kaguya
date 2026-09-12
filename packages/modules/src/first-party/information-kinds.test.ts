/**
 * 功能概述：校验第一方持久化消息协议的严格边界，防止旧 reply 数据混入消息意图。
 * 主要职责：覆盖 intent 必填字段及嵌套对象、独立 inbound 来源、assistant 目标元数据、
 * association 路由与因果引用，以及 turn/wake 策略必填约束。
 * 代码库关系：直接调用 information-kinds.ts 的 schema/definition，无数据库或平台副作用；
 * source/intentPayload 提供入站与意图的独立样本，错误样本必须由 safeParse 拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  assistantTextInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
  associationRequestedInformationKind,
  associationCompletedInformationPayloadSchema,
  deliveryRequestedInformationKind,
  waitRequestedInformationKind,
} from "./information-kinds.js";

describe("persistent first-party information payloads", () => {
  it("requires explicit turn provenance on assistant and delivery facts", () => {
    const assistant = {
      text: "hello",
      source: {
        adapterId: "web.ui.main",
        platform: "web",
        destination: { kind: "web" },
      },
      originatingModuleInstanceId: "message-composer.default",
    };
    expect(
      assistantTextInformationKind.payloadSchema.safeParse({
        ...assistant,
        turn: null,
      }).success,
    ).toBe(true);
    expect(
      assistantTextInformationKind.payloadSchema.safeParse(assistant).success,
    ).toBe(false);
    expect(
      deliveryRequestedInformationKind.payloadSchema.safeParse({
        adapterId: "web.ui.main",
        platform: "web",
        destination: { kind: "web" },
        message: { kind: "text", text: "hello" },
      }).success,
    ).toBe(false);
  });

  it("requires an explicit wake-on-message policy", () => {
    expect(
      waitRequestedInformationKind.payloadSchema.safeParse({
        dueAt: "2026-09-10T00:00:00.000Z",
        delayMs: 1000,
        reason: "attention-deferred",
        attempt: 0,
        totalWaitBudget: 3,
        wakePolicy: "recheckAt",
        source: source(),
        sourceInformationIds: ["source-1"],
      }).success,
    ).toBe(false);
  });
});

function source() {
  return {
    platform: "web",
    adapterId: "web.ui.main",
    platformMessageId: "message-1",
    senderId: "user-1",
    destination: { kind: "web" as const },
  };
}

function intentPayload() {
  return {
    target: {
      adapterId: "adapter",
      platform: "qq",
      destination: { kind: "private" as const, userId: "user-1" },
    },
    turn: {
      candidateInformationId: "candidate",
      claimInformationId: "claim",
      contextInformationId: "context",
    },
    memoryInformationIds: [],
  };
}

describe("message intent protocol", () => {
  it("requires the complete strict payload, including an explicit empty memory list", () => {
    const payload = intentPayload();
    expect(messageIntentRequestedInformationKind.kind).toBe(
      "agent.message.intent.requested",
    );
    expect(
      messageIntentRequestedInformationPayloadSchema.parse(payload),
    ).toEqual(payload);
    for (const key of Object.keys(payload)) {
      const incomplete = { ...payload } as Record<string, unknown>;
      delete incomplete[key];
      expect(
        messageIntentRequestedInformationPayloadSchema.safeParse(incomplete)
          .success,
      ).toBe(false);
    }
    for (const field of ["target", "turn"] as const) {
      for (const key of Object.keys(payload[field])) {
        const incomplete = { ...payload[field] } as Record<string, unknown>;
        delete incomplete[key];
        expect(
          messageIntentRequestedInformationPayloadSchema.safeParse({
            ...payload,
            [field]: incomplete,
          }).success,
        ).toBe(false);
      }
      expect(
        messageIntentRequestedInformationPayloadSchema.safeParse({
          ...payload,
          [field]: { ...payload[field], extra: true },
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    { text: "copied body" },
    { source: source() },
    { replyTo: { platformMessageId: "inbound" } },
    { platformMessageId: "inbound" },
    { memoryInformationIds: [""] },
    { memoryInformationIds: null },
    { target: { ...intentPayload().target, platformMessageId: "inbound" } },
    { target: { ...intentPayload().target, adapterId: " " } },
    {
      target: {
        ...intentPayload().target,
        destination: { kind: "private", userId: "user-1", replyTo: "inbound" },
      },
    },
  ])("rejects legacy or invalid intent data %j", (invalid) => {
    expect(
      messageIntentRequestedInformationPayloadSchema.safeParse({
        ...intentPayload(),
        ...invalid,
      }).success,
    ).toBe(false);
  });

  it("keeps inbound text and sender metadata independent of the intent", () => {
    expect(
      inboundTextInformationKind.payloadSchema.safeParse({
        text: "hello",
        source: source(),
      }).success,
    ).toBe(true);
    expect(
      inboundTextInformationKind.payloadSchema.safeParse(intentPayload())
        .success,
    ).toBe(false);
    expect(
      inboundTextInformationKind.payloadSchema.safeParse({
        text: "hello",
        source: intentPayload().target,
      }).success,
    ).toBe(false);
    expect(
      inboundTextInformationKind.payloadSchema.safeParse({
        text: "hello",
        source: source(),
        turn: intentPayload().turn,
      }).success,
    ).toBe(false);
  });

  it("accepts assistant routing without an inbound sender or message ID", () => {
    const payload = {
      text: "generated",
      source: intentPayload().target,
      originatingModuleInstanceId: "composer.default",
      turn: intentPayload().turn,
    };
    expect(
      assistantTextInformationKind.payloadSchema.safeParse(payload).success,
    ).toBe(true);
    expect(
      assistantTextInformationKind.payloadSchema.safeParse({
        ...payload,
        source: {
          ...payload.source,
          selfId: "bot",
          platformMessageId: "delivered-history",
        },
      }).success,
    ).toBe(true);
    expect(
      assistantTextInformationKind.payloadSchema.safeParse({
        ...payload,
        source: {
          ...payload.source,
          replyTo: { platformMessageId: "inbound" },
        },
      }).success,
    ).toBe(false);
  });

  it("requires claim and candidate references and moves association to the message route", () => {
    expect(messageIntentRequestedInformationKind.references).toMatchObject({
      "core:caused-by": {
        required: true,
        targetKinds: ["agent.attention.arousal.completed"],
      },
      "core:uses-context": {
        required: true,
        targetKinds: ["agent.turn.context.completed"],
      },
      "agent:turn-claim": { required: true },
      "agent:turn-candidate": { required: true },
    });
    expect(
      associationRequestedInformationKind.references["core:caused-by"]!
        .targetKinds,
    ).toEqual([messageIntentRequestedInformationKind.kind]);
    const payload = {
      requestInformationId: "request",
      queryInformationId: "query",
      sourceInformationId: "intent",
      route: "message",
      method: "sparse-2gram",
      status: "empty",
      candidateCount: 0,
      reasonCodes: ["empty"],
    };
    expect(
      associationCompletedInformationPayloadSchema.safeParse(payload).success,
    ).toBe(true);
    expect(
      associationCompletedInformationPayloadSchema.safeParse({
        ...payload,
        route: "reply",
      }).success,
    ).toBe(false);
  });
});
