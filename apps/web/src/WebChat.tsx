/**
 * 功能概述：承载 WebUI 的双向私聊界面，沿用工作台主题和固定输入区。
 * 主要职责：WebChat 展示历史恢复、用户/助手消息与未确认消息的重新发送；新对话创建独立会话，
 * 输入保留 Enter 发送、Shift+Enter 换行、中文输入法保护与 Unicode 字数上限。
 * 代码库关系：App.tsx 仅在消息路由挂载本组件并持有 draft，onDraftChange 同步编辑以保留导航前草稿；
 * useWebChat 管理会话和网络状态；components/ui.tsx 提供标题、按钮与单一错误反馈。
 * 输入输出与副作用：回复以完整消息同步，不模拟逐字生成；仅位于底部或主动发送时跟随
 * 新消息，避免阅读历史被打断；hook 负责取消聊天读写。
 */
import { LoaderCircle, Plus, SendHorizontal } from "lucide-react";
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { MAX_MESSAGE_LENGTH } from "./api.js";
import { Button, FieldMessage, PageHeader } from "./components/ui.js";
import { useWebChat } from "./useWebChat.js";

export function WebChat({
  token,
  draft,
  onDraftChange: setDraft,
}: {
  readonly token: string;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
}) {
  const chat = useWebChat(token);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const draftLength = [...draft].length;
  const canSend =
    !chat.isSending &&
    draft.trim().length > 0 &&
    draftLength <= MAX_MESSAGE_LENGTH;

  useEffect(() => {
    const list = messageListRef.current;
    if (list && followLatestRef.current) list.scrollTop = list.scrollHeight;
  }, [chat.messages]);

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const text = draft;
    followLatestRef.current = true;
    setDraft("");
    await chat.send(text);
    textareaRef.current?.focus();
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submitMessage();
    }
  };

  return (
    <div className="app-shell message-page">
      <PageHeader
        title="消息"
        actions={
          <Button
            onClick={() => {
              chat.newConversation();
              setDraft("");
              followLatestRef.current = true;
              textareaRef.current?.focus();
            }}
            disabled={chat.isSending}
            title="开始独立的新对话"
          >
            <Plus size={15} aria-hidden="true" />
            新对话
          </Button>
        }
      />
      <main className="workspace wb-message-workspace" aria-label="消息会话">
        <section className="chat-panel" aria-label="与 Kaguya 对话">
          <div
            ref={messageListRef}
            className="message-list"
            role="log"
            aria-label="消息记录"
            aria-busy={chat.isLoading}
            onScroll={(event) => {
              const list = event.currentTarget;
              followLatestRef.current =
                list.scrollHeight - list.scrollTop - list.clientHeight < 48;
            }}
          >
            {chat.messages.length === 0 ? (
              <div className="empty-state">
                {chat.isLoading && (
                  <LoaderCircle className="spin" size={20} aria-hidden="true" />
                )}
                <p>
                  {chat.isLoading
                    ? "正在加载对话…"
                    : chat.historyReady
                      ? "和 Kaguya 聊聊"
                      : "对话加载失败"}
                </p>
              </div>
            ) : (
              chat.messages.map((message) => (
                <article
                  className={`message-row message-row-${message.role}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <strong>
                      {message.role === "assistant" ? "Kaguya" : "你"}
                    </strong>
                    <time
                      dateTime={message.createdAt}
                      title={new Date(message.createdAt).toLocaleString(
                        "zh-CN",
                      )}
                    >
                      {new Intl.DateTimeFormat("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(message.createdAt))}
                    </time>
                  </div>
                  <p className="message-body">{message.text}</p>
                  {message.state === "sending" && (
                    <p className="delivery-status sending" role="status">
                      <LoaderCircle
                        className="spin"
                        size={13}
                        aria-hidden="true"
                      />
                      发送中
                    </p>
                  )}
                  {message.state === "failed" && (
                    <div className="delivery-status failed">
                      <span>发送未确认</span>
                      <Button
                        className="message-retry"
                        disabled={chat.isSending}
                        onClick={() => {
                          followLatestRef.current = true;
                          void chat.send(message.text, message.id);
                        }}
                      >
                        重新发送
                      </Button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
          <form
            className="composer"
            onSubmit={(event) => void submitMessage(event)}
          >
            {chat.error && (
              <FieldMessage tone="error">{chat.error}</FieldMessage>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={3}
              placeholder="输入消息"
              aria-label="消息内容"
              aria-describedby="composer-hint"
            />
            <div className="composer-footer">
              <span className="composer-hint" id="composer-hint">
                Enter 发送 · Shift + Enter 换行
              </span>
              {draftLength >= MAX_MESSAGE_LENGTH * 0.9 && (
                <span
                  className={
                    draftLength > MAX_MESSAGE_LENGTH
                      ? "limit exceeded"
                      : "limit"
                  }
                  role="status"
                >
                  {draftLength.toLocaleString()} /{" "}
                  {MAX_MESSAGE_LENGTH.toLocaleString()}
                </span>
              )}
              <Button
                className="send-button"
                variant="primary"
                type="submit"
                disabled={!canSend}
              >
                {chat.isSending ? (
                  <LoaderCircle className="spin" size={18} aria-hidden="true" />
                ) : (
                  <SendHorizontal size={18} aria-hidden="true" />
                )}
                <span>{chat.isSending ? "发送中" : "发送"}</span>
              </Button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
