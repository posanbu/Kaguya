import { freezeInformationAtom, informationIdSchema, z } from "@kaguya/schema";
import { describe, expect, it, vi } from "vitest";

import { alwaysReplyInformationFilterModule } from "./always-reply-information-filter.js";
import {
  filterDecisionInformationKind,
  inboundTextInformationKind,
} from "./information-kinds.js";

describe("always reply information filter", () => {
  it("declares the input and decision kinds and appends a decision", async () => {
    const definition = alwaysReplyInformationFilterModule;
    const settings = definition.manifest.settingsSchema.parse({
      replyTargetInstanceId: "reply-1",
    });
    const instance = await definition.create({
      instanceId: "filter-1",
      settings,
    });
    const atom = freezeInformationAtom({
      informationId: informationIdSchema.parse("inbound-1"),
      kind: inboundTextInformationKind.kind,
      occurredAt: "2026-09-03T00:00:00.000Z",
      source: "adapter:test",
      payload: {
        text: "hello",
        source: {
          adapterId: "adapter",
          platform: "web",
          platformMessageId: "request-1",
          destination: { kind: "web" },
          senderId: "web",
        },
      },
      references: [
        { relation: "core:context", informationId: informationIdSchema.parse("context-1") },
      ],
    });
    const append = vi.fn();
    const subscription = instance.subscriptions[0];
    expect(subscription?.kind).toBe(inboundTextInformationKind.kind);
    await subscription?.handle(atom, {
      definitionId: definition.manifest.definitionId,
      instanceId: "filter-1",
      sourceAtom: atom,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      append,
    });

    expect(append).toHaveBeenCalledWith(filterDecisionInformationKind, {
      payload: {
        shouldReply: true,
        reason: "always-reply",
        targetInstanceId: "reply-1",
      },
    });
  });
});
