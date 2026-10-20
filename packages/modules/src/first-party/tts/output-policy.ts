/**
 * 功能概述：定义 TTS 首版输出策略，默认保留文字。
 * 主要职责：要求会话显式开启且授权有效，不朗读跨会话或结构化正文。
 * 代码库关系：供后续 Heavy 统一出口调用；本函数本身不授予发送权限。
 * 输入输出与副作用：返回分支及原因，不改写正文，不注册事件或发送消息。
 */
import { z } from "@kaguya/schema";

export const ttsOutputSettingsSchema = z
  .object({
    mode: z.enum(["text", "voice-fallback-text"]).default("text"),
    maxCharacters: z.number().int().min(1).max(600).default(300),
  })
  .strict();

export type TtsOutputDecision =
  | { readonly kind: "voice"; readonly text: string }
  | { readonly kind: "blocked"; readonly reason: "unauthorized" }
  | {
      readonly kind: "text";
      readonly reason:
        | "disabled"
        | "unsupported_platform"
        | "cross_conversation"
        | "invalid_text"
        | "too_long"
        | "structured_text";
    };

export function decideTtsOutput(
  settings: z.input<typeof ttsOutputSettingsSchema>,
  context: {
    readonly authorized: boolean;
    readonly platform: string;
    readonly audioSupported: boolean;
    readonly crossConversation: boolean;
    readonly text: string;
  },
): TtsOutputDecision {
  const config = ttsOutputSettingsSchema.parse(settings);
  if (!context.authorized) return { kind: "blocked", reason: "unauthorized" };
  if (config.mode === "text") return { kind: "text", reason: "disabled" };
  if (context.crossConversation)
    return { kind: "text", reason: "cross_conversation" };
  if (context.platform !== "qq" || !context.audioSupported)
    return { kind: "text", reason: "unsupported_platform" };
  if (!context.text.trim()) return { kind: "text", reason: "invalid_text" };
  if (Array.from(context.text).length > config.maxCharacters)
    return { kind: "text", reason: "too_long" };
  // 首版宁可保留原文，也不删除代码/链接后把新内容当作已授权正文。
  if (/```|~~~|`|https?:\/\/|^\s*\|.*\|\s*$|^ {4}\S/mu.test(context.text))
    return { kind: "text", reason: "structured_text" };
  return { kind: "voice", text: context.text };
}
