/**
 * 功能概述：验证 Web API 客户端认证、请求编码及服务端响应校验。
 * 主要职责：模拟 fetch 覆盖 Profile 管理、消息、模型发现及配置版本应用；冲突不自动重试。
 * 代码库关系：调用 api.ts 的公开方法，与 Server DTO 契约保持一致。
 * 输入输出与副作用：仅使用虚构凭据和本地 Response，不发网络请求；错误提示不显示底层秘密。
 */
import { describe, expect, it, vi } from "vitest";

import {
  checkGatewayHealth,
  createProfile,
  deleteProfile,
  discoverModels,
  applyConfiguration,
  getConfigurationApplication,
  GatewayRequestError,
  getProfile,
  listProfiles,
  replaceProfile,
  selectProfile,
  sendMessage,
} from "./api.js";

const config = { token: "test-gateway-token" };
const metadata = {
  id: "default",
  name: "default",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const profile = {
  version: 1 as const,
  id: "default",
  name: "default",
  gatewayAllowlist: [],
  identity: { name: "Kaguya", aliases: ["辉夜"], persona: "test" },
  ai: { providers: [] },
  memory: { enabled: false },
  platforms: [],
};
const replacement = {
  name: "default",
  gatewayAllowlist: ["qq:private:112233"],
  identity: { name: "Kaguya", aliases: ["辉夜"], persona: "test" },
  acknowledgedWarnings: [],
  ai: {
    defaultProviderId: "provider",
    modelTiers: {
      light: { providerId: "provider", modelId: "light" },
      heavy: { providerId: "provider", modelId: "heavy" },
    },
    providers: [
      {
        id: "provider",
        type: "openai-compatible",
        enabled: true,
        baseUrl: "https://api.example/v1",
        apiKey: "secret",
        models: ["light", "heavy"],
        settings: {},
      },
    ],
  },
  memory: { enabled: false },
  platforms: [],
};

describe("gateway API client", () => {
  it("discovers models with current unsaved provider fields", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: { models: ["model-a", "model-b"] } }),
      );

    await expect(
      discoverModels(
        config,
        {
          baseUrl: "https://provider.example/v1",
          apiKey: "provider-secret",
        },
        request,
      ),
    ).resolves.toEqual(["model-a", "model-b"]);
    expect(request).toHaveBeenCalledWith(
      "/api/v1/models/discover",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-gateway-token",
          "content-type": "application/json",
        }),
      }),
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      baseUrl: "https://provider.example/v1",
      apiKey: "provider-secret",
    });
  });

  it("authenticates registry readiness with the fragment token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          status: "invalid",
          selectedProfileId: "default",
          profiles: [metadata],
          issues: [],
          warnings: [],
        },
      }),
    );

    await expect(listProfiles(config, request)).resolves.toMatchObject({
      status: "invalid",
      selectedProfileId: "default",
    });
    expect(request).toHaveBeenCalledWith("/api/v1/profiles", {
      method: "GET",
      headers: { authorization: "Bearer test-gateway-token" },
    });
  });

  it("rejects a missing token before making a protected request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(listProfiles({ token: "" }, request)).rejects.toEqual(
      expect.objectContaining<Partial<GatewayRequestError>>({
        code: "missing_token",
      }),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("sends messages with the gateway token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { data: { status: "accepted", requestId: "request-1" } },
          { status: 202 },
        ),
      );
    await expect(
      sendMessage(config, { text: "Hello" }, request),
    ).resolves.toEqual({
      status: "accepted",
      requestId: "request-1",
    });
    expect(request).toHaveBeenCalledWith(
      "/api/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-gateway-token",
        }),
      }),
    );
  });

  it("checks the public health endpoint without a token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    await expect(checkGatewayHealth(request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/healthz", { method: "GET" });
  });

  it("uses authenticated Profile management routes", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            status: "invalid",
            selectedProfileId: "default",
            profiles: [metadata],
            issues: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { data: { profile, restartRequired: false } },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ data: { profile } }))
      .mockResolvedValueOnce(
        Response.json({ data: { profile, restartRequired: true } }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { profile, restartRequired: true } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await listProfiles(config, request);
    await createProfile(config, { name: "work" }, request);
    await getProfile(config, "default", request);
    await replaceProfile(config, "default", replacement, request);
    await selectProfile(config, "default", request);
    await deleteProfile(config, "profile id", request);

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/profiles",
      "/api/v1/profiles",
      "/api/v1/profiles/default",
      "/api/v1/profiles/default",
      "/api/v1/profiles/selection",
      "/api/v1/profiles/profile%20id",
    ]);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-gateway-token",
      );
    }
    expect(JSON.parse(String(request.mock.calls[3]?.[1]?.body))).toMatchObject({
      gatewayAllowlist: ["qq:private:112233"],
      memory: { enabled: false },
    });
  });
});

describe("configuration application client", () => {
  const snapshot = {
    state: "pending" as const,
    selectedProfileId: "default",
    selectedRevision: "a".repeat(64),
    appliedProfileId: "default",
    appliedRevision: "b".repeat(64),
  };
  it("applies exactly the version displayed to the user", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          status: "applied",
          application: {
            ...snapshot,
            state: "ready",
            appliedRevision: snapshot.selectedRevision,
          },
        },
      }),
    );
    expect((await applyConfiguration(config, snapshot, request)).status).toBe(
      "applied",
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      selectedProfileId: "default",
      revision: snapshot.selectedRevision,
    });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer test-gateway-token",
    });
  });
  it("does not retry a conflict with a newer revision or expose server error details", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: "private-server-details" } },
          { status: 409 },
        ),
      );
    await expect(applyConfiguration(config, snapshot, request)).rejects.toThrow(
      "配置已被其他操作修改或正在应用",
    );
    expect(request).toHaveBeenCalledOnce();
  });
  it("rejects invalid status snapshots before displaying readiness", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: { ...snapshot, selectedRevision: "raw-secret" },
      }),
    );
    await expect(getConfigurationApplication(config, request)).rejects.toThrow(
      "无法读取配置生效状态",
    );
  });
});
