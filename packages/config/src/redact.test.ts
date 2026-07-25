import { describe, expect, expectTypeOf, it } from "vitest";

import type { JsonValue } from "./model.js";
import { REDACTED_CONFIG_VALUE, redactConfigValue } from "./redact.js";

describe("redactConfigValue", () => {
  it("recursively removes common secret fields", () => {
    const source = {
      apiKey: "ai-secret",
      nested: {
        access_token: "access-secret",
        harmless: "visible",
      },
      platforms: [
        {
          credentials: {
            password: "platform-secret",
          },
        },
      ],
    };

    expect(redactConfigValue(source)).toEqual({
      apiKey: REDACTED_CONFIG_VALUE,
      nested: {
        access_token: REDACTED_CONFIG_VALUE,
        harmless: "visible",
      },
      platforms: [{ credentials: REDACTED_CONFIG_VALUE }],
    });
  });

  it("returns a detached value without mutating its input", () => {
    const source = {
      apiKey: "ai-secret",
      values: [{ enabled: true }],
    };
    const redacted = redactConfigValue(source);

    if (
      redacted === null ||
      Array.isArray(redacted) ||
      typeof redacted !== "object" ||
      !Array.isArray(redacted.values)
    ) {
      throw new Error("Expected redacted object values");
    }
    const firstValue = redacted.values[0];
    if (
      firstValue === null ||
      Array.isArray(firstValue) ||
      typeof firstValue !== "object"
    ) {
      throw new Error("Expected a redacted object entry");
    }
    firstValue.enabled = false;
    expect(source.apiKey).toBe("ai-secret");
    expect(source.values[0]?.enabled).toBe(true);
  });

  it("returns the safe JSON value type instead of claiming the input type", () => {
    const redacted = redactConfigValue({
      credentials: { password: "secret" },
    });

    expectTypeOf(redacted).toEqualTypeOf<JsonValue>();
    expect(redacted).toEqual({ credentials: REDACTED_CONFIG_VALUE });
  });
});
