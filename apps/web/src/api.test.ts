import { describe, expect, it, vi } from "vitest";

import { checkGatewayHealth, GatewayRequestError, sendMessage } from "./api.js";

const config = {
  baseUrl: "http://127.0.0.1:3000/",
  token: "test-gateway-token",
};

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
      sendMessage(
        config,
        { sessionId: " session-1 ", text: " Hello " },
        request,
      ),
    ).resolves.toEqual({ status: "accepted", requestId: "request-1" });
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/v1/messages",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-gateway-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: "session-1", text: " Hello " }),
      },
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
      sendMessage(config, { sessionId: "session-1", text: "Hello" }, request),
    ).rejects.toMatchObject({
      code: "core_unavailable",
      status: 503,
      requestId: "request-2",
    });
  });

  it("rejects missing client configuration before sending a request", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(
      sendMessage(
        { baseUrl: "http://127.0.0.1:3000", token: "" },
        { sessionId: "session-1", text: "Hello" },
        request,
      ),
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
      sendMessage(config, { sessionId: "session-1", text: "Hello" }, request),
    ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  });
});

describe("checkGatewayHealth", () => {
  it("checks the public health endpoint", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "ok" }));

    await expect(
      checkGatewayHealth("http://127.0.0.1:3000/", request),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:3000/healthz", {
      method: "GET",
    });
  });

  it("rejects an invalid health response", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "starting" }, { status: 503 }),
      );

    await expect(
      checkGatewayHealth("http://127.0.0.1:3000", request),
    ).rejects.toMatchObject({ code: "health_check_failed", status: 503 });
  });
});
