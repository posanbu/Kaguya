import { describe, expect, it } from "vitest";
import { decideTtsOutput, ttsOutputSettingsSchema } from "./output-policy.js";

const context = {
  authorized: true,
  platform: "qq",
  audioSupported: true,
  crossConversation: false,
  text: "  你好，今天过得怎么样？\n",
};
const enabled = { mode: "voice-fallback-text" as const };

describe("TTS output eligibility", () => {
  it("defaults to text and keeps the authorized text exactly", () => {
    expect(decideTtsOutput({}, context)).toEqual({
      kind: "text",
      reason: "disabled",
    });
    expect(decideTtsOutput(enabled, context)).toEqual({
      kind: "voice",
      text: context.text,
    });
    expect(ttsOutputSettingsSchema.safeParse({ mode: "both" }).success).toBe(
      false,
    );
  });
  it("blocks unauthorized text as well as voice", () => {
    for (const settings of [{}, enabled]) {
      expect(
        decideTtsOutput(settings, { ...context, authorized: false }),
      ).toEqual({
        kind: "blocked",
        reason: "unauthorized",
      });
    }
  });
  it.each([
    [{ platform: "web" }, "unsupported_platform"],
    [{ audioSupported: false }, "unsupported_platform"],
    [{ crossConversation: true }, "cross_conversation"],
    [{ text: "   " }, "invalid_text"],
    [{ text: "字".repeat(301) }, "too_long"],
    [{ text: "```ts\nconst a = 1;\n```" }, "structured_text"],
    [{ text: "| 名称 | 数量 |\n| --- | --- |" }, "structured_text"],
    [{ text: "访问 https://example.com" }, "structured_text"],
  ] as const)("falls back without rewriting: %j", (change, reason) => {
    expect(decideTtsOutput(enabled, { ...context, ...change })).toEqual({
      kind: "text",
      reason,
    });
  });
});
