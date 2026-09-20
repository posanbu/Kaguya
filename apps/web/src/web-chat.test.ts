/**
 * 功能概述：验证 Web 私聊恢复、乐观消息去重以及增量同步的竞态和取消边界。
 * 主要职责：覆盖历史先于 POST 确认、助手多条回复、分页水位、并发刷新、断线退避和 401 停止。
 * 代码库关系：直接测试 web-chat.ts 的纯函数与可注入读取接口，不依赖 DOM、模型或真实服务。
 * 输入输出与副作用：网络使用可控 Promise，调度使用假时钟；每项测试均停止轮询并恢复时钟，
 * 断言真实回调/请求数量和 AbortSignal，而非固定休眠等待。会话存储只使用内存模拟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayRequestError,
  type ConversationMessages,
  type getConversationMessages,
} from "./api.js";
import {
  acceptChatMessage,
  CONVERSATION_STORAGE_KEY,
  mergeChatMessages,
  readConversationId,
  startConversationPolling,
  type ChatMessage,
} from "./web-chat.js";

const conversationId = "7fbad7c9-5998-421d-9608-a6cfb5ed9bdc";
const user = {
  id: "inbound-1",
  role: "user" as const,
  text: "你好",
  createdAt: "2026-09-19T00:00:01.000Z",
  requestId: "request-1",
};
const assistant = {
  id: "outbound-1",
  role: "assistant" as const,
  text: "你好！",
  createdAt: "2026-09-19T00:00:02.000Z",
  requestId: "request-1",
};
const pending: ChatMessage = {
  ...user,
  id: "local-1",
  state: "sending",
  local: true,
};
const emptyPage: ConversationMessages = {
  conversationId,
  messages: [],
  cursor: {},
  hasMore: false,
};

describe("Web conversation identity and reconciliation", () => {
  it("reuses only a valid UUID and stores no credentials", () => {
    const storage = { getItem: vi.fn(() => conversationId), setItem: vi.fn() };
    expect(readConversationId(storage)).toBe(conversationId);
    expect(storage.getItem).toHaveBeenCalledWith(CONVERSATION_STORAGE_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.getItem.mockReturnValue("invalid-id");
    const replacement = readConversationId(storage);
    expect(replacement).toMatch(/^[0-9a-f-]{36}$/u);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      CONVERSATION_STORAGE_KEY,
      replacement,
    );
  });

  it("still creates a usable conversation when browser storage is blocked", () => {
    expect(
      readConversationId({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("merges a persisted echo before the POST completes without losing assistant replies", () => {
    const hydrated = mergeChatMessages([pending], [assistant, user]);
    const accepted = acceptChatMessage(hydrated, pending.id, "request-1");
    expect(accepted).toEqual([
      { ...user, state: "sent", local: false },
      { ...assistant, state: "sent", local: false },
    ]);
    expect(mergeChatMessages(accepted, [user, assistant])).toEqual(accepted);
  });

  it("reconciles a different returned request ID while preserving the persisted record", () => {
    const hydrated = mergeChatMessages(
      [{ ...pending, requestId: "client-request" }],
      [user],
    );
    expect(hydrated).toHaveLength(2);
    expect(acceptChatMessage(hydrated, pending.id, "request-1")).toEqual([
      { ...user, state: "sent", local: false },
    ]);
  });

  it("keeps separate assistant messages from one request and unrelated failed submissions", () => {
    const failed: ChatMessage = {
      ...pending,
      id: "failed",
      requestId: "other-request",
      state: "failed",
    };
    expect(
      mergeChatMessages(
        [failed],
        [user, assistant, { ...assistant, id: "outbound-2" }],
      ),
    ).toHaveLength(4);
  });
});

describe("Web conversation polling", () => {
  const active: ReturnType<typeof startConversationPolling>[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const polling of active.splice(0)) polling.stop();
    vi.useRealTimers();
  });
  const start = (load: typeof getConversationMessages) => {
    const callbacks = {
      onMessages: vi.fn(),
      onReady: vi.fn(),
      onError: vi.fn(),
    };
    const polling = startConversationPolling({
      config: { token: "test-token" },
      conversationId,
      load,
      ...callbacks,
    });
    active.push(polling);
    return { ...polling, ...callbacks };
  };

  it("drains both message cursors before beginning the two-second poll interval", async () => {
    const load = vi
      .fn<typeof getConversationMessages>()
      .mockResolvedValueOnce({
        ...emptyPage,
        messages: [user],
        cursor: { inbound: "1" },
        hasMore: true,
      })
      .mockResolvedValue({
        ...emptyPage,
        messages: [assistant],
        cursor: { inbound: "1", outbound: "1" },
      });
    const polling = start(load);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[1]).toEqual({
      conversationId,
      cursor: { inbound: "1" },
    });
    expect(polling.onMessages.mock.calls).toEqual([[[user]], [[assistant]]]);
    expect(polling.onReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls[2]?.[1]).toEqual({
      conversationId,
      cursor: { inbound: "1", outbound: "1" },
    });
  });

  it("coalesces refreshes instead of racing an in-flight history request", async () => {
    let resolve!: (value: ConversationMessages) => void;
    const load = vi
      .fn<typeof getConversationMessages>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(emptyPage);
    const polling = start(load);
    polling.refresh();
    polling.refresh();
    expect(load).toHaveBeenCalledOnce();
    resolve(emptyPage);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("aborts on departure and ignores late results even when fetch does not reject", async () => {
    let resolve!: (value: ConversationMessages) => void;
    const load = vi.fn<typeof getConversationMessages>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const polling = start(load);
    polling.stop();
    expect(load.mock.calls[0]?.[2].aborted).toBe(true);
    resolve({ ...emptyPage, messages: [assistant] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polling.onMessages).not.toHaveBeenCalled();
    expect(polling.onReady).not.toHaveBeenCalled();
    expect(polling.onError).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
  });

  it("backs off failed reads and returns to normal polling after recovery", async () => {
    const load = vi
      .fn<typeof getConversationMessages>()
      .mockRejectedValueOnce(
        new GatewayRequestError("offline", "network_error", 0),
      )
      .mockResolvedValue(emptyPage);
    const polling = start(load);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(load).toHaveBeenCalledOnce();
    expect(polling.onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(polling.onReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("stops after unauthorized and guards against a non-advancing page", async () => {
    const unauthorized = vi
      .fn<typeof getConversationMessages>()
      .mockRejectedValue(
        new GatewayRequestError("unauthorized", "unauthorized", 401),
      );
    const locked = start(unauthorized);
    const brokenPage = vi
      .fn<typeof getConversationMessages>()
      .mockResolvedValue({ ...emptyPage, hasMore: true });
    const broken = start(brokenPage);
    await vi.advanceTimersByTimeAsync(0);
    expect(locked.onError).toHaveBeenCalledOnce();
    expect(broken.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_response" }),
    );
    expect(brokenPage).toHaveBeenCalledOnce();
    broken.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});
