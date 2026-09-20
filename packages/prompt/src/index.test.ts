import { describe, expect, it } from "vitest";
import { selectPlatformPromptResource } from "./index.js";

describe("platform Prompt selection", () => {
  const resources = {
    default: "generic",
    qq: "qq-only",
    web: "web-only",
  } as const;
  it.each([
    ["qq", "qq-only"],
    ["web", "web-only"],
    ["unknown", "generic"],
  ])("selects %s exactly", (platform, expected) => {
    expect(selectPlatformPromptResource(resources, platform)).toBe(expected);
  });
});
