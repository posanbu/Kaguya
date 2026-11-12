/**
 * 功能概述：验证 GUI 浏览器边界的认证、只读查询、原 UUID 和结构化错误。
 * 受控 fetch 仅检查正式 wire 请求与响应解析，不冒充 broker、物理桌面或模型执行。
 * 所有 Promise 显式等待，afterEach 恢复全局替身，无计时器、固定 sleep 或后台任务。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  environmentRequest,
  environmentPath,
  guiTaskSchema,
  readEnvironmentImage,
} from "./environment-api.js";
import { GatewayRequestError, GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
afterEach(() => vi.unstubAllGlobals());
const taskRequestId = "10ba8bfc-1e00-4d0e-a182-46f7983c0b47";
const task = {
  taskRequestId,
  environmentId: "env",
  requestedInformationId: "source-id",
  runInformationId: null,
  status: "queued",
  terminal: null,
  cancellation: null,
};
describe("GUI 管理 wire", () => {
  it("只读刷新用原任务 UUID，Bearer 仅在 header，no-store 保留", async () => {
    const fetch = vi.fn(async () => Response.json(task));
    vi.stubGlobal("fetch", fetch);
    expect(
      await environmentRequest(
        "secret",
        environmentPath("env", `tasks/${taskRequestId}`),
        guiTaskSchema,
        new AbortController().signal,
      ),
    ).toEqual(task);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(`/api/v1/environments/env/tasks/${taskRequestId}`);
    expect(path).not.toContain("secret");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe("no-store");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret" });
  });
  it("提交保留用户 UUID；409 不自动再造 ID 或重复 POST", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "gui-task-id-conflict" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      environmentRequest(
        "secret",
        environmentPath("env", "tasks"),
        guiTaskSchema,
        new AbortController().signal,
        { taskRequestId, prompt: "test goal" },
      ),
    ).rejects.toMatchObject({ status: 409, code: "gui-task-id-conflict" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    ).toBe(JSON.stringify({ taskRequestId, prompt: "test goal" }));
  });
  it("401 在消费正文之前锁屏，图片也使用同一认证边界", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unreadable", { status: 401 })),
    );
    await expect(
      readEnvironmentImage(
        "secret",
        "env",
        "image/id",
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(GatewayRequestError);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: GATEWAY_UNAUTHORIZED_EVENT }),
    );
  });
  it("ignores a late 401 after the caller has cancelled its authenticated image read", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        return new Response("", { status: 401 });
      }),
    );
    await expect(
      readEnvironmentImage("old-session", "env", "image", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it("实际终态与取消转发分开解析，尚无 run 的失败终态保持 null", () => {
    const value = guiTaskSchema.parse({
      ...task,
      status: "failed",
      terminal: {
        status: "failed",
        reason: "execution-exhausted",
        runInformationId: null,
        output: null,
      },
      cancellation: {
        state: "forwarded",
        requestedInformationId: "cancel-source",
      },
    });
    expect(value.status).toBe("failed");
    expect(value.cancellation?.state).toBe("forwarded");
    expect(value.terminal?.runInformationId).toBeNull();
  });
});
