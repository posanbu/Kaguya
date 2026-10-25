import { describe, expect, it, vi } from "vitest";
import { freezeBackgroundPeople } from "./background-people.js";

const source = (senderId: string, adapterId = "qq") => ({
  platform: "qq",
  adapterId,
  senderId,
  platformMessageId: senderId,
  destination: { kind: "group", groupId: "group" },
  sender: { userId: senderId, nickname: "同名" },
});
describe("frozen background people", () => {
  it("includes historical speakers, mentions and replies, with adapter-specific bindings", async () => {
    const people = vi.fn(
      async ({
        adapterId,
        accountIds,
      }: {
        adapterId: string;
        accountIds: readonly string[];
      }) =>
        accountIds.map((accountId) => ({
          accountId,
          ownerId: `person:${adapterId}:${accountId}`,
        })),
    );
    const result = await freezeBackgroundPeople(
      [
        {
          informationId: "history",
          source: {
            ...source("old"),
            mentions: [{ kind: "user", id: "mentioned" }],
            replyTo: { platformMessageId: "reply", senderId: "replied" },
          },
        },
        { informationId: "other-adapter", source: source("old", "other") },
        { informationId: "current", source: source("current") },
        { informationId: "history", source: source("old") },
      ],
      { people },
    );
    expect(result.map((p) => p.ownerId)).toEqual([
      "person:qq:old",
      "person:qq:mentioned",
      "person:qq:replied",
      "person:other:old",
      "person:qq:current",
    ]);
    expect(result[0]!.sourceIds).toEqual(["history"]);
    expect(people).toHaveBeenCalledTimes(2);
  });
  it("keeps missing or ambiguous bindings unresolved and propagates read failures", async () => {
    const observations = [{ informationId: "old", source: source("old") }];
    expect(
      (
        await freezeBackgroundPeople(observations, { people: async () => [] })
      )[0]!.ownerId,
    ).toBeNull();
    expect(
      (
        await freezeBackgroundPeople(observations, {
          people: async () => [
            { accountId: "old", ownerId: "person:a" },
            { accountId: "old", ownerId: "person:b" },
          ],
        })
      )[0]!.ownerId,
    ).toBeNull();
    await expect(
      freezeBackgroundPeople(observations, {
        people: async () => {
          throw new Error("read failed");
        },
      }),
    ).rejects.toThrow("read failed");
  });
});
