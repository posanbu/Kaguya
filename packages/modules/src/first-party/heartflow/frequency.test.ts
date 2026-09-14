import { describe, expect, it } from "vitest";
import { heartflowSettingsSchema, resolveEffectiveFrequency } from "./index.js";

const base = {
  botNames: ["Kaguya"],
  groupFrequency: 0.6,
  privateFrequency: 1,
  muted: false,
  staleAfterMs: 120_000,
};
const source = {
  platform: "qq",
  destination: { kind: "group", groupId: "room" },
};
const at = (hour: number, minute: number) =>
  new Date(2026, 8, 14, hour, minute).toISOString();

describe("effective reply frequency", () => {
  it("keeps the base value while dynamic rules are disabled", () => {
    const settings = heartflowSettingsSchema.parse(base);
    expect(
      resolveEffectiveFrequency(settings, source, at(23, 30), false),
    ).toEqual({ frequency: 0.6, ruleIndex: null });
  });

  it("prefers the concrete chat rule and supports midnight-spanning ranges", () => {
    const settings = heartflowSettingsSchema.parse({
      ...base,
      dynamicFrequencyEnabled: true,
      dynamicFrequencyRules: [
        { platform: "", itemId: "", chatType: "group", time: "*", value: 0.3 },
        {
          platform: "qq",
          itemId: "room",
          chatType: "group",
          time: "22:00-02:00",
          value: 0.8,
        },
      ],
    });
    expect(
      resolveEffectiveFrequency(settings, source, at(23, 30), false),
    ).toEqual({ frequency: 0.8, ruleIndex: 1 });
    expect(
      resolveEffectiveFrequency(settings, source, at(1, 30), false),
    ).toEqual({ frequency: 0.8, ruleIndex: 1 });
    expect(
      resolveEffectiveFrequency(settings, source, at(12, 0), false),
    ).toEqual({ frequency: 0.3, ruleIndex: 0 });
  });

  it("applies the numeric Focus multiplier after rule matching and caps at one", () => {
    const settings = heartflowSettingsSchema.parse({
      ...base,
      focusFrequencyMultiplier: 2,
    });
    expect(
      resolveEffectiveFrequency(settings, source, at(12, 0), true).frequency,
    ).toBe(1);
    expect(
      resolveEffectiveFrequency(settings, source, at(12, 0), false).frequency,
    ).toBe(0.6);
  });

  it("lets a concrete chat override a platform-wide rule", () => {
    const settings = heartflowSettingsSchema.parse({
      ...base,
      dynamicFrequencyEnabled: true,
      dynamicFrequencyRules: [
        { platform: "qq", itemId: "", chatType: "group", time: "", value: 0.2 },
        {
          platform: "",
          itemId: "room",
          chatType: "group",
          time: "",
          value: 0.7,
        },
      ],
    });
    expect(
      resolveEffectiveFrequency(settings, source, at(12, 0), false),
    ).toEqual({
      frequency: 0.7,
      ruleIndex: 1,
    });
  });
});
