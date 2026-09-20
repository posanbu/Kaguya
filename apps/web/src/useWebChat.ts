/**
 * 功能概述：将 Web 私聊的会话生命周期和 React 视图连接，保持历史恢复与乐观发送一致。
 * 主要职责：useWebChat 加载 origin 内保存的会话 UUID，挂载时启动双向消息增量同步，
 * send 为每次提交预分配 requestId 并合并服务确认；newConversation 切换到全新 UUID。
 * 代码库关系：由 WebChat.tsx 使用，依赖 web-chat.ts 的合并/轮询和 api.ts 的发送接口；
 * Gateway token 仅作为内存参数，绝不写入 localStorage。
 * 输入输出与副作用：会话切换、页面离开和组件卸载都会取消在途读写；未确认消息保留文本并可重新发送，
 * 不自动重发 POST，避免重复对话。发送和历史读取共用一处错误反馈，读取恢复不会清除发送失败。
 */
import { useEffect, useRef, useState } from "react";
import { sendMessage } from "./api.js";
import {
  acceptChatMessage,
  chatErrorMessage,
  mergeChatMessages,
  persistConversationId,
  readConversationId,
  startConversationPolling,
  type ChatMessage,
} from "./web-chat.js";

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function useWebChat(token: string) {
  const [conversationId, setConversationId] = useState(() =>
    readConversationId(browserStorage()),
  );
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<{
    source: "history" | "send";
    text: string;
    requestId?: string;
  }>();
  const sessionRef = useRef<
    | {
        conversationId: string;
        polling: ReturnType<typeof startConversationPolling>;
        sending: boolean;
        confirmedRequestIds: Set<string>;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    setMessages([]);
    setIsLoading(true);
    setHistoryReady(false);
    setError(undefined);
    setIsSending(false);
    const confirmedRequestIds = new Set<string>();
    const polling = startConversationPolling({
      config: { token },
      conversationId,
      onMessages: (received) => {
        for (const message of received) {
          if (message.role === "user" && message.requestId)
            confirmedRequestIds.add(message.requestId);
        }
        setMessages((current) => mergeChatMessages(current, received));
        setError((current) =>
          current?.requestId && confirmedRequestIds.has(current.requestId)
            ? undefined
            : current,
        );
      },
      onReady: () => {
        setIsLoading(false);
        setHistoryReady(true);
        setError((current) =>
          current?.source === "history" ? undefined : current,
        );
      },
      onError: (reason) => {
        setIsLoading(false);
        setError((current) =>
          current?.source === "send"
            ? current
            : { source: "history", text: chatErrorMessage(reason) },
        );
      },
    });
    const session = {
      conversationId,
      polling,
      sending: false,
      confirmedRequestIds,
    };
    sessionRef.current = session;
    return () => {
      polling.stop();
      if (sessionRef.current === session) sessionRef.current = undefined;
    };
  }, [token, conversationId]);

  const send = async (text: string, retryId?: string): Promise<void> => {
    const session = sessionRef.current;
    if (!session || session.sending || !text.trim()) return;
    session.sending = true;
    setIsSending(true);
    const id = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const pending: ChatMessage = {
      id,
      role: "user",
      text,
      requestId,
      createdAt: new Date().toISOString(),
      state: "sending",
      local: true,
    };
    setMessages((current) => [
      ...current.filter((message) => message.id !== retryId),
      pending,
    ]);
    setError((current) => (current?.source === "send" ? undefined : current));
    try {
      const accepted = await sendMessage(
        { token },
        { text, conversationId: session.conversationId },
        fetch,
        { signal: session.polling.signal, requestId },
      );
      if (sessionRef.current !== session || session.polling.signal.aborted)
        return;
      setMessages((current) =>
        acceptChatMessage(current, id, accepted.requestId),
      );
      session.polling.refresh();
    } catch (reason) {
      if (sessionRef.current !== session || session.polling.signal.aborted)
        return;
      if (session.confirmedRequestIds.has(requestId)) return;
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, state: "failed" } : message,
        ),
      );
      setError({
        source: "send",
        requestId,
        text: `未能确认发送结果。${chatErrorMessage(reason).replace(/，正在重连。|，正在重试。|，稍后自动重试。/u, "，可重新发送。")}`,
      });
    } finally {
      session.sending = false;
      if (sessionRef.current === session) setIsSending(false);
    }
  };

  const newConversation = () => {
    sessionRef.current?.polling.stop();
    sessionRef.current = undefined;
    const id = crypto.randomUUID();
    persistConversationId(id, browserStorage());
    setMessages([]);
    setError(undefined);
    setIsLoading(true);
    setHistoryReady(false);
    setIsSending(false);
    setConversationId(id);
  };

  return {
    messages,
    isLoading,
    historyReady,
    error: error?.text,
    isSending,
    send,
    newConversation,
    refresh: () => sessionRef.current?.polling.refresh(),
  };
}
