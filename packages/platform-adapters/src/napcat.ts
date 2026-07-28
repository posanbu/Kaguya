import type {
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformMessageTarget,
  PlatformReplySender,
} from "./types.js";
import {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
} from "./onebot.js";

export interface JsonMessageTransport {
  sendJson(message: unknown): void;
  onJsonMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

type JsonMessageHandler = (message: unknown) => void;
const jsonMessageSubscribers = new WeakMap<
  JsonMessageTransport,
  Set<JsonMessageHandler>
>();

function subscribeToJsonMessages(
  transport: JsonMessageTransport,
  handler: JsonMessageHandler,
): void {
  let subscribers = jsonMessageSubscribers.get(transport);
  if (subscribers === undefined) {
    subscribers = new Set<JsonMessageHandler>();
    jsonMessageSubscribers.set(transport, subscribers);
    const subscriberSet = subscribers;
    transport.onJsonMessage((message) => {
      for (const subscriber of subscriberSet) {
        subscriber(message);
      }
    });
  }
  subscribers.add(handler);
}

export interface NapCatActionClientOptions {
  readonly adapterId: string;
  readonly transport: JsonMessageTransport;
  readonly nextEcho: () => string;
  readonly timeoutMs: number;
}

interface PendingAction {
  readonly target: PlatformMessageTarget;
  readonly resolve: (receipt: PlatformDeliveryReceipt) => void;
  readonly timer: NodeJS.Timeout;
}

export class NapCatActionClient implements PlatformReplySender {
  private readonly pending = new Map<string, PendingAction>();

  constructor(private readonly options: NapCatActionClientOptions) {
    subscribeToJsonMessages(options.transport, (message) => {
      this.handleJsonMessage(message);
    });
    options.transport.onClose((error) => {
      this.rejectAll(error?.message ?? "NapCat connection closed");
    });
  }

  async sendTextReply(
    target: PlatformMessageTarget,
    text: string,
  ): Promise<PlatformDeliveryReceipt> {
    const echo = this.options.nextEcho();
    const request = buildOneBotSendAction(target, text, echo);
    const receipt = new Promise<PlatformDeliveryReceipt>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        resolve({
          ok: false,
          adapterId: this.options.adapterId,
          platform: "qq",
          target,
          error: "NapCat action timed out",
        });
      }, this.options.timeoutMs);
      this.pending.set(echo, { target, resolve, timer });
    });
    this.options.transport.sendJson(request);
    return receipt;
  }

  private handleJsonMessage(message: unknown): void {
    if (typeof message !== "object" || message === null || !("echo" in message)) {
      return;
    }
    const echo = String((message as { echo: unknown }).echo);
    const pending = this.pending.get(echo);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(echo);
    clearTimeout(pending.timer);

    const body = message as {
      status?: unknown;
      data?: unknown;
      wording?: unknown;
      message?: unknown;
    };
    if (body.status === "ok") {
      const platformMessageId = extractMessageId(body.data);
      pending.resolve({
        ok: true,
        adapterId: this.options.adapterId,
        platform: "qq",
        target: pending.target,
        ...(platformMessageId === undefined ? {} : { platformMessageId }),
        raw: message,
      });
      return;
    }

    pending.resolve({
      ok: false,
      adapterId: this.options.adapterId,
      platform: "qq",
      target: pending.target,
      error: extractError(body),
      raw: message,
    });
  }

  private rejectAll(error: string): void {
    for (const [echo, pending] of this.pending) {
      this.pending.delete(echo);
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        adapterId: this.options.adapterId,
        platform: "qq",
        target: pending.target,
        error,
      });
    }
  }
}

function extractMessageId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("message_id" in data)) {
    return undefined;
  }
  const value = (data as { message_id: unknown }).message_id;
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

export interface NapCatOneBotAdapterOptions {
  readonly adapterId: string;
  readonly transport: JsonMessageTransport;
  readonly now: () => Date;
  readonly onInboundMessage: (message: PlatformInboundMessage) => Promise<void>;
}

export class NapCatOneBotAdapter {
  constructor(private readonly options: NapCatOneBotAdapterOptions) {
    subscribeToJsonMessages(options.transport, (message) => {
      void this.handleJsonMessage(message);
    });
  }

  async start(): Promise<void> {
    return undefined;
  }

  async stop(): Promise<void> {
    this.options.transport.close();
  }

  private async handleJsonMessage(message: unknown): Promise<void> {
    if (typeof message === "object" && message !== null && "echo" in message) {
      return;
    }
    const inbound = normalizeOneBotMessageEvent(message, {
      adapterId: this.options.adapterId,
      now: this.options.now,
    });
    if (inbound === undefined) {
      return;
    }
    await this.options.onInboundMessage(inbound);
  }
}

function extractError(body: { wording?: unknown; message?: unknown }): string {
  const wording = typeof body.wording === "string" ? body.wording.trim() : "";
  if (wording) {
    return wording;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  return message || "NapCat action failed";
}
