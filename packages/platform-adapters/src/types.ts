export type PlatformName = "qq";

export type PlatformMessageTarget =
  | { readonly kind: "private"; readonly userId: string }
  | { readonly kind: "group"; readonly groupId: string };

export interface PlatformMessageSender {
  readonly userId: string;
  readonly nickname?: string;
  readonly card?: string;
}

export type PlatformMessageMention =
  { readonly kind: "user"; readonly id: string } | { readonly kind: "all" };

export interface PlatformInboundMessage {
  readonly platform: PlatformName;
  readonly adapterId: string;
  readonly selfId?: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly platformMessageId: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly mentions: readonly PlatformMessageMention[];
  readonly target: PlatformMessageTarget;
  readonly sender: PlatformMessageSender;
  readonly raw: Record<string, unknown>;
}

export interface PlatformDeliveryReceipt {
  readonly ok: boolean;
  readonly adapterId: string;
  readonly platform: PlatformName;
  readonly target: PlatformMessageTarget;
  readonly platformMessageId?: string;
  readonly error?: string;
  readonly raw?: unknown;
}

export interface PlatformReplySender {
  sendTextReply(
    target: PlatformMessageTarget,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<PlatformDeliveryReceipt>;
}
