import { describe, expect, it } from "vitest";

import { formatZonedInstant } from "./temporal-context.js";

describe("formatZonedInstant", () => {
  it("formats a fixed instant in Shanghai and crosses the local date", () => {
    expect(
      formatZonedInstant(
        "2026-09-15T16:30:00.000Z",
        "Asia/Shanghai",
      ),
    ).toEqual({
      iso: "2026-09-15T16:30:00.000Z",
      timeZone: "Asia/Shanghai",
      local: "2026-09-16 周三 00:30:00",
    });
  });
});
