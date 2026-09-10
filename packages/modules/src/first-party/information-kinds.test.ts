import { describe, expect, it } from "vitest";

import {
  assistantTextInformationKind,
  deliveryRequestedInformationKind,
  waitRequestedInformationKind,
} from "./information-kinds.js";

describe("persistent first-party information payloads", () => {
  it("requires explicit turn provenance on assistant and delivery facts", () => {
    expect(
      assistantTextInformationKind.payloadSchema.safeParse({
        text: "hello",
        source: source(),
        originatingModuleInstanceId: "reply.default",
      }).success,
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
