import { describe, it, expect } from "vitest";
import {
  createNativeMemoryAccess,
  type NativeMemoryStore,
} from "@kaguya/memory";
import { sourceParticipants } from "./collection.js";

// Only the binding lookup is exercised. Other ports fail loudly if touched.
const unused = async (): Promise<never> => {
  throw new Error("unexpected storage call");
};
const store: NativeMemoryStore = {
  publish: unused,
  readFixed: unused,
  candidates: unused,
  expand: unused,
  current: unused,
  forFormation: unused,
  history: unused,
  published: unused,
  people: async () => [{ accountId: "b", ownerId: "person:second" }],
};
describe("person evidence collection", () => {
  it("keeps nicknames, cards, mention and reply roles separate from account bindings", async () => {
    const source = {
      platform: "qq",
      adapterId: "qq",
      senderId: "a",
      sender: { nickname: "同名", card: "群称呼" },
      mentions: [
        { kind: "user" as const, id: "b" },
        { kind: "user" as const, id: "unknown" },
      ],
      replyTo: { senderId: "b" },
    };
    const participants = await sourceParticipants(
      source,
      "person:first",
      createNativeMemoryAccess({ enabled: true, store }),
    );
    expect(participants).toEqual([
      {
        accountId: "a",
        ownerId: "person:first",
        role: "speaker",
        nickname: "同名",
        card: "群称呼",
      },
      {
        accountId: "b",
        ownerId: "person:second",
        role: "mentioned",
        nickname: null,
        card: null,
      },
      {
        accountId: "unknown",
        ownerId: null,
        role: "mentioned",
        nickname: null,
        card: null,
      },
      {
        accountId: "b",
        ownerId: "person:second",
        role: "replied-to",
        nickname: null,
        card: null,
      },
    ]);
  });
  it("does not choose an identity when explicit bindings conflict", async () => {
    const memory = createNativeMemoryAccess({
      enabled: true,
      store: {
        ...store,
        people: async () => [
          { accountId: "b", ownerId: "person:one" },
          { accountId: "b", ownerId: "person:two" },
        ],
      },
    });
    const participants = await sourceParticipants(
      {
        platform: "qq",
        adapterId: "qq",
        senderId: "a",
        mentions: [{ kind: "user", id: "b" }],
      },
      "person:a",
      memory,
    );
    expect(participants[1]!.ownerId).toBeNull();
  });
});
