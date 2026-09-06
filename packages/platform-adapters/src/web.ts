import { z } from "@kaguya/schema";

import type { PlatformInboundMessage } from "./types.js";

export interface WebInboundInput {
  readonly text: string;
  readonly requestId: string;
}

export interface NormalizeWebInboundOptions {
  readonly adapterId: string;
  readonly now?: () => Date;
}

const webInboundSchema = z
  .object({
    text: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
  })
  .strict();

export function normalizeWebInboundMessage(
  input: unknown,
  options: NormalizeWebInboundOptions,
): PlatformInboundMessage | undefined {
  const parsed = webInboundSchema.safeParse(input);
  if (!parsed.success) return undefined;

  const { text, requestId } = parsed.data;
  const occurredAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    platform: "web",
    adapterId: options.adapterId,
    traceId: `web:${requestId}`,
    platformMessageId: requestId,
    occurredAt,
    text,
    mentions: [],
    target: { kind: "web" },
    sender: { userId: "web" },
    raw: input as Record<string, unknown>,
  };
}
