/**
 * 功能概述：本测试文件钉住 WebUI 顶层状态机里的两个关键回归点，
 * 避免 Profile 管理视图被错误地跳过，或在 token/profile 切换时因为
 * 过期请求而让编辑器永久停留在 loading 状态。
 * 主要职责：验证匿名 readiness 为 `setup_required` 时仍然进入
 * Profile 管理页；验证清空已加载 Profile 的辅助逻辑会同时关闭
 * `loadingProfile`，从而为后续重新加载或留在未鉴权占位态留下正确状态。
 * 代码库关系：该文件直接保护 `apps/web/src/App.tsx` 中的纯状态辅助函数，
 * 不依赖真实 DOM 或网络请求；它补足 Task 7 对顶层状态迁移的单元回归覆盖。
 * 输入输出与副作用：全部断言发生在内存中；若视图映射或清理状态被改坏，
 * 这里会先于手工点页面发现问题。
 */
import { describe, expect, it } from "vitest";

import {
  clearLoadedProfileStateSnapshot,
  deriveConfigurationView,
  readRegistryMetadata,
  readBootstrapToken,
} from "./App.js";

describe("readBootstrapToken", () => {
  it("reads the one-time bootstrap token from the setup URL fragment", () => {
    expect(readBootstrapToken("#bootstrapToken=bootstrap-secret")).toBe(
      "bootstrap-secret",
    );
  });
});

describe("deriveConfigurationView", () => {
  it("routes setup_required into profile management instead of chat", () => {
    expect(
      deriveConfigurationView(
        {
          status: "setup_required",
          selectedProfileId: "default",
          profiles: [],
        },
        "checking",
        false,
      ),
    ).toBe("profiles");
  });
});

describe("clearLoadedProfileStateSnapshot", () => {
  it("drops the loading flag while clearing stale loaded profile state", () => {
    expect(
      clearLoadedProfileStateSnapshot({
        requestSequence: 3,
        loadingProfile: true,
        showApiKey: true,
      }),
    ).toEqual({
      requestSequence: 4,
      loadingProfile: false,
      loadedProfile: undefined,
      editorFields: undefined,
      showApiKey: false,
    });
  });
});

describe("readRegistryMetadata", () => {
  it("returns the explicit selected profile metadata from setup status", () => {
    expect(
      readRegistryMetadata({
        status: "ready",
        selectedProfileId: "default",
        profiles: [
          {
            id: "default",
            name: "default",
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        issues: [],
        warnings: [],
      }),
    ).toEqual({
      selectedProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "default",
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    });
  });

  it("rejects setup status that omits registry metadata", () => {
    expect(() =>
      readRegistryMetadata({
        status: "restart_required",
      } as unknown as Parameters<typeof readRegistryMetadata>[0]),
    ).toThrow("Configuration status is missing profile registry metadata");
  });
});
