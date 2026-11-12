/**
 * 功能概述：验证三档视觉配置的缺省兼容、模型级能力、目标存在性和下载主机白名单。
 * 同时走 Profile schema 与 readiness；无外部模型、网络请求或真实凭据。
 */
import { expect, it } from "vitest";
import { aiConfigSchema, userConfigProfileSchema } from "./model.js";
import { inspectUserConfigProfile } from "./readiness.js";
const target = { providerId: "p", modelId: "vision", imageInput: true };
const ai = {
  providers: [
    {
      id: "p",
      type: "openai-compatible",
      enabled: true,
      baseUrl: "https://example.test/v1",
      apiKey: "synthetic",
      models: ["vision"],
      settings: {},
    },
  ],
  modelTiers: { light: target, heavy: target },
};
it("keeps old profiles unchanged and requires image capability for active modes", () => {
  expect(aiConfigSchema.parse(ai)).toEqual(ai);
  expect(
    aiConfigSchema.safeParse({
      ...ai,
      vision: { mode: "native" },
      modelTiers: {
        light: target,
        heavy: { providerId: "p", modelId: "vision" },
      },
    }).success,
  ).toBe(false);
  expect(
    aiConfigSchema.safeParse({ ...ai, vision: { mode: "external" } }).success,
  ).toBe(false);
  expect(
    aiConfigSchema.safeParse({
      ...ai,
      vision: { mode: "external" },
      modelTiers: { ...ai.modelTiers, vision: target },
    }).success,
  ).toBe(true);
  expect(
    aiConfigSchema.safeParse({
      ...ai,
      vision: { mode: "off", allowedHosts: ["*.example.com"] },
    }).success,
  ).toBe(false);
  expect(
    aiConfigSchema.safeParse({
      ...ai,
      vision: { mode: "off", allowedHosts: ["127.0.0.1"] },
    }).success,
  ).toBe(false);
});
it("checks external provider/model readiness rather than accepting an undeclared target", () => {
  const profile = userConfigProfileSchema.parse({
    id: "default",
    name: "default",
    identity: { timeZone: "Asia/Shanghai" },
    ai: {
      ...ai,
      vision: { mode: "external" },
      modelTiers: {
        ...ai.modelTiers,
        vision: { ...target, modelId: "missing" },
      },
    },
  });
  const state = inspectUserConfigProfile(profile);
  expect(state.status).toBe("invalid");
  if (state.status === "invalid")
    expect(
      state.issues.some((i) => i.id === "model-tier-model-invalid:vision"),
    ).toBe(true);
});
