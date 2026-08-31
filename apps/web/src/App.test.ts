import { describe, expect, it } from "vitest";

import { mergeSessionMessages } from "./App.js";
import type { SessionMessageView } from "./api.js";

function user(
  id: string,
  state: "sending" | "awaiting" | "settled" | "failed",
  requestId?: string,
) {
  return {
    id,
    role: "user" as const,
    text: `text-${id}`,
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    state,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function assistant(id: string, requestId?: string) {
  return {
    id,
    role: "assistant" as const,
    text: `reply-${id}`,
    createdAt: new Date("2026-08-30T00:00:01.000Z"),
    state: "settled" as const,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function view(
  id: string,
  role: "user" | "assistant",
  occurredAt: string,
  requestId?: string,
): SessionMessageView {
  return {
    id,
    role,
    content: `content-${id}`,
    occurredAt,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

describe("mergeSessionMessages", () => {
  it("replaces the pending bubble with its server copy and settles on reply", () => {
    const { messages, settledRequestIds } = mergeSessionMessages({
      local: [user("local-1", "awaiting", "req-1")],
      server: [
        view("srv-1", "user", "2026-08-30T00:00:00.000Z", "req-1"),
        view("srv-2", "assistant", "2026-08-30T00:00:01.000Z", "req-1"),
      ],
      awaiting: new Set(["req-1"]),
    });

    expect(messages).toEqual([
      {
        id: "srv-1",
        role: "user",
        text: "text-local-1",
        createdAt: new Date("2026-08-30T00:00:00.000Z"),
        state: "awaiting",
        requestId: "req-1",
      },
      {
        id: "srv-2",
        role: "assistant",
        text: "content-srv-2",
        createdAt: new Date("2026-08-30T00:00:01.000Z"),
        state: "settled",
        requestId: "req-1",
      },
    ]);
    expect(settledRequestIds).toEqual(["req-1"]);
  });

  it("waits for the reply before settling", () => {
    const { settledRequestIds } = mergeSessionMessages({
      local: [user("local-1", "awaiting", "req-1")],
      server: [view("srv-1", "user", "2026-08-30T00:00:00.000Z", "req-1")],
      awaiting: new Set(["req-1"]),
    });

    expect(settledRequestIds).toEqual([]);
  });

  it("keeps in-flight bubbles after the persisted history", () => {
    const { messages } = mergeSessionMessages({
      local: [user("local-2", "awaiting", "req-2"), user("local-1", "sending")],
      server: [view("srv-1", "user", "2026-08-30T00:00:00.000Z", "req-2")],
      awaiting: new Set(["req-2"]),
    });

    expect(messages.map((message) => message.id)).toEqual(["srv-1", "local-1"]);
  });

  it("restores history without duplicating known rows", () => {
    const { messages } = mergeSessionMessages({
      local: [user("srv-1", "settled", "req-1"), assistant("srv-2", "req-1")],
      server: [
        view("srv-1", "user", "2026-08-30T00:00:00.000Z", "req-1"),
        view("srv-2", "assistant", "2026-08-30T00:00:01.000Z", "req-1"),
      ],
      awaiting: new Set(),
    });

    expect(messages.map((message) => message.id)).toEqual(["srv-1", "srv-2"]);
  });

  it("keeps a failed bubble when its row arrives from the server", () => {
    const failed = {
      ...user("local-1", "failed", "req-1"),
      error: "等待回复超时",
    };
    const { messages } = mergeSessionMessages({
      local: [failed],
      server: [view("srv-1", "user", "2026-08-30T00:00:00.000Z", "req-1")],
      awaiting: new Set(),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "srv-1",
      state: "failed",
      error: "等待回复超时",
    });
  });

  it("settles only the request whose reply arrived", () => {
    const { messages, settledRequestIds } = mergeSessionMessages({
      local: [
        user("local-1", "awaiting", "req-1"),
        user("local-2", "awaiting", "req-2"),
      ],
      server: [
        view("srv-1", "user", "2026-08-30T00:00:00.000Z", "req-1"),
        view("srv-2", "user", "2026-08-30T00:00:01.000Z", "req-2"),
        view("srv-3", "assistant", "2026-08-30T00:00:02.000Z", "req-1"),
      ],
      awaiting: new Set(["req-1", "req-2"]),
    });

    expect(messages.map((message) => message.id)).toEqual([
      "srv-1",
      "srv-2",
      "srv-3",
    ]);
    expect(settledRequestIds).toEqual(["req-1"]);
  });
});
