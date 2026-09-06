/**
 * 功能概述：把 Web HTTP 消息请求正规化为与 QQ 平台对等的入站内容，
 * 但只保留外部 request ID，不构造 trace 或 information ID。
 * 主要职责：`normalizeWebInboundMessage` 严格校验 text/requestId、修剪两者、
 * 设置 web sender/destination 并通过可注入 `now` 生成 occurredAt。
 * 代码库关系：Server `web-gateway.ts` 调用本函数后只经
 * `InformationIngress.submit` 进入 Runtime；输出契约来自 `types.ts`。
 * 输入输出与副作用：函数无 I/O，非法输入返回 `undefined`；
 * raw 供 adapter 边界诊断，Runtime 不得将它写入 information ledger。
 */
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
    platformMessageId: requestId,
    occurredAt,
    text,
    mentions: [],
    target: { kind: "web" },
    sender: { userId: "web" },
    raw: input as Record<string, unknown>,
  };
}
