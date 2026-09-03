/**
 * 功能概述：实现 Server 配置的平台入站 allowlist 判定，作为调用 Core ingress 前的纯策略。
 * 主要职责：`GatewayAllowlist` 正规化平台、用户和群 ID；NapCat 等平台消息必须同时命中
 * 所有非空维度；Web 消息始终放行，继续只由 HTTP Bearer Token 边界控制。
 * 代码库关系：Server composition 从环境配置构造本类并把 `allows` 以谓词注入 NapCat
 * adapter；本模块只依赖平台消息结构，不持有数据库、Core、Runtime 或业务模块。
 * 输入输出与副作用：`allows` 返回同步布尔值且无 I/O；空配置是通配，群维度拒绝私聊。
 */
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";

export interface GatewayAllowlistOptions {
  readonly platforms?: readonly string[];
  readonly userIds?: readonly string[];
  readonly groupIds?: readonly string[];
}

/**
 * Inbound gateway policy for platform messages.
 *
 * An empty dimension is a wildcard. When multiple dimensions are configured,
 * all configured dimensions must match the same message.
 */
export class GatewayAllowlist {
  readonly #platforms: ReadonlySet<string>;
  readonly #userIds: ReadonlySet<string>;
  readonly #groupIds: ReadonlySet<string>;

  constructor(options: GatewayAllowlistOptions = {}) {
    this.#platforms = normalizedSet(options.platforms);
    this.#userIds = normalizedSet(options.userIds);
    this.#groupIds = normalizedSet(options.groupIds);
  }

  allows(message: PlatformInboundMessage): boolean {
    if (message.platform === "web") {
      return true;
    }
    if (
      this.#platforms.size > 0 &&
      !this.#platforms.has(normalizeId(message.platform))
    ) {
      return false;
    }

    if (
      this.#userIds.size > 0 &&
      !this.#userIds.has(normalizeId(message.sender.userId))
    ) {
      return false;
    }

    if (this.#groupIds.size === 0) {
      return true;
    }

    return (
      message.target.kind === "group" &&
      this.#groupIds.has(normalizeId(message.target.groupId))
    );
  }
}

function normalizedSet(
  values: readonly string[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (values ?? [])
      .map((value) => normalizeId(value))
      .filter((value) => value.length > 0),
  );
}

function normalizeId(value: string): string {
  return value.trim();
}
