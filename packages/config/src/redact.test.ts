import { describe, expect, it } from "vitest";

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

    redacted.values[0]!.enabled = false;
    expect(source.apiKey).toBe("ai-secret");
    expect(source.values[0]?.enabled).toBe(true);
  });
});
