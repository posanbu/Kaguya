/**
 * 功能概述：以合成 DNS/HTTPS 验证媒体下载，不请求外部网络。
 * 主要职责：Resolver mock 使用明确的 resolve4 返回类型，避免 lookup 重载推断错误；
 * transport fixture 提供受控响应、连接销毁和请求开始边界，覆盖地址固定、拒绝重定向、
 * 字节限额、取消和 DNS/响应共享截止时间。迟到解析及响应在失败后不得改变结果或重发。
 * 代码库关系：直接调用 media-download 的生产 acquire，使用真实 EventEmitter 传递网络事件。
 * 输入输出与副作用：仅在测试进程中替换 DNS/HTTPS；每例先取消全部下载、释放 DNS barrier
 * 并等待 Promise 收敛，再恢复 timer/mock；请求启动与提前失败竞争，无真实服务或凭据。
 */
import { EventEmitter } from "node:events";
import { Resolver } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMediaDownloader,
  isPublicMediaAddress,
} from "./media-download.js";
import type { PlatformInboundMessage } from "@kaguya/platform-adapters";

const dns = vi.hoisted(() => ({
  answer: vi.fn<(host: string) => Promise<string[]>>(),
  instances: [] as { cancel: () => void }[],
  options: [] as unknown[],
}));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    cancel = vi.fn();
    resolve4 = (host: string) => dns.answer(host);
    constructor(options: unknown) {
      dns.instances.push(this);
      dns.options.push(options);
    }
  },
}));
vi.mock("node:https", () => ({ request: vi.fn() }));
const input = {} as PlatformInboundMessage;
const segment = (url = "https://images.example.com/a") => ({
  kind: "media" as const,
  position: 0,
  mediaType: "image" as const,
  source: { url },
});
const downloader = createMediaDownloader(["images.example.com"]);
const pendingOperations = new Set<Promise<Uint8Array | undefined>>();
const controllers = new Set<AbortController>();
const releaseDeferred: (() => void)[] = [];
const acquire: typeof downloader = (...args) => {
  const pending = downloader(...args);
  pendingOperations.add(pending);
  const release = () => pendingOperations.delete(pending);
  void pending.then(release, release);
  return pending;
};
function abortController() {
  const controller = new AbortController();
  controllers.add(controller);
  return controller;
}
async function started(
  transport: { entered: Promise<void> },
  pending: Promise<unknown>,
) {
  await Promise.race([
    transport.entered,
    pending.then(() => {
      throw new Error("Download completed before HTTPS request started");
    }),
  ]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  releaseDeferred.push(() => resolve(undefined as T));
  return { promise, resolve };
}
function transport() {
  const entered = deferred<void>();
  const req = Object.assign(new EventEmitter(), {
    destroy: vi.fn(() => {
      req.emit("close");
      return req;
    }),
    end: vi.fn(() => entered.resolve()),
  });
  let respond!: (response: IncomingMessage) => void;
  let options!: RequestOptions;
  let target!: URL;
  vi.mocked(request).mockImplementation((url, config, callback) => {
    if (!(url instanceof URL) || !callback)
      throw new Error("Unexpected HTTPS fixture signature");
    target = url;
    options = config;
    respond = callback;
    return req as unknown as ClientRequest;
  });
  return {
    req,
    entered: entered.promise,
    get options() {
      return options;
    },
    get target() {
      return target;
    },
    respond(statusCode = 200, headers: Record<string, string> = {}) {
      const res = Object.assign(new EventEmitter(), {
        statusCode,
        headers,
        complete: false,
        destroy: vi.fn(() => {
          res.emit("close");
          return res;
        }),
      });
      respond(res as unknown as IncomingMessage);
      return res;
    },
  };
}
function complete(
  res: ReturnType<ReturnType<typeof transport>["respond"]>,
  bytes: Uint8Array,
) {
  res.emit("data", Buffer.from(bytes));
  res.complete = true;
  res.emit("end");
  res.emit("close");
}

beforeEach(() => {
  vi.resetAllMocks();
  dns.instances.length = 0;
  dns.options.length = 0;
  dns.answer.mockResolvedValue(["8.8.8.8"]);
});
afterEach(async () => {
  try {
    for (const controller of controllers) controller.abort();
    for (const release of releaseDeferred.splice(0)) release();
    await Promise.allSettled([...pendingOperations]);
  } finally {
    controllers.clear();
    pendingOperations.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "172.16.1.2",
  "192.168.1.1",
  "100.64.0.1",
  "198.18.0.1",
  "224.0.0.1",
  "::1",
  "0.0.0.0",
  "192.0.0.1",
  "192.0.2.1",
  "198.51.100.1",
  "203.0.113.1",
  "192.88.99.1",
  "8.8..8",
  "8.8.1e0.8",
])("rejects nonpublic or noncanonical %s", (address) =>
  expect(isPublicMediaAddress(address)).toBe(false),
);
it.each(["8.8.8.8", "1.1.1.1", "192.0.78.24"])("accepts public %s", (address) =>
  expect(isPublicMediaAddress(address)).toBe(true),
);

it("never resolves unapproved hosts, credentials or non-HTTPS URLs", async () => {
  for (const url of [
    "file:///etc/hosts",
    "http://images.example.com/a",
    "https://other.example.com/a",
    "https://secret@images.example.com/a",
    "https://images.example.com:444/a",
    "https://images.example.com/a#fragment",
    "https://images.example.com.attacker.example/a",
  ])
    expect(
      await acquire(segment(url), input, abortController().signal),
    ).toBeUndefined();
  expect(dns.instances).toHaveLength(0);
  expect(request).not.toHaveBeenCalled();
});
it.each(
  [[], ["127.0.0.1"], ["8.8.8.8", "10.0.0.1"], ["::ffff:127.0.0.1"]].map(
    (answers) => ({ answers }),
  ),
)("denies empty or mixed/private DNS answers %j", async ({ answers }) => {
  dns.answer.mockResolvedValue(answers);
  await expect(
    acquire(segment(), input, abortController().signal),
  ).rejects.toThrow("media-download-address-denied");
  expect(request).not.toHaveBeenCalled();
  expect(dns.instances[0]!.cancel).toHaveBeenCalledOnce();
});
it("pins the approved answer for both Node lookup modes and retains the TLS hostname", async () => {
  const t = transport();
  const pending = acquire(segment(), input, abortController().signal);
  await started(t, pending);
  dns.answer.mockResolvedValue(["127.0.0.1"]);
  expect(t.options.agent).toBe(false);
  expect(t.target.hostname).toBe("images.example.com");
  const one = vi.fn();
  t.options.lookup!("images.example.com", {}, one);
  expect(one).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  const all = vi.fn();
  t.options.lookup!("images.example.com", { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  expect(dns.answer).toHaveBeenCalledTimes(1);
  complete(t.respond(), Buffer.from("image-bytes"));
  expect(Buffer.from((await pending)!)).toEqual(Buffer.from("image-bytes"));
  expect(t.req.destroy).not.toHaveBeenCalled();
  expect(dns.options).toEqual([{ timeout: 5000, tries: 1 }]);
});
it.each([301, 302, 307, 308, 404, 413])(
  "rejects HTTP %s without following its location",
  async (status) => {
    const t = transport();
    const pending = acquire(segment(), input, abortController().signal);
    const rejected = expect(pending).rejects.toThrow("media-download-failed");
    await started(t, pending);
    const res = t.respond(status, { location: "https://127.0.0.1/private" });
    await rejected;
    expect(res.destroy).toHaveBeenCalledOnce();
    expect(t.req.destroy).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  },
);
it.each([
  { "content-length": String(10 * 1024 * 1024 + 1) },
  { "content-length": "garbage" },
  { "content-length": "-1" },
  { "content-encoding": "gzip" },
])("rejects invalid/oversized response headers %j", async (headers) => {
  const t = transport();
  const pending = acquire(segment(), input, abortController().signal);
  const rejected = expect(pending).rejects.toThrow("media-download-failed");
  await started(t, pending);
  t.respond(200, headers);
  await rejected;
  expect(t.req.destroy).toHaveBeenCalledOnce();
});
it("bounds chunked bodies and ignores late successful end after overflow", async () => {
  const t = transport();
  const pending = acquire(segment(), input, abortController().signal);
  const rejected = expect(pending).rejects.toThrow("media-download-failed");
  await started(t, pending);
  const res = t.respond();
  res.emit("data", Buffer.alloc(10 * 1024 * 1024));
  expect(t.req.destroy).not.toHaveBeenCalled();
  complete(res, Buffer.from("x"));
  await rejected;
  expect(t.req.destroy).toHaveBeenCalledOnce();
});
it("accepts the exact byte limit and rejects an empty or truncated body", async () => {
  const t = transport();
  let pending = acquire(segment(), input, abortController().signal);
  await started(t, pending);
  complete(
    t.respond(200, { "content-length": String(10 * 1024 * 1024) }),
    Buffer.alloc(10 * 1024 * 1024),
  );
  expect((await pending)?.byteLength).toBe(10 * 1024 * 1024);
  for (const [length, bytes, code] of [
    ["0", "", "media-download-empty"],
    ["10", "short", "media-download-failed"],
  ]) {
    const current = transport();
    pending = acquire(segment(), input, abortController().signal);
    const rejected = expect(pending).rejects.toThrow(code!);
    await started(current, pending);
    complete(
      current.respond(200, { "content-length": length! }),
      Buffer.from(bytes!),
    );
    await rejected;
  }
});
it("cancels a stalled DNS lookup and never requests a late answer", async () => {
  const answer = deferred<string[]>();
  dns.answer.mockReturnValue(answer.promise);
  const controller = abortController();
  const pending = acquire(segment(), input, controller.signal);
  const rejected = expect(pending).rejects.toThrow("media-download-aborted");
  expect(dns.answer).toHaveBeenCalledOnce();
  controller.abort("private-cancellation-reason");
  await rejected;
  expect(dns.instances[0]!.cancel).toHaveBeenCalledOnce();
  answer.resolve(["8.8.8.8"]);
  await answer.promise;
  expect(request).not.toHaveBeenCalled();
});
it("covers DNS and HTTP with one deadline rather than resetting after resolution", async () => {
  vi.useFakeTimers();
  const t = transport();
  const answer = deferred<string[]>();
  dns.answer.mockReturnValue(answer.promise);
  const pending = acquire(segment(), input, abortController().signal);
  const rejected = expect(pending).rejects.toThrow("media-download-timeout");
  await vi.advanceTimersByTimeAsync(4500);
  answer.resolve(["8.8.8.8"]);
  await started(t, pending);
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  expect(t.req.destroy).toHaveBeenCalledOnce();
  expect(dns.instances[0]!.cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("times out stalled DNS and blocks its later answer", async () => {
  vi.useFakeTimers();
  const answer = deferred<string[]>();
  dns.answer.mockReturnValue(answer.promise);
  const pending = acquire(segment(), input, abortController().signal);
  const rejected = expect(pending).rejects.toThrow("media-download-timeout");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  answer.resolve(["8.8.8.8"]);
  await answer.promise;
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("aborts active transfer, removes listeners and isolates other resolvers", async () => {
  const t = transport();
  const controller = abortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = acquire(segment(), input, controller.signal);
  const rejected = expect(pending).rejects.toThrow("media-download-aborted");
  await started(t, pending);
  const res = t.respond();
  const other = new Resolver();
  controller.abort();
  await rejected;
  complete(res, Buffer.from("late"));
  expect(res.destroy).toHaveBeenCalledOnce();
  expect(t.req.destroy).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(other.cancel).not.toHaveBeenCalled();
});
it("rejects aborted calls before DNS and sanitizes DNS/response errors", async () => {
  const controller = abortController();
  controller.abort("secret");
  await expect(acquire(segment(), input, controller.signal)).rejects.toThrow(
    "media-download-aborted",
  );
  expect(dns.answer).not.toHaveBeenCalled();
  dns.answer.mockRejectedValueOnce(new Error("private URL and DNS detail"));
  await expect(
    acquire(segment(), input, abortController().signal),
  ).rejects.toThrow(/^media-download-failed$/u);
  const t = transport();
  const pending = acquire(segment(), input, abortController().signal);
  const rejected = expect(pending).rejects.toThrow(/^media-download-failed$/u);
  await started(t, pending);
  const res = t.respond();
  res.emit("aborted");
  await rejected;
  expect(t.req.destroy).toHaveBeenCalledOnce();
});
