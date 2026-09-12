/**
 * 功能概述：验证 Profile Memory provider 的严格端点、版本身份与凭据脱敏边界。
 * 测试保留默认关闭语义，拒绝混合 URL 凭据和未知字段；不发起任何网络连接或读取用户配置。
 */
import { describe, expect, it } from "vitest";
import { memoryConfigSchema } from "./model.js";
import { redactConfigValue } from "./redact.js";
const embedding = {
  providerId: "test",
  modelId: "embedding",
  revision: "v1",
  dimensions: 2,
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: "test-only-placeholder",
};
describe("Memory Profile configuration", () => {
  it("preserves sparse-only profiles and validates opt-in providers", () => {
    expect(memoryConfigSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(memoryConfigSchema.parse({ enabled: true, embedding })).toEqual({
      enabled: true,
      embedding,
    });
    expect(
      memoryConfigSchema.safeParse({
        enabled: true,
        embedding: { ...embedding, dimensions: 0 },
      }).success,
    ).toBe(false);
    expect(
      memoryConfigSchema.safeParse({
        enabled: true,
        cognition: { provider: "unknown" },
      }).success,
    ).toBe(false);
  });
  it.each([
    "https://user:password@example.com",
    "https://example.com?key=secret",
    "file:///tmp/provider",
  ])("rejects unsafe endpoint shape %s", (baseUrl) =>
    expect(
      memoryConfigSchema.safeParse({
        enabled: true,
        embedding: { ...embedding, baseUrl },
      }).success,
    ).toBe(false),
  );
  it("redacts nested Memory credentials", () => {
    expect(
      JSON.stringify(
        redactConfigValue({ memory: { enabled: true, embedding } }),
      ),
    ).not.toContain("test-only-placeholder");
  });
});
