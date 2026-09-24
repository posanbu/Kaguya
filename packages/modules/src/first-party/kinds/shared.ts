/**
 * 来源中可选 expressions 保存 QQ 素材元数据，供独立插件消费，不代表图片语义。
 * 功能概述：提供一方 Information kind 共用的非空字符串、消息来源 schema 与受限日志预览。
 * 主要职责：contentPreview 先完整脱敏再按 Unicode 码点截取正文，并转义控制字符；
 * sanitizeLoggedContent 屏蔽连接串、完整 Authorization 凭据和私钥材料，避免截断破坏匹配边界。
 * 代码库关系：message、association 与 person-fact 的日志投影复用预览函数，
 * messageSourceSchema 约束适配器入站消息的来源和回复关系，不执行 I/O 或改写原始正文。
 * 输入输出与副作用：contentLength 始终记录原文字数；原文或脱敏后预览超过 168 码点时
 * contentTruncated 为 true 并添加省略号。脱敏占位符不改变原文字数统计。
 */
import {
  qqExpressionSchema,
  platformDestinationSchema,
  z,
} from "@kaguya/schema";

export const nonBlankString = z.string().trim().min(1);

const CONTENT_PREVIEW_LENGTH = 168;

export function contentPreview(text: string) {
  const contentLength = Array.from(text).length;
  const codePoints = Array.from(sanitizeLoggedContent(text));
  const truncated =
    contentLength > CONTENT_PREVIEW_LENGTH ||
    codePoints.length > CONTENT_PREVIEW_LENGTH;
  return {
    contentPreview:
      codePoints
        .slice(0, CONTENT_PREVIEW_LENGTH)
        .map((point) => {
          const value = point.codePointAt(0) ?? 0;
          return value < 0x20 && point !== "\n" && point !== "\t"
            ? `\\u${value.toString(16).padStart(4, "0")}`
            : point;
        })
        .join("") + (truncated ? "…" : ""),
    contentLength,
    contentTruncated: truncated,
  };
}

function sanitizeLoggedContent(text: string): string {
  return (
    text
      .replace(
        /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/giu,
        "[REDACTED]",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
      // 先处理认证方案及其值，避免通用赋值规则只遮住 Bearer/Basic 后留下真正的凭据。
      .replace(
        /\b(authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s]+/giu,
        "$1=[REDACTED]",
      )
      .replace(
        /\b(api[_-]?key|authorization|token|password|secret|credential)\s*[:=]\s*[^\s]+/giu,
        "$1=[REDACTED]",
      )
      .replace(/\bBearer\s+[^\s]+/giu, "Bearer [REDACTED]")
      .replace(
        /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu,
        "[REDACTED PRIVATE MATERIAL]",
      )
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
    expressions: z.array(qqExpressionSchema).max(8).optional(),
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
