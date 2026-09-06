/**
 * 功能概述：验证 OneBot 入站事件仅被正规化为平台内容与外部身份，
 * 以及出站文本/回复如何编码为 OneBot action，不允许 adapter 生成 Core 身份。
 * 主要职责：覆盖私聊、群聊、mention、降级 segment、自身消息过滤和发送 action；
 * 关键断言保留 `platformMessageId`、sender、destination 与外部时间，并排除 `traceId`
 * 和 `informationId`。
 * 代码库关系：直接测试 `onebot.ts`；`NapCatOneBotAdapter` 复用同一正规化器，
 * Runtime 随后才会为该内容创建 `informationId`。
 * 输入输出与副作用：所有 fixture 都是内存对象，无网络或持久化副作用；
 * 无效、空白或机器人自发事件必须返回 `undefined`。
 */
import { describe, expect, it } from "vitest";

import {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
} from "./onebot.js";

describe("normalizeOneBotMessageEvent", () => {
  it("maps private text messages without creating a Core session", () => {
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
      platformMessageId: "12345",
      occurredAt: "2026-07-28T01:02:03.000Z",
      text: "hello kaguya",
      mentions: [],
      target: { kind: "private", userId: "112233" },
      sender: { userId: "112233", nickname: "Ada" },
    });
    expect(message).not.toHaveProperty("traceId");
    expect(message).not.toHaveProperty("informationId");
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

  it("builds reply actions with an explicit platform reply segment", () => {
    expect(
      buildOneBotSendAction(
        { kind: "group", groupId: "778899" },
        {
          kind: "reply",
          replyToPlatformMessageId: "source-message-1",
          text: "group reply",
        },
        "echo-reply",
      ),
    ).toEqual({
      action: "send_group_msg",
      params: {
        group_id: 778899,
        message: [
          { type: "reply", data: { id: "source-message-1" } },
          { type: "text", data: { text: "group reply" } },
        ],
      },
      echo: "echo-reply",
    });
  });
});

it("maps group messages to structured targets and degraded segment text", () => {
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
    platformMessageId: "abc-1",
    text: "[reply:old-msg]@998877hi[image]",
    mentions: [{ kind: "user", id: "998877" }],
    target: { kind: "group", groupId: "778899" },
    sender: { userId: "445566", nickname: "Lin", card: "林" },
  });
  expect(message).not.toHaveProperty("traceId");
  expect(message).not.toHaveProperty("informationId");
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
