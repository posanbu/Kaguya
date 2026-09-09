/**
 * 功能概述：实现 Server 配置的平台入站 allowlist 判定，作为调用 Core ingress 前的纯策略。
 * 主要职责：`GatewayAllowlist` 解析 `platform:chat-type:target-id` 字符串规则，并按
 * 平台、群 ID 或私聊用户 ID 匹配；Web 消息始终放行，继续只由 HTTP Bearer Token 边界控制。
 * 代码库关系：Server composition 从 Profile runtime 配置构造本类并把 `allows` 以谓词注入 NapCat
 * adapter；本模块只依赖平台消息结构，不持有数据库、Core、Runtime 或业务模块。
 * 输入输出与副作用：`allows` 返回同步布尔值且无 I/O；空规则拒绝平台消息，
 * 格式错误的规则被忽略，platform 与 target ID 的 `*` 表示通配。
 */
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";

interface GatewayAllowlistRule {
  readonly platform: string;
  readonly chatType: "group" | "private";
  readonly targetId: string;
}

/**
 * Inbound gateway policy for platform messages.
 *
 * Rules are ORed. An empty rule list denies all non-Web platform messages.
 */
export class GatewayAllowlist {
  readonly #rules: readonly GatewayAllowlistRule[];

  constructor(rules: readonly string[] = []) {
    const parsed = new Map<string, GatewayAllowlistRule>();
    for (const input of rules) {
      const rule = parseRule(input);
      if (rule !== undefined) {
        parsed.set(ruleKey(rule), rule);
      }
    }
    this.#rules = [...parsed.values()];
  }

  allows(message: PlatformInboundMessage): boolean {
    if (message.platform === "web") {
      return true;
    }
    if (message.target.kind === "web") {
      return false;
    }
    const chatType = message.target.kind;
    const targetId =
      chatType === "group" ? message.target.groupId : message.target.userId;
    return this.#rules.some(
      (rule) =>
        rule.chatType === chatType &&
        (rule.platform === "*" || rule.platform === message.platform) &&
        (rule.targetId === "*" || rule.targetId === targetId),
    );
  }
}

function parseRule(input: unknown): GatewayAllowlistRule | undefined {
  if (typeof input !== "string") return undefined;
  const parts = input.split(":");
  if (parts.length !== 3) return undefined;
  const [platformPart, chatTypePart, targetIdPart] = parts;
  const platform = platformPart?.trim() ?? "";
  const chatType = chatTypePart?.trim() ?? "";
  const targetId = targetIdPart?.trim() ?? "";
  if (
    platform.length === 0 ||
    targetId.length === 0 ||
    (chatType !== "group" && chatType !== "private")
  ) {
    return undefined;
  }
  return { platform, chatType, targetId };
}

function ruleKey(rule: GatewayAllowlistRule): string {
  return `${rule.platform}:${rule.chatType}:${rule.targetId}`;
}
