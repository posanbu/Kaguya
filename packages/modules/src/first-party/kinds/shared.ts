/**
 * 功能概述：shared 领域的 Information schema 与不可变定义，独立维护本领域引用和日志投影。
 * 主要职责：下列 schema 校验入账载荷，各 kind 声明因果关系、上下文和诊断元数据；无 I/O。
 * 代码库关系：information-kinds.ts 稳定重导出公共对象；跨领域只复用相邻文件定义，保持 Registry 对象身份。
 */
import { platformDestinationSchema, z } from "@kaguya/schema";

export const nonBlankString = z.string().trim().min(1);

const CONTENT_PREVIEW_LENGTH = 168;

export function contentPreview(text: string) {
  const codePoints = Array.from(text);
  const truncated = codePoints.length > CONTENT_PREVIEW_LENGTH;
  return {
    contentPreview: sanitizeLoggedContent(
      codePoints
        .slice(0, CONTENT_PREVIEW_LENGTH)
        .map((point) => {
          const value = point.codePointAt(0) ?? 0;
          return value < 0x20 && point !== "\n" && point !== "\t"
            ? `\\u${value.toString(16).padStart(4, "0")}`
            : point;
        })
        .join("") + (truncated ? "…" : ""),
    ),
    contentLength: codePoints.length,
    contentTruncated: truncated,
  };
}

function sanitizeLoggedContent(text: string): string {
  return text
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/giu,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|authorization|token|password|secret|credential)\s*[:=]\s*[^\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu,
      "[REDACTED PRIVATE MATERIAL]",
    );
}

export const messageSourceSchema = z
  .object({
    adapterId: nonBlankString,
    platform: nonBlankString,
    platformMessageId: nonBlankString,
    destination: platformDestinationSchema,
    senderId: nonBlankString,
    sender: z
      .object({
        userId: nonBlankString,
        nickname: nonBlankString.optional(),
        card: nonBlankString.optional(),
        isSelf: z.boolean().optional(),
      })
      .strict()
      .optional(),
    selfId: nonBlankString.optional(),
    mentions: z
      .array(
        z.union([
          z.object({ kind: z.literal("user"), id: nonBlankString }).strict(),
          z.object({ kind: z.literal("all") }).strict(),
        ]),
      )
      .optional(),
    replyTo: z
      .object({
        platformMessageId: nonBlankString,
        senderId: nonBlankString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict() as any;
