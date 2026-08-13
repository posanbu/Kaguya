import { describe, expect, it } from "vitest";

import {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
} from "./napcat.js";

class FakeTransport implements JsonMessageTransport {
  readonly sent: unknown[] = [];
  private messageHandler: ((message: unknown) => void) | undefined;
  private readonly closeHandlers = new Set<(error?: Error) => void>();

  sendJson(message: unknown): void {
    this.sent.push(message);
  }

  onJsonMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.disconnect();
  }

  receive(message: unknown): void {
    this.messageHandler?.(message);
  }

  disconnect(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

describe("NapCatActionClient", () => {
  it("sends a private action and resolves the matching echo response", async () => {
    const transport = new FakeTransport();
    const client = new NapCatActionClient({
      adapterId: "napcat.qq.main",
      transport,
      nextEcho: () => "echo-1",
      timeoutMs: 1000,
    });

    const promise = client.sendTextReply(
      { kind: "private", userId: "112233" },
      "hi",
    );

    expect(transport.sent).toEqual([
      {
        action: "send_private_msg",
        params: {
          user_id: 112233,
          message: [{ type: "text", data: { text: "hi" } }],
        },
        echo: "echo-1",
      },
    ]);

    transport.receive({
      status: "ok",
      retcode: 0,
      data: { message_id: 24680 },
      echo: "echo-1",
    });

    await expect(promise).resolves.toMatchObject({
      ok: true,
      adapterId: "napcat.qq.main",
      platform: "qq",
      target: { kind: "private", userId: "112233" },
      platformMessageId: "24680",
    });
  });

  it("returns failed receipts for matching failed action responses", async () => {
    const transport = new FakeTransport();
    const client = new NapCatActionClient({
      adapterId: "napcat.qq.main",
      transport,
      nextEcho: () => "echo-2",
      timeoutMs: 1000,
    });

    const promise = client.sendTextReply(
      { kind: "group", groupId: "778899" },
      "nope",
    );
    transport.receive({
      status: "failed",
      retcode: 1404,
      wording: "group not found",
      echo: "echo-2",
    });

    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: "group not found",
      target: { kind: "group", groupId: "778899" },
    });
  });
});

it("dispatches normalized inbound messages and ignores action responses", async () => {
  const transport = new FakeTransport();
  const inboundMessages: unknown[] = [];
  const onInboundMessage = async (message: unknown) => {
    inboundMessages.push(message);
  };
  const adapter = new NapCatOneBotAdapter({
    adapterId: "napcat.qq.main",
    transport,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    onInboundMessage,
  });

  await adapter.start();
  transport.receive({ status: "ok", echo: "echo-ignored" });
  transport.receive({
    post_type: "message",
    message_type: "private",
    message_id: 123,
    user_id: 456,
    message: "hello",
  });

  await Promise.resolve();

  expect(inboundMessages).toHaveLength(1);
  expect(inboundMessages[0]).toMatchObject({
    text: "hello",
  });
});

it("supports an action client and adapter sharing one transport", async () => {
  const transport = new FakeTransport();
  const inboundMessages: unknown[] = [];
  const client = new NapCatActionClient({
    adapterId: "napcat.qq.main",
    transport,
    nextEcho: () => "echo-shared",
    timeoutMs: 1000,
  });
  const adapter = new NapCatOneBotAdapter({
    adapterId: "napcat.qq.main",
    transport,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    onInboundMessage: async (message) => {
      inboundMessages.push(message);
    },
  });

  await adapter.start();
  const receiptPromise = client.sendTextReply(
    { kind: "private", userId: "112233" },
    "hi",
  );
  transport.receive({
    post_type: "message",
    message_type: "private",
    message_id: 123,
    user_id: 456,
    message: "hello",
  });
  transport.receive({
    status: "ok",
    data: { message_id: 24680 },
    echo: "echo-shared",
  });

  await expect(receiptPromise).resolves.toMatchObject({
    ok: true,
    platformMessageId: "24680",
  });
  await Promise.resolve();
  expect(inboundMessages).toHaveLength(1);
  expect(inboundMessages[0]).toMatchObject({
    text: "hello",
  });
  await adapter.stop();
});

it("returns a failed receipt when a NapCat action times out", async () => {
  const transport = new FakeTransport();
  const client = new NapCatActionClient({
    adapterId: "napcat.qq.main",
    transport,
    nextEcho: () => "echo-timeout",
    timeoutMs: 10,
  });

  await expect(
    client.sendTextReply({ kind: "group", groupId: "778899" }, "later"),
  ).resolves.toMatchObject({
    ok: false,
    adapterId: "napcat.qq.main",
    target: { kind: "group", groupId: "778899" },
    error: "NapCat action timed out",
  });
});

it("returns failed receipts when the NapCat transport closes", async () => {
  const transport = new FakeTransport();
  const client = new NapCatActionClient({
    adapterId: "napcat.qq.main",
    transport,
    nextEcho: () => "echo-close",
    timeoutMs: 1000,
  });

  const receiptPromise = client.sendTextReply(
    { kind: "private", userId: "112233" },
    "during-close",
  );
  transport.close();

  await expect(receiptPromise).resolves.toMatchObject({
    ok: false,
    target: { kind: "private", userId: "112233" },
    error: "NapCat connection closed",
  });
});

it("surfaces rejected inbound dispatches with trace context", async () => {
  const transport = new FakeTransport();
  const dispatchError = new Error("workflow failed");
  const failures: Array<{
    error: unknown;
    context: { adapterId: string; traceId: string };
  }> = [];
  const adapter = new NapCatOneBotAdapter({
    adapterId: "napcat.qq.main",
    transport,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    onInboundMessage: async () => {
      throw dispatchError;
    },
    onInboundError: (error, context) => {
      failures.push({ error, context });
    },
  });

  await adapter.start();
  transport.receive({
    post_type: "message",
    message_type: "private",
    self_id: 998877,
    message_id: 12345,
    user_id: 112233,
    message: "message body must not enter error context",
  });
  await adapter.stop();

  expect(failures).toEqual([
    {
      error: dispatchError,
      context: {
        adapterId: "napcat.qq.main",
        traceId: "napcat:998877:12345",
      },
    },
  ]);
});

it("stops accepting frames and drains in-flight dispatches before stopping", async () => {
  const transport = new FakeTransport();
  let finishDispatch: (() => void) | undefined;
  const dispatchGate = new Promise<void>((resolve) => {
    finishDispatch = resolve;
  });
  const dispatchedIds: string[] = [];
  const adapter = new NapCatOneBotAdapter({
    adapterId: "napcat.qq.main",
    transport,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    onInboundMessage: async (message) => {
      dispatchedIds.push(message.platformMessageId);
      await dispatchGate;
    },
  });

  await adapter.start();
  transport.receive({
    post_type: "message",
    message_type: "private",
    message_id: 1,
    user_id: 112233,
    message: "first",
  });

  let stopped = false;
  const stopPromise = adapter.stop().then(() => {
    stopped = true;
  });
  transport.receive({
    post_type: "message",
    message_type: "private",
    message_id: 2,
    user_id: 112233,
    message: "second",
  });
  await Promise.resolve();

  expect(dispatchedIds).toEqual(["1"]);
  expect(stopped).toBe(false);

  finishDispatch?.();
  await stopPromise;
  expect(stopped).toBe(true);
});

it("ignores inbound events for a different configured bot account", async () => {
  const transport = new FakeTransport();
  const dispatchedIds: string[] = [];
  const adapter = new NapCatOneBotAdapter({
    adapterId: "napcat.qq.main",
    expectedSelfId: "998877",
    transport,
    now: () => new Date("2026-07-28T01:02:03.000Z"),
    onInboundMessage: async (message) => {
      dispatchedIds.push(message.platformMessageId);
    },
  });

  await adapter.start();
  for (const [selfId, messageId] of [
    [998876, 1],
    [undefined, 2],
    [998877, 3],
  ] as const) {
    transport.receive({
      post_type: "message",
      message_type: "private",
      ...(selfId === undefined ? {} : { self_id: selfId }),
      message_id: messageId,
      user_id: 112233,
      message: "hello",
    });
  }
  await adapter.stop();

  expect(dispatchedIds).toEqual(["3"]);
});
