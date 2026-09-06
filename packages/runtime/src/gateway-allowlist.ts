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
