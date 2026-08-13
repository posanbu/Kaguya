import { describe, expect, it } from "vitest";

import {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
} from "./onebot.js";

describe("normalizeOneBotMessageEvent", () => {
  it("maps private text messages to stable Kaguya session and trace IDs", () => {
    const message = normalizeOneBotMessageEvent(
      {
        post_type: "message",
        message_type: "private",
        self_id: 998877,
        message_id: 12345,
        user_id: 112233,
        time: 1785200523,
        sender: { user_id: 112233, nickname: "Ada" },
        message: [{ type: "text", data: { text: "hello kaguya" } }],
      },
      {
        adapterId: "napcat.qq.main",
        now: () => new Date("2026-07-28T01:02:03.000Z"),
      },
    );

    expect(message).toMatchObject({
      platform: "qq",
      adapterId: "napcat.qq.main",
      selfId: "998877",
      sessionId: "qq:private:112233",
      traceId: "napcat:998877:12345",
      platformMessageId: "12345",
      occurredAt: "2026-07-28T01:02:03.000Z",
      text: "hello kaguya",
      mentions: [],
      target: { kind: "private", userId: "112233" },
      sender: { userId: "112233", nickname: "Ada" },
    });
  });
});

describe("buildOneBotSendAction", () => {
  it("builds private send actions with text segments", () => {
    expect(
      buildOneBotSendAction(
        { kind: "private", userId: "112233" },
        "hi back",
        "echo-1",
      ),
    ).toEqual({
      action: "send_private_msg",
      params: {
        user_id: 112233,
        message: [{ type: "text", data: { text: "hi back" } }],
      },
      echo: "echo-1",
    });
  });

  it("builds group send actions with text segments", () => {
    expect(
      buildOneBotSendAction(
        { kind: "group", groupId: "778899" },
        "group reply",
        "echo-2",
      ),
    ).toEqual({
      action: "send_group_msg",
      params: {
        group_id: 778899,
        message: [{ type: "text", data: { text: "group reply" } }],
      },
      echo: "echo-2",
    });
  });
});

it("maps group messages to group sessions and degraded segment text", () => {
  const message = normalizeOneBotMessageEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: "998877",
      message_id: "abc-1",
      user_id: "445566",
      group_id: "778899",
      sender: { user_id: "445566", nickname: "Lin", card: "林" },
      message: [
        { type: "reply", data: { id: "old-msg" } },
        { type: "at", data: { qq: "998877" } },
        { type: "text", data: { text: "hi" } },
        { type: "image", data: { file: "x.jpg" } },
      ],
    },
    {
      adapterId: "napcat.qq.main",
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    },
  );

  expect(message).toMatchObject({
    sessionId: "qq:group:778899",
    traceId: "napcat:998877:abc-1",
    text: "[reply:old-msg]@998877hi[image]",
    mentions: [{ kind: "user", id: "998877" }],
    target: { kind: "group", groupId: "778899" },
    sender: { userId: "445566", nickname: "Lin", card: "林" },
  });
});

it("ignores non-message events and blank normalized messages", () => {
  const options = {
    adapterId: "napcat.qq.main",
    now: () => new Date("2026-07-28T01:02:03.000Z"),
  };

  expect(
    normalizeOneBotMessageEvent(
      { post_type: "meta_event", message_id: 1, user_id: 2, message: "x" },
      options,
    ),
  ).toBeUndefined();
  expect(
    normalizeOneBotMessageEvent(
      {
        post_type: "message",
        message_type: "private",
        message_id: 1,
        user_id: 2,
        message: [{ type: "text", data: { text: "   " } }],
      },
      options,
    ),
  ).toBeUndefined();
});

it("preserves whitespace contributed by adjacent text segments", () => {
  const message = normalizeOneBotMessageEvent(
    {
      post_type: "message",
      message_type: "private",
      self_id: 998877,
      message_id: 12345,
      user_id: 112233,
      message: [
        { type: "text", data: { text: " hello " } },
        { type: "at", data: { qq: "998877" } },
        { type: "text", data: { text: " world " } },
      ],
    },
    {
      adapterId: "napcat.qq.main",
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    },
  );

  expect(message?.text).toBe(" hello @998877 world ");
  expect(message?.mentions).toEqual([{ kind: "user", id: "998877" }]);
});

it("normalizes CQ string mentions and @all like segment messages", () => {
  const options = {
    adapterId: "napcat.qq.main",
    now: () => new Date("2026-07-28T01:02:03.000Z"),
  };
  const cqMessage = normalizeOneBotMessageEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 998877,
      message_id: 1,
      user_id: 112233,
      group_id: 778899,
      message: "[CQ:at,qq=998877] hi [CQ:at,qq=all]",
    },
    options,
  );
  const segmentMessage = normalizeOneBotMessageEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 998877,
      message_id: 2,
      user_id: 112233,
      group_id: 778899,
      message: [
        { type: "at", data: { qq: 998877 } },
        { type: "text", data: { text: " hi " } },
        { type: "at", data: { qq: "all" } },
      ],
    },
    options,
  );

  expect(cqMessage).toMatchObject({
    text: "@998877 hi @all",
    mentions: [{ kind: "user", id: "998877" }, { kind: "all" }],
  });
  expect(segmentMessage).toMatchObject({
    text: cqMessage?.text,
    mentions: cqMessage?.mentions,
  });
});

it("ignores messages authored by the connected bot account", () => {
  const message = normalizeOneBotMessageEvent(
    {
      post_type: "message",
      message_type: "group",
      self_id: 998877,
      message_id: 12345,
      user_id: 998877,
      group_id: 778899,
      message: "It is a lovely night for watching the moon.",
    },
    {
      adapterId: "napcat.qq.main",
      now: () => new Date("2026-07-28T01:02:03.000Z"),
    },
  );

  expect(message).toBeUndefined();
});
