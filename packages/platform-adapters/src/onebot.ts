/**
 * 兼容 CQ/数组的 face、mface 和表情图片，保留可复用素材；出站显式编码表情段，普通文本不解析为动作。
 * 功能概述：在 OneBot wire event/action 与 Kaguya 平台消息契约之间做双向转换，
 * adapter 层只保留外部身份和内容，不产生 Core identity。
 * 主要职责：`normalizeOneBotMessageEvent` 校验 message event、过滤机器人自身、
 * 正规化 text/mention/sender/target/occurredAt 并保留 `platformMessageId`；
 * `buildOneBotSendAction` 将文本或 reply 内容编码为私聊/群聊 action。
 * 代码库关系：NapCat adapter 复用入站正规化器与出站 action builder；
 * 输出 `PlatformInboundMessage` 随后由 `InformationIngress` 提交给 Runtime。
 * 输入输出与副作用：转换函数无 I/O；非法/空白/不支持事件返回 `undefined`，
 * 缺失外部时间时才调用注入的 `now`，raw 仅留在边界值中。
 */
import {
  z,
  qqExpressionSchema,
  type QqExpression,
  type OutboundMessageContent,
} from "@kaguya/schema";

import type {
  PlatformInboundMessage,
  PlatformMessageMention,
  PlatformMessageSender,
  PlatformMessageTarget,
} from "./types.js";

export interface NormalizeOneBotOptions {
  readonly adapterId: string;
  readonly now: () => Date;
}

export interface OneBotActionRequest {
  readonly action: "send_private_msg" | "send_group_msg";
  readonly params:
    | {
        readonly user_id: number;
        readonly message: readonly OneBotMessageSegment[];
      }
    | {
        readonly group_id: number;
        readonly message: readonly OneBotMessageSegment[];
      };
  readonly echo: string;
}

export type OneBotMessageSegment = {
  readonly type: string;
  readonly data?: Record<string, unknown>;
};

type ParsedOneBotMessageSegment = {
  readonly type: string;
  readonly data?: Record<string, unknown> | undefined;
};

const segmentSchema = z
  .object({
    type: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    post_type: z.string().optional(),
    message_type: z.string().optional(),
    self_id: z.union([z.string(), z.number()]).optional(),
    message_id: z.union([z.string(), z.number()]),
    user_id: z.union([z.string(), z.number()]),
    group_id: z.union([z.string(), z.number()]).optional(),
    time: z.number().optional(),
    sender: z.record(z.string(), z.unknown()).optional(),
    message: z.union([z.string(), z.array(segmentSchema)]),
  })
  .passthrough();

export function normalizeOneBotMessageEvent(
  input: unknown,
  options: NormalizeOneBotOptions,
): PlatformInboundMessage | undefined {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success || parsed.data.post_type !== "message") return undefined;

  const event = parsed.data;
  const messageType = event.message_type;
  if (messageType !== "private" && messageType !== "group") return undefined;

  const platformMessageId = normalizeRequiredId(event.message_id);
  const userId = normalizeRequiredId(event.user_id);
  const selfId = normalizeOptionalId(event.self_id);
  if (selfId !== undefined && userId === selfId) return undefined;

  const normalizedMessage = normalizeMessage(event.message);
  const text = normalizedMessage.text;
  if (!platformMessageId || !userId || !text.trim()) return undefined;

  const target = targetFor(messageType, event.group_id, userId);
  if (target === undefined) return undefined;

  return {
    platform: "qq",
    adapterId: options.adapterId,
    ...(selfId === undefined ? {} : { selfId }),
    platformMessageId,
    occurredAt:
      event.time === undefined
        ? options.now().toISOString()
        : new Date(event.time * 1000).toISOString(),
    text,
    mentions: normalizedMessage.mentions,
    ...(normalizedMessage.expressions.length
      ? { expressions: normalizedMessage.expressions }
      : {}),
    ...(normalizedMessage.replyTo
      ? { replyTo: normalizedMessage.replyTo }
      : {}),
    target,
    sender: senderFor(event.sender, userId),
    raw: input as Record<string, unknown>,
  };
}

export function buildOneBotSendAction(
  target: PlatformMessageTarget,
  content: string | OutboundMessageContent,
  echo: string,
): OneBotActionRequest {
  const normalized: OutboundMessageContent =
    typeof content === "string"
      ? ({ kind: "text", text: content } as const)
      : content;
  const message: readonly OneBotMessageSegment[] = [
    ...(normalized.kind === "reply"
      ? [
          {
            type: "reply",
            data: { id: normalized.replyToPlatformMessageId },
          },
        ]
      : []),
    { type: "text", data: { text: normalized.text } },
    ...(normalized.kind === "text" && normalized.expression
      ? [
          normalized.expression.kind === "mface"
            ? {
                type: "mface",
                data: {
                  emoji_id: normalized.expression.id,
                  emoji_package_id: Number(normalized.expression.packageId),
                  summary: "[表情]",
                  key: normalized.expression.key,
                },
              }
            : normalized.expression.kind === "face"
              ? { type: "face", data: { id: normalized.expression.id } }
              : {
                  type: "image",
                  data: { file: normalized.expression.file, sub_type: 1 },
                },
        ]
      : []),
  ];
  if (target.kind === "private") {
    return {
      action: "send_private_msg",
      params: { user_id: Number(target.userId), message },
      echo,
    };
  }
  if (target.kind === "group") {
    return {
      action: "send_group_msg",
      params: { group_id: Number(target.groupId), message },
      echo,
    };
  }
  throw new Error("OneBot cannot send messages to web destinations");
}

function targetFor(
  messageType: "private" | "group",
  groupIdValue: string | number | undefined,
  userId: string,
): PlatformMessageTarget | undefined {
  if (messageType === "private") return { kind: "private", userId };
  const groupId = normalizeOptionalId(groupIdValue);
  return groupId === undefined ? undefined : { kind: "group", groupId };
}

function normalizeMessage(
  message: string | readonly ParsedOneBotMessageSegment[],
): {
  readonly text: string;
  readonly expressions: readonly QqExpression[];
  readonly mentions: readonly PlatformMessageMention[];
  readonly replyTo?: { readonly platformMessageId: string };
} {
  const mentions: PlatformMessageMention[] = [];
  // CQ 字符串先按 wire 结构分段；转义只解一次，正文中的转义 CQ 不会成为媒体。
  if (typeof message === "string") message = parseCqSegments(message);
  const expressions = message
    .flatMap((segment): QqExpression[] => {
      const data = segment.data ?? {};
      const candidate =
        segment.type === "mface"
          ? {
              kind: "mface",
              id: String(data.emoji_id ?? ""),
              packageId: String(data.emoji_package_id ?? ""),
              key: data.key,
            }
          : segment.type === "face"
            ? { kind: "face", id: String(data.id ?? "") }
            : segment.type === "image" &&
                (String(data.sub_type) === "1" || data.file === "marketface")
              ? {
                  kind: "sticker",
                  id: String(
                    data.file_unique ||
                      (data.file !== "marketface" ? data.file : "") ||
                      data.file_id ||
                      data.url ||
                      "",
                  ),
                  url: data.url,
                }
              : undefined;
      const parsed = qqExpressionSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 8);
  const reply =
    typeof message === "string"
      ? undefined
      : message.find((segment) => segment.type === "reply");
  const replyTo =
    reply === undefined ? undefined : normalizeOptionalText(reply.data?.id);
  const text =
    typeof message === "string"
      ? normalizeStringMessage(message, mentions)
      : message.map((segment) => segmentToText(segment, mentions)).join("");
  return {
    text,
    mentions,
    expressions,
    ...(replyTo ? { replyTo: { platformMessageId: replyTo } } : {}),
  };
}

function segmentToText(
  segment: ParsedOneBotMessageSegment,
  mentions: PlatformMessageMention[],
): string {
  if (segment.type === "text") {
    const text = segment.data?.text;
    if (typeof text !== "string" && typeof text !== "number") {
      return "";
    }
    return String(text);
  }
  if (segment.type === "at") {
    const target = normalizeMention(segment.data?.qq);
    if (target === undefined) return "@unknown";
    mentions.push(target);
    return target.kind === "all" ? "@all" : `@${target.id}`;
  }
  if (segment.type === "reply")
    return `[reply:${normalizeOptionalText(segment.data?.id) ?? "unknown"}]`;
  if (segment.type === "image") return "[image]";
  if (segment.type === "face")
    return `[face:${normalizeOptionalText(segment.data?.id) ?? "unknown"}]`;
  return `[${segment.type}]`;
}

function normalizeStringMessage(
  message: string,
  mentions: PlatformMessageMention[],
): string {
  return message.replace(
    /\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]/g,
    (_segment, rawTarget: string) => {
      const target = normalizeMention(rawTarget);
      if (target === undefined) return "@unknown";
      mentions.push(target);
      return target.kind === "all" ? "@all" : `@${target.id}`;
    },
  );
}

function normalizeMention(value: unknown): PlatformMessageMention | undefined {
  const normalized = normalizeOptionalId(value);
  if (normalized === undefined) return undefined;
  return normalized === "all"
    ? { kind: "all" }
    : { kind: "user", id: normalized };
}

function senderFor(
  sender: Record<string, unknown> | undefined,
  fallbackUserId: string,
): PlatformMessageSender {
  const nickname = normalizeOptionalText(sender?.nickname);
  const card = normalizeOptionalText(sender?.card);
  return {
    userId: normalizeOptionalId(sender?.user_id) ?? fallbackUserId,
    ...(nickname === undefined ? {} : { nickname }),
    ...(card === undefined ? {} : { card }),
  };
}

function normalizeRequiredId(value: string | number): string {
  return String(value).trim();
}

function normalizeOptionalId(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "boolean")
    return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

/** OneBot CQ 数组/字符串使用同一正规化入口，拒绝将转义文字作为动作执行。 */
function parseCqSegments(message: string): ParsedOneBotMessageSegment[] {
  const decode = (s: string) =>
    s
      .replace(/&#44;/gu, ",")
      .replace(/&#91;/gu, "[")
      .replace(/&#93;/gu, "]")
      .replace(/&amp;/gu, "&");
  const segments: ParsedOneBotMessageSegment[] = [];
  let cursor = 0;
  for (const match of message.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gu)) {
    if (match.index > cursor)
      segments.push({
        type: "text",
        data: { text: decode(message.slice(cursor, match.index)) },
      });
    const data: Record<string, unknown> = {};
    for (const field of match[2]!.split(",").slice(1)) {
      const split = field.indexOf("=");
      if (split > 0)
        data[field.slice(0, split)] = decode(field.slice(split + 1));
    }
    segments.push({ type: match[1]!, data });
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length)
    segments.push({
      type: "text",
      data: { text: decode(message.slice(cursor)) },
    });
  return segments;
}
