/**
 * 测试夹具显式装配 QQ 表情模板，验证新增模块契约与既有流程兼容。
 * 功能概述：验证 OneBot 入站事件仅被正规化为平台内容与外部身份，
 * 以及出站文本/回复和有序图片如何编码为 OneBot action，不允许 adapter 生成 Core 身份。
 * 同时检查图片和表情来源按原始位置保留，CQ 转义不会变成媒体段。
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
  outboundContentSegmentsSchema,
  outboundMessageContentSchema,
  validateOutboundMediaSelection,
} from "@kaguya/schema";

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

describe("ordered outbound media", () => {
  const id = `media:${"a".repeat(64)}`;
  const image = {
    mediaId: id,
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png" as const,
    sha256: "b".repeat(64),
  };
  const message = {
    kind: "content" as const,
    text: "beforeafter",
    requestInformationId: "request:1",
    segments: [
      { kind: "text" as const, text: "before" },
      { kind: "mediaRef" as const, mediaId: id },
      { kind: "text" as const, text: "after" },
    ],
  };
  it("preserves text and media order and encodes only resolved bytes", () => {
    const result = buildOneBotSendAction(
      { kind: "group", groupId: "42" },
      message,
      "echo",
      { images: [image] },
    );
    expect(result.params.message).toEqual([
      { type: "text", data: { text: "before" } },
      { type: "image", data: { file: "base64://AQID" } },
      { type: "text", data: { text: "after" } },
    ]);
  });
  it("supports pure media and rejects missing or ambiguous resolved resources", () => {
    const pure = {
      ...message,
      text: "",
      segments: [{ kind: "mediaRef" as const, mediaId: id }],
    };
    expect(
      buildOneBotSendAction({ kind: "private", userId: "7" }, pure, "echo", {
        images: [image],
      }).params.message,
    ).toEqual([{ type: "image", data: { file: "base64://AQID" } }]);
    expect(() =>
      buildOneBotSendAction({ kind: "private", userId: "7" }, pure, "echo"),
    ).toThrow(/resolved media/u);
    expect(() =>
      buildOneBotSendAction({ kind: "private", userId: "7" }, pure, "echo", {
        images: [image, image],
      }),
    ).toThrow(/resolved media/u);
  });
  it("keeps a selected QQ expression after the ordered content", () => {
    const result = buildOneBotSendAction(
      { kind: "group", groupId: "42" },
      { ...message, expression: { kind: "face", id: "14" } },
      "echo",
      { images: [image] },
    );
    expect(result.params.message.at(-1)).toEqual({
      type: "face",
      data: { id: "14" },
    });
    expect(result.params.message).toHaveLength(4);
  });
  it("validates text and bounds media references against the frozen request", () => {
    const frozen = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mediaInput: {
                mediaId: id,
                resourceId: `sha256:${"b".repeat(64)}`,
                mode: "off",
                status: "vision-off",
              },
            }),
          },
        ],
      },
    ];
    expect(() =>
      validateOutboundMediaSelection(message.text, message.segments, frozen),
    ).not.toThrow();
    expect(() =>
      validateOutboundMediaSelection("changed", message.segments, frozen),
    ).toThrow("MEDIA_OUTPUT_TEXT_MISMATCH");
    expect(() =>
      validateOutboundMediaSelection(message.text, message.segments, []),
    ).toThrow("MEDIA_OUTPUT_NOT_IN_FROZEN_INPUT");
    expect(() =>
      outboundContentSegmentsSchema.parse([
        { kind: "mediaRef", mediaId: "https://example.test/image" },
      ]),
    ).toThrow();
    expect(() =>
      outboundContentSegmentsSchema.parse([
        { kind: "mediaRef", mediaId: id, path: "/private" },
      ]),
    ).toThrow();
    expect(() =>
      outboundContentSegmentsSchema.parse(
        Array.from({ length: 5 }, () => ({ kind: "mediaRef", mediaId: id })),
      ),
    ).toThrow();
    expect(() => outboundContentSegmentsSchema.parse([])).toThrow();
    expect(() =>
      outboundContentSegmentsSchema.parse([{ kind: "text", text: "plain" }]),
    ).toThrow();
    expect(
      outboundMessageContentSchema.safeParse({ ...message, text: "changed" })
        .success,
    ).toBe(false);
    expect(
      outboundMessageContentSchema.safeParse({
        ...message,
        text: "",
        segments: [{ kind: "mediaRef", mediaId: id }],
      }).success,
    ).toBe(true);
  });
});

describe("buildOneBotSendAction audio", () => {
  it("sends resolved audio bytes as a NapCat record without storing base64 in the message", () => {
    const bytes = new Uint8Array([82, 73, 70, 70]);
    const action = buildOneBotSendAction(
      { kind: "private", userId: "123" },
      {
        kind: "audio",
        resourceId: `sha256:${"a".repeat(64)}`,
        mimeType: "audio/wav",
        byteLength: bytes.byteLength,
        sha256: "a".repeat(64),
        text: "你好",
      },
      "echo",
      { media: { bytes, mimeType: "audio/wav", sha256: "a".repeat(64) } },
    );
    expect(action.params.message).toEqual([
      { type: "record", data: { file: "base64://UklGRg==" } },
    ]);
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

describe("QQ expression wire compatibility", () => {
  const event = {
    post_type: "message",
    message_type: "group",
    self_id: 9,
    user_id: 1,
    group_id: 2,
    message_id: 3,
  };
  const options = {
    adapterId: "qq",
    now: () => new Date("2026-09-24T00:00:00Z"),
  };
  it("preserves face, sticker, marketplace and emoji while excluding normal photos", () => {
    const input = normalizeOneBotMessageEvent(
      {
        ...event,
        message: [
          { type: "text", data: { text: "😂" } },
          { type: "face", data: { id: 14 } },
          {
            type: "image",
            data: {
              file: "a.gif",
              url: "https://gchat.qpic.cn/a",
              sub_type: 1,
            },
          },
          {
            type: "image",
            data: {
              file: "photo.jpg",
              url: "https://gchat.qpic.cn/photo",
              sub_type: 0,
            },
          },
          {
            type: "mface",
            data: { emoji_id: "1", emoji_package_id: "2", key: "abc" },
          },
        ],
      },
      options,
    )!;
    expect(input.text).toBe("😂[face:14][image][image][mface]");
    expect(input.expressions).toEqual([
      { kind: "face", id: "14" },
      { kind: "sticker", id: "a.gif", url: "https://gchat.qpic.cn/a" },
      { kind: "mface", id: "1", packageId: "2", key: "abc" },
    ]);
  });
  it("parses CQ strings without promoting escaped text to actions", () => {
    const result = normalizeOneBotMessageEvent(
      {
        ...event,
        message: "&#91;CQ:face,id=1&#93;[CQ:face,id=14][CQ:reply,id=8]",
      },
      options,
    )!;
    expect(result.text).toBe("[CQ:face,id=1][face:14][reply:8]");
    expect(result.expressions).toEqual([{ kind: "face", id: "14" }]);
    expect(result.replyTo).toEqual({ platformMessageId: "8" });
  });
  it("encodes one structured expression beside Unicode text", () => {
    const action = buildOneBotSendAction(
      { kind: "group", groupId: "2" },
      { kind: "text", text: "😂", expression: { kind: "face", id: "14" } },
      "one",
    );
    expect(action.params.message).toEqual([
      { type: "text", data: { text: "😂" } },
      { type: "face", data: { id: "14" } },
    ]);
    expect(
      buildOneBotSendAction(
        { kind: "group", groupId: "2" },
        {
          kind: "text",
          text: "哈哈",
          expression: { kind: "sticker", file: "base64://R0lGODlh" },
        },
        "two",
      ).params.message[1],
    ).toEqual({
      type: "image",
      data: { file: "base64://R0lGODlh", sub_type: 1 },
    });
  });
});

it("round-trips a marketplace expression with a nonnumeric emoji ID", () => {
  expect(
    buildOneBotSendAction(
      { kind: "group", groupId: "2" },
      {
        kind: "text",
        text: "哈哈",
        expression: {
          kind: "mface",
          id: "a2Bc9d",
          packageId: "123",
          key: "abc123",
        },
      },
      "market",
    ).params.message[1],
  ).toEqual({
    type: "mface",
    data: {
      emoji_id: "a2Bc9d",
      emoji_package_id: 123,
      key: "abc123",
      summary: "[表情]",
    },
  });
});

describe("ordered inbound media", () => {
  const options = {
    adapterId: "qq",
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  const event = (message: unknown) => ({
    post_type: "message",
    message_type: "group",
    message_id: 1,
    user_id: 2,
    group_id: 3,
    message,
  });

  it("retains interleaved text and image, market face, and face source positions", () => {
    const input = normalizeOneBotMessageEvent(
      event([
        { type: "text", data: { text: "before" } },
        {
          type: "image",
          data: {
            file: "x.gif",
            url: "https://example.test/a",
            emoji_id: "5",
            key: "k",
          },
        },
        { type: "text", data: { text: "after" } },
        {
          type: "mface",
          data: { emoji_id: "6", emoji_package_id: 1, key: "k" },
        },
        { type: "face", data: { id: 14 } },
      ]),
      options,
    );
    expect(input?.contentSegments).toEqual([
      { kind: "text", text: "before" },
      {
        kind: "media",
        position: 1,
        mediaType: "image",
        source: {
          file: "x.gif",
          url: "https://example.test/a",
          emoji_id: "5",
          key: "k",
        },
      },
      { kind: "text", text: "after" },
      {
        kind: "media",
        position: 3,
        mediaType: "mface",
        source: { emoji_id: "6", emoji_package_id: "1", key: "k" },
      },
      { kind: "media", position: 4, mediaType: "face", source: { id: "14" } },
    ]);
  });

  it("retains a pure CQ image and treats escaped CQ text as text", () => {
    const input = normalizeOneBotMessageEvent(
      event("[CQ:image,file=x.gif,url=https://example.test/a]"),
      options,
    );
    expect(input?.contentSegments).toEqual([
      {
        kind: "media",
        position: 0,
        mediaType: "image",
        source: { file: "x.gif", url: "https://example.test/a" },
      },
    ]);
    expect(
      normalizeOneBotMessageEvent(event("&#91;CQ:image,file=x&#93;"), options)
        ?.contentSegments,
    ).toBeUndefined();
  });
});
