/**
 * 功能概述：验证开发者页面路由和浏览器只读 API 的认证、取消及 DTO 校验边界。
 * 主要职责：检查三个精确路径、GET/no-store/Bearer 参数、服务端不可用和无效响应；
 * 认证失败沿用全局锁屏事件，避免开发者视图保留上一轮已加载数据。
 * 代码库关系：调用 DeveloperConsole.tsx 的路由解析器与 api.ts 的 getInspection。
 * 输入输出与副作用：仅 mock fetch 和全局事件对象，每例恢复环境，无真实网络请求。
 */
import { afterEach, expect, it, vi } from "vitest";
import { inspectionPageSchema } from "@kaguya/schema";
import { developerPage } from "./DeveloperConsole.js";
import { getInspection, GATEWAY_UNAUTHORIZED_EVENT } from "./api.js";
afterEach(() => vi.unstubAllGlobals());
it("matches developer routes and rejects unrelated paths", () => {
  expect(developerPage("/developer/modules")).toBe("modules");
  expect(developerPage("/developer/atoms")).toBe("atoms");
  expect(developerPage("/developer/flows/")).toBe("flows");
  expect(developerPage("/developer")).toBe("modules");
  expect(developerPage("/developer/atoms/unsafe")).toBeUndefined();
  expect(developerPage("/settings")).toBeUndefined();
});
it("uses authenticated GET, no-store and cancellation with validated DTOs", async () => {
  const data = { version: 1, items: [], nextCursor: null, truncated: false };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data }));
  const signal = new AbortController().signal;
  await expect(
    getInspection(
      { token: "test-token" },
      "atoms?kind=example",
      inspectionPageSchema,
      signal,
      fetcher,
    ),
  ).resolves.toEqual(data);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/inspection/atoms?kind=example",
    expect.objectContaining({
      method: "GET",
      signal,
      cache: "no-store",
      headers: { authorization: "Bearer test-token" },
    }),
  );
});
it("rejects malformed DTOs and presents Runtime unavailable state", async () => {
  const signal = new AbortController().signal;
  await expect(
    getInspection(
      { token: "t" },
      "atoms",
      inspectionPageSchema,
      signal,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: { items: [] } })),
    ),
  ).rejects.toMatchObject({ code: "invalid_inspection" });
  await expect(
    getInspection(
      { token: "t" },
      "atoms",
      inspectionPageSchema,
      signal,
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "inspection_unavailable",
              message: "unavailable",
              requestId: "r",
            },
          },
          { status: 503 },
        ),
      ),
    ),
  ).rejects.toThrow("Runtime 尚未就绪");
});
it("locks the app on unauthorized inspection and rejects missing tokens locally", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({}, { status: 401 }));
  await expect(
    getInspection(
      { token: "t" },
      "atoms",
      inspectionPageSchema,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow();
  expect(dispatchEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: GATEWAY_UNAUTHORIZED_EVENT }),
  );
  fetcher.mockClear();
  await expect(
    getInspection(
      { token: "" },
      "atoms",
      inspectionPageSchema,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: "missing_token" });
  expect(fetcher).not.toHaveBeenCalled();
});
