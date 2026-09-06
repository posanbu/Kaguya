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
  ai: { providers: [] },
  platforms: [],
  plugins: [],
};
const replacement = {
  name: "default",
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
  platforms: [],
  plugins: [],
};

describe("gateway API client", () => {
  it("authenticates setup readiness with the fragment token", async () => {
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

    await expect(
      getConfigurationStatus(config, request),
    ).resolves.toMatchObject({
      status: "invalid",
      selectedProfileId: "default",
    });
    expect(request).toHaveBeenCalledWith("/api/v1/setup", {
      method: "GET",
      headers: { authorization: "Bearer test-gateway-token" },
    });
  });

  it("rejects a missing token before making a protected request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      getConfigurationStatus({ token: "" }, request),
    ).rejects.toEqual(
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
          data: { selectedProfileId: "default", profiles: [metadata] },
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
  });
});
