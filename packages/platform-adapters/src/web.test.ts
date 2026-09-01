import { describe, expect, it } from "vitest";

import { normalizeWebInboundMessage } from "./web.js";

describe("normalizeWebInboundMessage", () => {
  it("maps a browser request to a first-class web platform message", () => {
    const input = { text: "hello from web", requestId: "request-1" };
    const message = normalizeWebInboundMessage(input, {
      adapterId: "web.ui.main",
      now: () => new Date("2026-09-01T01:02:03.000Z"),
    });

    expect(message).toEqual({
      platform: "web",
      adapterId: "web.ui.main",
      traceId: "web:request-1",
      platformMessageId: "request-1",
      occurredAt: "2026-09-01T01:02:03.000Z",
      text: "hello from web",
      mentions: [],
      target: { kind: "web" },
      sender: { userId: "web" },
      raw: input,
    });
  });

  it("trims surrounding whitespace from text and request ID", () => {
    const message = normalizeWebInboundMessage(
      { text: "  hello  ", requestId: " request-2 " },
      { adapterId: "web.ui.main" },
    );

    expect(message?.text).toBe("hello");
    expect(message?.platformMessageId).toBe("request-2");
    expect(message?.traceId).toBe("web:request-2");
  });

  it("rejects blank text, blank request IDs, and extra fields", () => {
    const options = { adapterId: "web.ui.main" };

    expect(
      normalizeWebInboundMessage({ text: "   ", requestId: "request-3" }, options),
    ).toBeUndefined();
    expect(
      normalizeWebInboundMessage({ text: "hello", requestId: "   " }, options),
    ).toBeUndefined();
    expect(
      normalizeWebInboundMessage({ text: "hello" }, options),
    ).toBeUndefined();
    expect(
      normalizeWebInboundMessage(
        { text: "hello", requestId: "request-4", sessionId: "legacy" },
        options,
      ),
    ).toBeUndefined();
  });
});
