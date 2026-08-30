/**
 * 架构说明：本测试文件钉住 Web 端对 Kaguya HTTP API 的客户端契约，
 * 让六个 Profile 路由、匿名 setup 状态与鉴权失败前置校验都以真实
 * 请求形态被验证。它是 `apps/web/src/api.ts` 的守门测试，确保这里
 * 只发出显式 URL、方法、Bearer 头和 JSON body，而不会偷偷回退到旧的
 * setup 聚合写接口或在浏览器端泄漏 Profile 密钥。
 * 主要职责：验证 `getConfigurationStatus`、`listProfiles`、`createProfile`、
 * `getProfile`、`replaceProfile`、`selectProfile` 与 `deleteProfile` 的精确
 * 请求拼装和响应解包；同时确认空 token 会在本地直接拒绝，且匿名 setup
 * 状态可以携带 selected Profile 元数据而不暴露 secret。
 * 代码库关系：该文件只依赖 Web API 客户端实现，不触碰 UI 组件；它与
 * `profile-editor.test.ts` 一起构成 Task 6 的红灯，后续实现必须保持这些
 * 请求形状不变，供 Task 7 的页面动作复用。
 * 输入输出与副作用：所有测试都使用注入的 `fetch` mock，因此不会真正
 * 访问网络；若客户端遗漏编码、认证头、content-type 或错误处理，这里会
 * 立即失败。
 */
import { describe, expect, it, vi } from "vitest";

import {
  checkGatewayHealth,
  createProfile,
  deleteProfile,
  GatewayRequestError,
  getConfigurationStatus,
  getProfile,
  listProfiles,
  replaceProfile,
  selectProfile,
  sendMessage,
} from "./api.js";

const config = {
  token: "test-gateway-token",
};

const replacement = {
  name: "work",
  ai: {
    defaultProviderId: "default-provider",
    modelTiers: {
      light: { providerId: "default-provider", modelId: "light-model" },
      heavy: { providerId: "default-provider", modelId: "heavy-model" },
    },
    providers: [
      {
        id: "default-provider",
        type: "openai-compatible",
        enabled: true,
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        models: ["light-model", "heavy-model"],
        settings: { nested: { keep: true } },
      },
      {
        id: "secondary-provider",
        type: "anthropic-compatible",
        enabled: false,
        models: ["claude-opus"],
        settings: { nested: { keep: "secondary" } },
      },
    ],
  },
  platforms: [
    {
      id: "qq",
      type: "qq",
      enabled: true,
      credentials: { token: "platform-secret" },
      settings: { nested: { keep: true } },
    },
  ],
  plugins: [
    {
      id: "plugin-1",
      enabled: true,
      settings: { nested: { keep: true } },
    },
  ],
  acknowledgedWarnings: ["platforms-empty", "plugins-empty"],
} as const;

describe("sendMessage", () => {
  it("sends the gateway message contract and returns the request id", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { data: { status: "accepted", requestId: "request-1" } },
          { status: 202 },
        ),
      );

    await expect(
      sendMessage(config, { text: " Hello " }, request),
    ).resolves.toEqual({ status: "accepted", requestId: "request-1" });
    expect(request).toHaveBeenCalledWith("/api/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: " Hello " }),
    });
  });

  it("surfaces the structured gateway error", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "core_unavailable",
            message: "Core message ingress is not configured",
            requestId: "request-2",
          },
        },
        { status: 503 },
      ),
    );

    await expect(
      sendMessage(config, { text: "Hello" }, request),
    ).rejects.toMatchObject({
      code: "core_unavailable",
      status: 503,
      requestId: "request-2",
    });
  });

  it("rejects missing client configuration before sending a request", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(
      sendMessage({ token: "" }, { text: "Hello" }, request),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GatewayRequestError>>({
        code: "missing_token",
      }),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed gateway responses", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "ok" }, { status: 202 }));

    await expect(
      sendMessage(config, { text: "Hello" }, request),
    ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  });
});

describe("checkGatewayHealth", () => {
  it("checks the public health endpoint", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "ok" }));

    await expect(checkGatewayHealth(request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/healthz", {
      method: "GET",
    });
  });

  it("rejects an invalid health response", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "starting" }, { status: 503 }),
      );

    await expect(checkGatewayHealth(request)).rejects.toMatchObject({
      code: "health_check_failed",
      status: 503,
    });
  });
});

describe("configuration setup", () => {
  it("reads anonymous setup status with selected profile metadata", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: {
            status: "invalid",
            selectedProfileId: "default",
            profiles: [
              {
                id: "default",
                name: "default",
                createdAt: "2026-08-30T00:00:00.000Z",
                updatedAt: "2026-08-30T00:00:00.000Z",
              },
            ],
            issues: [
              {
                id: "default-provider-missing",
                path: "ai.providers",
                message: "missing provider",
              },
            ],
            warnings: [
              {
                id: "platforms-empty",
                path: "platforms",
                message: "platforms empty",
              },
            ],
          },
        }),
      );

    await expect(getConfigurationStatus(request)).resolves.toEqual({
      status: "invalid",
      selectedProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "default",
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
      issues: [
        {
          id: "default-provider-missing",
          path: "ai.providers",
          message: "missing provider",
        },
      ],
      warnings: [
        {
          id: "platforms-empty",
          path: "platforms",
          message: "platforms empty",
        },
      ],
    });
    expect(request).toHaveBeenCalledWith("/api/v1/setup", { method: "GET" });
  });
});

describe("profile registry requests", () => {
  it("lists profiles with authentication", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: {
            selectedProfileId: "default",
            profiles: [
              {
                id: "default",
                name: "default",
                createdAt: "2026-08-30T00:00:00.000Z",
                updatedAt: "2026-08-30T00:00:00.000Z",
              },
            ],
          },
        }),
      );

    await expect(listProfiles(config, request)).resolves.toEqual({
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
    expect(request).toHaveBeenCalledWith("/api/v1/profiles", {
      method: "GET",
      headers: {
        authorization: "Bearer test-gateway-token",
      },
    });
  });

  it("creates profiles with the expected JSON body", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          {
            data: {
              profile: {
                id: "b4fbe71d-68a8-45fd-b180-5f0ef4c4b9ee",
                name: "work",
                ai: { providers: [] },
                platforms: [],
                plugins: [],
              },
              restartRequired: false,
            },
          },
          { status: 201 },
        ),
      );

    await expect(createProfile(config, { name: "work" }, request)).resolves.toEqual(
      {
        profile: {
          id: "b4fbe71d-68a8-45fd-b180-5f0ef4c4b9ee",
          name: "work",
          ai: { providers: [] },
          platforms: [],
          plugins: [],
        },
        restartRequired: false,
      },
    );
    expect(request).toHaveBeenCalledWith("/api/v1/profiles", {
      method: "POST",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "work" }),
    });
  });

  it("reads a profile by encoded id", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: {
            profile: {
              id: "profile/one",
              name: "work",
              ai: { providers: [] },
              platforms: [],
              plugins: [],
            },
          },
        }),
      );

    await expect(getProfile(config, "profile/one", request)).resolves.toEqual({
      profile: {
        id: "profile/one",
        name: "work",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      },
    });
    expect(request).toHaveBeenCalledWith("/api/v1/profiles/profile%2Fone", {
      method: "GET",
      headers: {
        authorization: "Bearer test-gateway-token",
      },
    });
  });

  it("replaces a profile with the full payload", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: {
            profile: {
              id: "profile/one",
              ...replacement,
            },
            restartRequired: true,
          },
        }),
      );

    await expect(
      replaceProfile(config, "profile/one", replacement, request),
    ).resolves.toEqual({
      profile: {
        id: "profile/one",
        ...replacement,
      },
      restartRequired: true,
    });
    expect(request).toHaveBeenCalledWith("/api/v1/profiles/profile%2Fone", {
      method: "PUT",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(replacement),
    });
  });

  it("selects the global profile explicitly", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          data: {
            profile: {
              id: "profile/one",
              name: "work",
              ai: { providers: [] },
              platforms: [],
              plugins: [],
            },
            restartRequired: true,
          },
        }),
      );

    await expect(selectProfile(config, "profile/one", request)).resolves.toEqual({
      profile: {
        id: "profile/one",
        name: "work",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      },
      restartRequired: true,
    });
    expect(request).toHaveBeenCalledWith("/api/v1/profiles/selection", {
      method: "PUT",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ selectedProfileId: "profile/one" }),
    });
  });

  it("deletes a profile by encoded id", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(deleteProfile(config, "profile/one", request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/profiles/profile%2Fone", {
      method: "DELETE",
      headers: {
        authorization: "Bearer test-gateway-token",
      },
    });
  });

  it.each([
    ["listProfiles", () => listProfiles({ token: "" }, vi.fn<typeof fetch>())],
    ["createProfile", () => createProfile({ token: "" }, { name: "work" }, vi.fn<typeof fetch>())],
    ["getProfile", () => getProfile({ token: "" }, "profile/one", vi.fn<typeof fetch>())],
    [
      "replaceProfile",
      () =>
        replaceProfile(
          { token: "" },
          "profile/one",
          replacement,
          vi.fn<typeof fetch>(),
        ),
    ],
    ["selectProfile", () => selectProfile({ token: "" }, "profile/one", vi.fn<typeof fetch>())],
    ["deleteProfile", () => deleteProfile({ token: "" }, "profile/one", vi.fn<typeof fetch>())],
  ])("rejects locally when the token is blank for %s", async (_, action) => {
    await expect(action()).rejects.toMatchObject({ code: "missing_token" });
  });
});
