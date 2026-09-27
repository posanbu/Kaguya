import { describe, expect, it } from "vitest";
import { memoryConfigSchema } from "./model.js";

describe("Memory configuration", () => {
  it("accepts only the raw Memory switch", () => {
    expect(memoryConfigSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(memoryConfigSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    for (const field of ["embedding", "cognition", "knowledgeEnabled"]) {
      expect(
        memoryConfigSchema.safeParse({ enabled: true, [field]: {} }).success,
      ).toBe(false);
    }
  });
});
