/**
 * 功能概述：定义入站有序媒体引用与可见元信息，供 Runtime 入账、原始证据投影和模型输入共用。
 * mediaReferenceSchema 仅包含稳定来源身份和已验证资源摘要，不允许 URL、路径或凭据进入情境。
 * 内容段保留原消息顺序；不可用素材仍有 mediaId，字节去重不合并来源授权。本文件不执行 I/O。
 * 出站段限制数量和来源 ID；冻结输入选择校验只读取宿主写入的请求消息标记，最终投递仍需重新校验场景与资源。
 */
import { z } from "zod";
export const mediaReferenceSchema = z.strictObject({
  mediaId: z.string().regex(/^media:[a-f0-9]{64}$/),
  position: z.number().int().nonnegative(),
  mediaType: z.enum(["image", "face", "mface"]),
  status: z.enum(["available", "unavailable", "invalid", "omitted"]),
  resourceId: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  mimeType: z
    .enum(["image/png", "image/jpeg", "image/gif", "image/webp"])
    .nullable(),
  byteLength: z.number().int().nonnegative(),
});
export const mediaContentSegmentsSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("text"), text: z.string() }),
      z.strictObject({ kind: z.literal("media"), media: mediaReferenceSchema }),
    ]),
  )
  .max(256);
export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export type MediaContentSegment = z.infer<
  typeof mediaContentSegmentsSchema
>[number];

/** 出站不接受 URL 或路径；text 按段顺序保留，mediaId 仅引用宿主入账的素材。 */
export const outboundContentSegmentsSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("text"),
        text: z.string().min(1).max(16000),
      }),
      z.strictObject({
        kind: z.literal("mediaRef"),
        mediaId: z.string().regex(/^media:[a-f0-9]{64}$/u),
      }),
    ]),
  )
  .min(1)
  .max(64)
  .refine(
    (segments) => segments.some((segment) => segment.kind === "mediaRef"),
    "At least one media reference is required",
  )
  .refine(
    (segments) =>
      segments.filter((segment) => segment.kind === "mediaRef").length <= 4,
    "Too many media references",
  );
export type OutboundContentSegment = z.infer<
  typeof outboundContentSegmentsSchema
>[number];

/** 提取冻结请求中可引用的来源；最终宿主必须再核验场景权限、内容哈希及原始资源。 */
export function frozenOutboundMediaIds(messages: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(messages)) return ids;
  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      message.role !== "user" ||
      !Array.isArray(message.content)
    )
      continue;
    const first = message.content[0];
    if (!first || first.type !== "text" || typeof first.text !== "string")
      continue;
    try {
      const marker = JSON.parse(first.text)?.mediaInput;
      if (
        marker &&
        typeof marker.mediaId === "string" &&
        /^media:[a-f0-9]{64}$/u.test(marker.mediaId) &&
        typeof marker.resourceId === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(marker.resourceId) &&
        ((marker.mode === "off" && marker.status === "vision-off") ||
          (marker.mode === "native" && marker.status === "native") ||
          (marker.mode === "external" && marker.status === "external"))
      )
        ids.add(marker.mediaId);
    } catch {
      /* 非媒体正文 */
    }
  }
  return ids;
}

/** 校验正文与有序段完全一致，且媒体均出现在该模型请求的冻结输入中。 */
export function validateOutboundMediaSelection(
  text: string,
  segments: readonly OutboundContentSegment[],
  messages: unknown,
): void {
  const parsed = outboundContentSegmentsSchema.parse(segments);
  if (
    parsed
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("") !== text
  )
    throw new Error("MEDIA_OUTPUT_TEXT_MISMATCH");
  const ids = frozenOutboundMediaIds(messages);
  if (parsed.some((part) => part.kind === "mediaRef" && !ids.has(part.mediaId)))
    throw new Error("MEDIA_OUTPUT_NOT_IN_FROZEN_INPUT");
}
