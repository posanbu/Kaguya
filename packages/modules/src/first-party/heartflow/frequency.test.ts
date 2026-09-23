import { expect, it } from "vitest";
import { heartflowSettingsSchema } from "./index.js";

it("rejects removed Arousal-era frequency projections", () => {
  const current = {
    muted: false,
    focusIdleMs: 120_000,
    staleAfterMs: 120_000,
    plannerInterruptMaxConsecutiveCount: 2,
  };
  expect(heartflowSettingsSchema.parse(current)).toEqual(current);
  expect(() =>
    heartflowSettingsSchema.parse({ ...current, groupFrequency: 1 }),
  ).toThrow();
  expect(() =>
    heartflowSettingsSchema.parse({ ...current, botNames: ["Kaguya"] }),
  ).toThrow();
});
