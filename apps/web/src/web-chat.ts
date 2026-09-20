/**
 * 功能概述：提供 Web 私聊的浏览器会话标识、乐观消息合并及可取消的增量同步。
 * 主要职责：readConversationId/persistConversationId 仅持久化不含凭据的 UUID；
 * mergeChatMessages/acceptChatMessage 依据服务消息 ID 和用户消息 requestId 消除回显重复，
 * 保留失败草稿并优先使用持久化时间；startConversationPolling 顺序拉完分页，再每两秒读取增量。
 * 代码库关系：由 useWebChat.ts 消费，通过 api.ts 访问 /api/v1/messages；纯函数和可注入
 * 请求边界由 web-chat.test.ts 覆盖，React 组件不直接管理游标或网络重试。
 * 输入输出与副作用：localStorage 按 origin 保存当前 conversationId，禁用存储时退回内存；
 * 网络失败指数退避至三十秒，401 停止轮询，由 api.ts 触发既有锁屏。stop 同时取消网络与定时器，
 * 在途请求即使忽略取消也不能回填旧会话；hasMore 必须推进至少一类水位，避免错误响应无限请求。
 */
import {
  GatewayRequestError,
  getConversationMessages,
  type ConversationCursor,
  type ConversationMessage,
  type ConversationMessages,
  type GatewayConfig,
} from "./api.js";

export const CONVERSATION_STORAGE_KEY = "kaguya.web.conversationId";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POLL_INTERVAL = 2_000;

export interface ChatMessage extends ConversationMessage {
  readonly state: "sending" | "sent" | "failed";
  readonly local: boolean;
}

export function readConversationId(
  storage?: Pick<Storage, "getItem" | "setItem">,
): string {
  try {
    const saved = storage?.getItem(CONVERSATION_STORAGE_KEY);
    if (saved && UUID_PATTERN.test(saved)) return saved;
  } catch {
    // 私密模式或浏览器策略可能禁止存储，此时当前页面仍可正常聊天。
  }
  const id = crypto.randomUUID();
  persistConversationId(id, storage);
  return id;
}

export function persistConversationId(
  id: string,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    storage?.setItem(CONVERSATION_STORAGE_KEY, id);
  } catch {
    // 不让浏览器存储故障阻止发送消息。
  }
}

function consolidateMessages(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  const result: ChatMessage[] = [];
  const ids = new Map<string, number>();
  const userRequests = new Map<string, number>();
  for (const message of messages) {
    const index =
      ids.get(message.id) ??
      (message.role === "user" && message.requestId
        ? userRequests.get(message.requestId)
        : undefined) ??
      result.length;
    const previous = result[index];
    if (!previous) result.push(message);
    else if (previous.local || !message.local) result[index] = message;
    ids.set(message.id, index);
    if (message.role === "user" && message.requestId)
      userRequests.set(message.requestId, index);
  }
  return result.sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

export function mergeChatMessages(
  current: readonly ChatMessage[],
  received: readonly ConversationMessage[],
): readonly ChatMessage[] {
  return consolidateMessages([
    ...current,
    ...received.map((message): ChatMessage => ({
      ...message,
      state: "sent",
      local: false,
    })),
  ]);
}

export function acceptChatMessage(
  messages: readonly ChatMessage[],
  localId: string,
  requestId: string,
): readonly ChatMessage[] {
  return consolidateMessages(
    messages.map((message) =>
      message.id === localId
        ? { ...message, state: "sent", requestId }
        : message,
    ),
  );
}

export function chatErrorMessage(error: unknown): string {
  if (error instanceof GatewayRequestError) {
    if (error.status === 401) return "服务令牌已失效，请重新打开访问链接。";
    if (error.code === "invalid_chat_cursor") return "正在重新同步对话。";
    if (error.status === 503) return "聊天服务暂未就绪，正在重试。";
    if (error.code === "rate_limited") return "请求较多，稍后自动重试。";
    if (error.code === "network_error")
      return "与 Kaguya 的连接中断，正在重连。";
    return error.message;
  }
  return "暂时无法读取对话，正在重试。";
}

export function startConversationPolling(options: {
  readonly config: GatewayConfig;
  readonly conversationId: string;
  readonly onMessages: (messages: readonly ConversationMessage[]) => void;
  readonly onReady: () => void;
  readonly onError: (error: unknown) => void;
  readonly load?: typeof getConversationMessages;
}): {
  readonly signal: AbortSignal;
  readonly refresh: () => void;
  readonly stop: () => void;
} {
  const controller = new AbortController();
  const load = options.load ?? getConversationMessages;
  let cursor: ConversationCursor = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let refreshRequested = false;
  let failures = 0;

  const poll = async () => {
    if (controller.signal.aborted) return;
    if (running) {
      refreshRequested = true;
      return;
    }
    running = true;
    let delay = POLL_INTERVAL;
    let unauthorized = false;
    try {
      let page: ConversationMessages;
      do {
        page = await load(
          options.config,
          { conversationId: options.conversationId, cursor },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          page.hasMore &&
          page.cursor.inbound === cursor.inbound &&
          page.cursor.outbound === cursor.outbound
        ) {
          throw new GatewayRequestError(
            "对话同步暂时失败，正在重试。",
            "invalid_response",
            0,
          );
        }
        options.onMessages(page.messages);
        cursor = page.cursor;
      } while (page.hasMore);
      failures = 0;
      options.onReady();
    } catch (error) {
      if (controller.signal.aborted) return;
      unauthorized =
        error instanceof GatewayRequestError && error.status === 401;
      if (
        error instanceof GatewayRequestError &&
        error.code === "invalid_chat_cursor"
      )
        cursor = {};
      failures += 1;
      delay = Math.min(POLL_INTERVAL * 2 ** Math.min(failures, 4), 30_000);
      options.onError(error);
    } finally {
      running = false;
      if (!controller.signal.aborted && !unauthorized) {
        timer = setTimeout(
          () => {
            void poll();
          },
          refreshRequested && failures === 0 ? 0 : delay,
        );
        refreshRequested = false;
      }
    }
  };
  void poll();
  return {
    signal: controller.signal,
    refresh() {
      if (timer !== undefined) clearTimeout(timer);
      void poll();
    },
    stop() {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
