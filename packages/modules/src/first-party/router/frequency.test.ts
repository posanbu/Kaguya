import { expect, it } from "vitest";
import { routerSettingsSchema } from "./index.js";

it("rejects removed Arousal-era frequency projections", () => {
  const current = {
    muted: false,
    focusIdleMs: 120_000,
    staleAfterMs: 120_000,
    lightInterruptMaxConsecutiveCount: 2,
  };
  expect(routerSettingsSchema.parse(current)).toEqual(current);
  expect(() =>
    routerSettingsSchema.parse({ ...current, groupFrequency: 1 }),
  ).toThrow();
  expect(() =>
    routerSettingsSchema.parse({ ...current, botNames: ["Kaguya"] }),
  ).toThrow();
});
