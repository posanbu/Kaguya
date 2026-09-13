/**
 * 功能概述：实现 NapCat/OneBot 的出站 action client 与入站 adapter，两者可安全
 * 共享一个 JSON transport；入站端只持有 `InformationIngress`，不接触 Runtime 其他能力。
 * listTargets 通过独立 echo 查询账号、群和好友列表，超时/断线/不完整响应失败关闭，不记录原始响应。
 * 主要职责：`NapCatActionClient.sendMessage` 编号 echo、匹配成功/失败回执、处理超时与断线；
 * `NapCatOneBotAdapter` 正规化 frame、过滤 self ID/action response、执行注入的入站谓词后
 * 调用 `ingress.submit`，
 * 并在 stop 时停止接收、关闭 transport、排空已提交任务。
 * 代码库关系：`onebot.ts` 提供正规化/action builder，Server `napcat.ts` 提供
 * WebSocket transport、窄 ingress 和日志；`types.ts` 定义入站与投递契约。
 * 输入输出与副作用：出站会写 JSON transport 并创建 timeout；入站提交
 * 异常通过可选 callback 报告，context 仅含 adapter ID 和外部 platform message ID。
 */
import { randomUUID } from "node:crypto";
import type {
  TargetDirectory,
  TargetDirectorySnapshot,
  ReachableTarget,
} from "./targets.js";
import type { OutboundMessageContent } from "@kaguya/schema";

import type {
  InformationIngress,
  PlatformInboundMessage,
  PlatformDeliveryReceipt,
  PlatformMessageTarget,
  PlatformOutboundTransport,
} from "./types.js";
import {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
} from "./onebot.js";

export interface JsonMessageTransport {
  sendJson(message: unknown): void;
  onJsonMessage(handler: (message: unknown) => void): void;
  onOpen?(handler: () => void): void;
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

export class NapCatActionClient
  implements PlatformOutboundTransport, TargetDirectory
{
  private readonly directoryGeneration = randomUUID();
  private readonly queries = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly pending = new Map<string, PendingAction>();

  constructor(private readonly options: NapCatActionClientOptions) {
    subscribeToJsonMessages(options.transport, (message) => {
      this.handleJsonMessage(message);
    });
    options.transport.onClose((error) => {
      for (const query of this.queries.values()) {
        clearTimeout(query.timer);
        query.reject(new Error("directory-unavailable"));
      }
      this.queries.clear();
      this.rejectAll(error?.message ?? "NapCat connection closed");
    });
  }

  /** 查询成功的完整群/好友目录；登录身份和连接 UUID 一起构成代次。 */
  async listTargets(): Promise<TargetDirectorySnapshot> {
    const [login, groups, friends] = await Promise.all([
      this.query("get_login_info"),
      this.query("get_group_list"),
      this.query("get_friend_list"),
    ]);
    const account = directoryId(record(login).user_id);
    if (
      !Array.isArray(groups) ||
      !Array.isArray(friends) ||
      groups.length + friends.length > 10000
    )
      throw new Error("directory-unavailable");
    const candidates: ReachableTarget[] = [
      ...groups.map((value) => {
        const row = record(value);
        return {
          adapterId: this.options.adapterId,
          platform: "qq",
          destination: {
            kind: "group" as const,
            groupId: directoryId(row.group_id),
          },
          name: directoryName(row.group_name),
        };
      }),
      ...friends.map((value) => {
        const row = record(value);
        return {
          adapterId: this.options.adapterId,
          platform: "qq",
          destination: {
            kind: "private" as const,
            userId: directoryId(row.user_id),
          },
          name: directoryName(row.remark || row.nickname),
        };
      }),
    ];
    return { generation: `${this.directoryGeneration}:${account}`, candidates };
  }

  private query(action: string): Promise<unknown> {
    const echo = `directory:${this.options.nextEcho()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queries.delete(echo);
        reject(new Error("directory-unavailable"));
      }, this.options.timeoutMs);
      this.queries.set(echo, { resolve, reject, timer });
      try {
        this.options.transport.sendJson({ action, params: {}, echo });
      } catch {
        clearTimeout(timer);
        this.queries.delete(echo);
        reject(new Error("directory-unavailable"));
      }
    });
  }

  async sendMessage(
    target: PlatformMessageTarget,
    message: OutboundMessageContent,
  ): Promise<PlatformDeliveryReceipt> {
    const echo = this.options.nextEcho();
    const request = buildOneBotSendAction(target, message, echo);
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
    if (
      typeof message !== "object" ||
      message === null ||
      !("echo" in message)
    ) {
      return;
    }
    const echo = String((message as { echo: unknown }).echo);
    const query = this.queries.get(echo);
    if (query) {
      this.queries.delete(echo);
      clearTimeout(query.timer);
      const response = record(message);
      if (
        response.status === "ok" &&
        (response.retcode === undefined || response.retcode === 0)
      )
        query.resolve(response.data);
      else query.reject(new Error("directory-unavailable"));
      return;
    }
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
  readonly expectedSelfId?: string;
  readonly transport: JsonMessageTransport;
  readonly now: () => Date;
  readonly ingress: InformationIngress;
  readonly allowsInbound?: (message: PlatformInboundMessage) => boolean;
  readonly onInboundError?: (
    error: unknown,
    context: NapCatInboundErrorContext,
  ) => void;
}

export interface NapCatInboundErrorContext {
  readonly adapterId: string;
  readonly platformMessageId: string;
}

export class NapCatOneBotAdapter {
  private readonly inFlight = new Set<Promise<void>>();
  private acceptingMessages = false;

  constructor(private readonly options: NapCatOneBotAdapterOptions) {
    subscribeToJsonMessages(options.transport, (message) => {
      this.handleJsonMessage(message);
    });
  }

  async start(): Promise<void> {
    this.acceptingMessages = true;
  }

  async stop(): Promise<void> {
    this.acceptingMessages = false;
    this.options.transport.close();
    await Promise.allSettled([...this.inFlight]);
  }

  private handleJsonMessage(message: unknown): void {
    if (!this.acceptingMessages) {
      return;
    }
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
    if (
      this.options.expectedSelfId !== undefined &&
      inbound.selfId !== this.options.expectedSelfId
    ) {
      return;
    }
    if (this.options.allowsInbound?.(inbound) === false) {
      return;
    }

    const dispatch = Promise.resolve()
      .then(() => this.options.ingress.submit(inbound))
      .then(() => undefined);
    let tracked: Promise<void>;
    tracked = dispatch
      .catch((error: unknown) => {
        try {
          this.options.onInboundError?.(error, {
            adapterId: this.options.adapterId,
            platformMessageId: inbound.platformMessageId,
          });
        } catch {
          // Error reporting must not create a second unhandled rejection.
        }
      })
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
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

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("directory-unavailable");
  return value as Record<string, unknown>;
}
function directoryId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
  throw new Error("directory-unavailable");
}
function directoryName(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000)
    throw new Error("directory-unavailable");
  return value;
}
