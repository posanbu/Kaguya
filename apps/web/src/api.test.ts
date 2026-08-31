import { describe, expect, it, vi } from "vitest";

import {
  checkGatewayHealth,
  fetchSessionMessages,
  GatewayRequestError,
  getConfigurationStatus,
  initializeConfiguration,
  sendMessage,
} from "./api.js";

const config = {
  token: "test-gateway-token",
};

describe("sendMessage", () => {
  it("sends the gateway message contract and returns the receipt", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          data: {
            status: "accepted",
            requestId: "request-1",
            sessionId: "session-1",
          },
        },
        { status: 202 },
      ),
    );

    await expect(
      sendMessage(config, { text: " Hello " }, request),
    ).resolves.toEqual({
      status: "accepted",
      requestId: "request-1",
      sessionId: "session-1",
    });
    expect(request).toHaveBeenCalledWith("/api/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json",
        "x-request-id": expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        ),
      },
      body: JSON.stringify({ text: " Hello " }),
    });
  });

  it("forwards an explicit session id in the request body", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          data: {
            status: "accepted",
            requestId: "request-2",
            sessionId: "session-x",
          },
        },
        { status: 202 },
      ),
    );

    await expect(
      sendMessage(config, { text: "Hello", sessionId: "session-x" }, request),
    ).resolves.toEqual({
      status: "accepted",
      requestId: "request-2",
      sessionId: "session-x",
    });
    expect(request).toHaveBeenCalledWith(
      "/api/v1/messages",
      expect.objectContaining({
        body: JSON.stringify({ text: "Hello", sessionId: "session-x" }),
      }),
    );
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

  it("rejects a receipt without the session id", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { data: { status: "accepted", requestId: "request-4" } },
          { status: 202 },
        ),
      );

    await expect(
      sendMessage(config, { text: "Hello" }, request),
    ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  });
});

describe("fetchSessionMessages", () => {
  it("lists session messages with the bearer token", async () => {
    const history = [
      {
        id: "message-1",
        role: "user",
        content: "hello",
        occurredAt: "2026-08-30T00:00:00.000Z",
        requestId: "request-1",
      },
      {
        id: "message-2",
        role: "assistant",
        content: "Good evening.",
        occurredAt: "2026-08-30T00:00:01.000Z",
        requestId: "request-1",
      },
    ];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: { sessionId: "session-1", messages: history } }),
      );

    await expect(
      fetchSessionMessages(config, "session-1", request),
    ).resolves.toEqual({ sessionId: "session-1", messages: history });
    expect(request).toHaveBeenCalledWith("/api/v1/sessions/session-1", {
      method: "GET",
      headers: { authorization: "Bearer test-gateway-token" },
    });
  });

  it("maps an empty session to an empty list", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: { sessionId: "unknown", messages: [] } }),
      );

    await expect(
      fetchSessionMessages(config, "unknown", request),
    ).resolves.toEqual({ sessionId: "unknown", messages: [] });
  });

  it("surfaces the structured gateway error", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "unauthorized",
            message: "A valid gateway Bearer token is required",
            requestId: "request-5",
          },
        },
        { status: 401 },
      ),
    );

    await expect(
      fetchSessionMessages(config, "session-1", request),
    ).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
      requestId: "request-5",
    });
  });

  it("rejects without a token before sending a request", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(
      fetchSessionMessages({ token: "" }, "session-1", request),
    ).rejects.toMatchObject({ code: "missing_token" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed session responses", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          sessionId: "session-1",
          messages: [{ id: "message-1", role: "system" }],
        },
      }),
    );

    await expect(
      fetchSessionMessages(config, "session-1", request),
    ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
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
  it("reads setup status without authentication", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: { status: "setup_required" } }));

    await expect(getConfigurationStatus(request)).resolves.toEqual({
      status: "setup_required",
    });
    expect(request).toHaveBeenCalledWith("/api/v1/setup", { method: "GET" });
  });

  it("submits the initial provider configuration with the gateway token", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { data: { status: "configured", restartRequired: true } },
          { status: 201 },
        ),
      );

    await expect(
      initializeConfiguration(
        config,
        {
          profileName: "default",
          baseUrl: "https://api.example/v1",
          apiKey: "provider-secret",
          lightModel: "small-model",
          heavyModel: "large-model",
          acknowledgeOptional: true,
        },
        request,
      ),
    ).resolves.toEqual({ status: "configured", restartRequired: true });
    expect(request).toHaveBeenCalledWith("/api/v1/setup", {
      method: "POST",
      headers: {
        authorization: "Bearer test-gateway-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        profileName: "default",
        baseUrl: "https://api.example/v1",
        apiKey: "provider-secret",
        lightModel: "small-model",
        heavyModel: "large-model",
        acknowledgeOptional: true,
      }),
    });
  });

  it("rejects setup submission without a gateway token", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      initializeConfiguration(
        { token: "" },
        {
          profileName: "default",
          baseUrl: "https://api.example/v1",
          apiKey: "provider-secret",
          lightModel: "small-model",
          heavyModel: "large-model",
          acknowledgeOptional: true,
        },
        request,
      ),
    ).rejects.toMatchObject({ code: "missing_token" });
    expect(request).not.toHaveBeenCalled();
  });
});
