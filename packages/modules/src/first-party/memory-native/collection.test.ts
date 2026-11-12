/**
 * 功能概述：验证 Memory 按精确绑定收集来源参与者，并拒绝失效、冲突或未完成身份的发言者归属。
 * 主要职责：使用内存存储替身验证 currentSpeakerOwner 和 sourceParticipants；昵称与名片只作为观察。
 * 代码库关系：覆盖 collection.ts 和 NativeMemoryAccess，数据库持久化失效语义由 database 专项测试覆盖。
 * 输入输出与副作用：仅合成输入和内存结果，无网络、轮询或真实模型调用。
 */
import { describe, it, expect } from "vitest";
import {
  createNativeMemoryAccess,
  type NativeMemoryStore,
} from "@kaguya/memory";
import { currentSpeakerOwner, sourceParticipants } from "./collection.js";

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

describe("current speaker binding", () => {
  const source = { platform: "qq", adapterId: "qq.main", senderId: "a" };
  const identity = {
    status: "complete",
    scopeMode: "canonical",
    personInformationId: "old",
  };
  const access = (bindings: { accountId: string; ownerId: string }[]) =>
    createNativeMemoryAccess({
      enabled: true,
      store: { ...store, people: async () => bindings },
    });
  it("retains an exact active binding", async () => {
    expect(
      await currentSpeakerOwner(
        source,
        identity,
        access([{ accountId: "a", ownerId: "person:old" }]),
      ),
    ).toBe("person:old");
  });
  it.each([
    { bindings: [] },
    { bindings: [{ accountId: "a", ownerId: "person:new" }] },
    {
      bindings: [
        { accountId: "a", ownerId: "person:old" },
        { accountId: "a", ownerId: "person:new" },
      ],
    },
    { bindings: [{ accountId: "b", ownerId: "person:old" }] },
  ])(
    "does not restore stale, replaced, conflicting or foreign bindings: %j",
    async ({ bindings }) => {
      expect(
        await currentSpeakerOwner(source, identity, access(bindings)),
      ).toBeNull();
    },
  );
  it.each([
    { ...identity, status: "unresolved" },
    { ...identity, status: "ambiguous" },
    { ...identity, scopeMode: "ephemeral" },
  ])("does not attribute incomplete identity %j", async (candidate) => {
    expect(
      await currentSpeakerOwner(
        source,
        candidate,
        access([{ accountId: "a", ownerId: "person:old" }]),
      ),
    ).toBeNull();
  });
});
