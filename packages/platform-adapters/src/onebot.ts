import { z } from "@kaguya/schema";

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

  const sessionId =
    target.kind === "private"
      ? `qq:private:${target.userId}`
      : `qq:group:${target.groupId}`;

  return {
    platform: "qq",
    adapterId: options.adapterId,
    ...(selfId === undefined ? {} : { selfId }),
    sessionId,
    traceId: `napcat:${selfId ?? "unknown"}:${platformMessageId}`,
    platformMessageId,
    occurredAt:
      event.time === undefined
        ? options.now().toISOString()
        : new Date(event.time * 1000).toISOString(),
    text,
    mentions: normalizedMessage.mentions,
    target,
    sender: senderFor(event.sender, userId),
    raw: input as Record<string, unknown>,
  };
}

export function buildOneBotSendAction(
  target: PlatformMessageTarget,
  text: string,
  echo: string,
): OneBotActionRequest {
  const message = [{ type: "text", data: { text } }] as const;
  if (target.kind === "private") {
    return {
      action: "send_private_msg",
      params: { user_id: Number(target.userId), message },
      echo,
    };
  }
  return {
    action: "send_group_msg",
    params: { group_id: Number(target.groupId), message },
    echo,
  };
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
  readonly mentions: readonly PlatformMessageMention[];
} {
  const mentions: PlatformMessageMention[] = [];
  const text =
    typeof message === "string"
      ? normalizeStringMessage(message, mentions)
      : message.map((segment) => segmentToText(segment, mentions)).join("");
  return { text, mentions };
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
