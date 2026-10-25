import { describe, expect, it } from "vitest";
import {
  lightActionSchema as sharedAction,
  lightTargetSchema as sharedTarget,
  memoryNodeInputSchema as sharedNode,
} from "@kaguya/agent-contracts";
import { memoryNodeInputSchema } from "@kaguya/schema";
import { lightActionSchema } from "./light.js";
import { lightTargetSchema } from "../message-authorization.js";

describe("extracted runtime contract identity", () => {
  it("preserves existing import paths without a second validator", () => {
    expect(lightActionSchema).toBe(sharedAction);
    expect(lightTargetSchema).toBe(sharedTarget);
    expect(memoryNodeInputSchema).toBe(sharedNode);
  });
  it("keeps current Light validation and rejects malformed actions", () => {
    expect(
      sharedAction.parse({
        action: "message",
        reason: "respond",
        target: { kind: "current" },
      }).action,
    ).toBe("message");
    expect(
      sharedAction.safeParse({
        action: "wait",
        reason: "await-more-context",
        waitSeconds: 0,
      }).success,
    ).toBe(false);
  });
});
