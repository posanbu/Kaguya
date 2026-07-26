import { describe, expect, it, vi } from "vitest";

import {
  OpenAiCompatibleError,
  OpenAiCompatibleLlmService,
  type OpenAiCompatibleLogEvent,
} from "./openai-compatible.js";

const baseRequest = {
  apiKey: "secret-key",
  baseUrl: "https://gateway.example/v1",
  model: "model-a",
  systemPrompt: "You are helpful.",
  userPrompt: "Hello",
};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>) {
  const headers = fetchMock.mock.calls[0]?.[1]?.headers;
  return new Headers(headers as HeadersInit | undefined);
}

describe("OpenAiCompatibleLlmService", () => {
  it("uses the AI SDK with UI-provided endpoint, model, prompts and credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse(
          {
            model: "model-a-2026",
            choices: [{ message: { content: "Hello back" } }],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 3,
              total_tokens: 11,
            },
          },
          { headers: { "x-request-id": "request-1" } },
        ),
      ),
    );
    const service = new OpenAiCompatibleLlmService({
      fetch,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
    });

    await expect(service.call(baseRequest)).resolves.toEqual({
      content: "Hello back",
      model: "model-a-2026",
      requestId: "request-1",
      usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
      attempts: 1,
      durationMs: 25,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.example/v1/chat/completions",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const headers = requestHeaders(fetch);
    expect(headers.get("authorization")).toBe("Bearer secret-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toContain("ai/7.0.35");

    const body = JSON.parse(
      (fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? "null",
    );
    expect(body).toEqual({
      model: "model-a",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0,
    });
  });

  it("validates prompt text without changing its whitespace", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await service.call({
      ...baseRequest,
      systemPrompt: "  system prompt\n",
      userPrompt: "\nuser prompt  ",
    });

    const body = JSON.parse(
      (fetch.mock.calls[0]?.[1]?.body as string | undefined) ?? "null",
    );
    expect(body.messages).toEqual([
      { role: "system", content: "  system prompt\n" },
      { role: "user", content: "\nuser prompt  " },
    ]);
  });

  it("preserves a provider total_tokens value when token components are absent", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 42 },
        }),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(service.call(baseRequest)).resolves.toMatchObject({
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 42 },
    });
  });

  it("normalizes a full chat completions URL and preserves raw query parameters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await service.call({
      ...baseRequest,
      baseUrl:
        "https://azure.example/openai/deployments/model/chat/completions?api-version=2026-01-01&tag=a&tag=b&sig=a%20b",
      apiKeyHeader: "api-key",
      additionalHeaders: { "x-tenant": "tenant-a" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://azure.example/openai/deployments/model/chat/completions?api-version=2026-01-01&tag=a&tag=b&sig=a%20b",
      expect.any(Object),
    );
    const headers = requestHeaders(fetch);
    expect(headers.get("api-key")).toBe("secret-key");
    expect(headers.get("x-tenant")).toBe("tenant-a");
  });

  it("delegates transient response retries to the AI SDK", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "busy" } },
          { status: 503, headers: { "retry-after-ms": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "recovered" } }] }),
      );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, maxRetries: 2 }),
    ).resolves.toMatchObject({ content: "recovered", attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes SDK retry exhaustion with status and attempt count", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse(
          { error: { message: "still busy" } },
          { status: 503, headers: { "retry-after-ms": "0" } },
        ),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, maxRetries: 2 }),
    ).rejects.toMatchObject({
      message: "LLM provider request failed temporarily",
      kind: "retryable",
      status: 503,
      attempts: 3,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses the final provider error classification after a retry", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "temporarily unavailable" } },
          { status: 503, headers: { "retry-after-ms": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "invalid key" } }, { status: 401 }),
      );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, maxRetries: 1 }),
    ).rejects.toMatchObject({
      message: "LLM provider request failed",
      kind: "non-retryable",
      status: 401,
      attempts: 2,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels the AI SDK while it is waiting to retry", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ error: { message: "busy" } }, { status: 503 }),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });
    const pendingCall = service.call({
      ...baseRequest,
      maxRetries: 2,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pendingCall).rejects.toMatchObject({
      kind: "cancelled",
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("enforces the AI SDK total timeout through its abort signal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () =>
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          if (signal?.aborted === true) {
            abort();
          } else {
            signal?.addEventListener("abort", abort, { once: true });
          }
        }),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, maxRetries: 0, timeoutMs: 10 }),
    ).rejects.toMatchObject({ kind: "cancelled", attempts: 1 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the SDK timeout active while the response body is being read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"choices":[{"message":{"content":"partial',
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason),
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, maxRetries: 0, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "cancelled", attempts: 1 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry authentication failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ error: { message: "invalid key" } }, { status: 401 }),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    const error = await service
      .call(baseRequest)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAiCompatibleError);
    expect(error).toMatchObject({
      message: "LLM provider request failed",
      kind: "non-retryable",
      status: 401,
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a non-JSON authentication failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(service.call(baseRequest)).rejects.toMatchObject({
      kind: "non-retryable",
      status: 401,
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not expose the raw SDK error as a public cause", async () => {
    const privatePrompt = "prompt-secret-that-must-not-leak";
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              message: "invalid key",
              request: privatePrompt,
            },
          },
          { status: 401 },
        ),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    const error = await service
      .call({ ...baseRequest, userPrompt: privatePrompt })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiCompatibleError);
    expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
    expect(JSON.stringify(error)).not.toContain(privatePrompt);
  });

  it("classifies malformed SDK responses as non-retryable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ choices: [] })),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, maxRetries: 2 }),
    ).rejects.toMatchObject({
      kind: "non-retryable",
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("emits structured logs without credentials or prompt content", async () => {
    const events: OpenAiCompatibleLogEvent[] = [];
    const logger = {
      info: vi.fn((event: OpenAiCompatibleLogEvent) => events.push(event)),
      error: vi.fn((event: OpenAiCompatibleLogEvent) => events.push(event)),
    };
    const service = new OpenAiCompatibleLlmService({
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            choices: [{ message: { content: "private answer" } }],
          }),
        ),
      logger,
    });

    await service.call({
      ...baseRequest,
      baseUrl: `https://gateway.example/v1?key=${baseRequest.apiKey}`,
    });

    expect(events.map((event) => event.event)).toEqual([
      "llm.call.started",
      "llm.call.succeeded",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(baseRequest.apiKey);
    expect(serialized).not.toContain(baseRequest.systemPrompt);
    expect(serialized).not.toContain(baseRequest.userPrompt);
    expect(serialized).not.toContain("private answer");
  });

  it("logs only the provider origin, not a tenant path or query", async () => {
    const events: OpenAiCompatibleLogEvent[] = [];
    const logger = {
      info: vi.fn((event: OpenAiCompatibleLogEvent) => events.push(event)),
      error: vi.fn((event: OpenAiCompatibleLogEvent) => events.push(event)),
    };
    const service = new OpenAiCompatibleLlmService({
      fetch: () =>
        Promise.resolve(
          jsonResponse({ choices: [{ message: { content: "ok" } }] }),
        ),
      logger,
    });

    await service.call({
      ...baseRequest,
      baseUrl:
        "https://gateway.example/openai/deployments/tenant-secret/chat/completions?sig=query-secret#fragment-secret",
    });

    expect(events).toHaveLength(2);
    expect(events[0]?.endpoint).toBe("https://gateway.example");
    expect(JSON.stringify(events)).not.toContain("tenant-secret");
    expect(JSON.stringify(events)).not.toContain("query-secret");
    expect(JSON.stringify(events)).not.toContain("fragment-secret");
  });

  it("does not expose or log provider errors that reflect sensitive input", async () => {
    const events: OpenAiCompatibleLogEvent[] = [];
    const logger = {
      info: vi.fn((event: OpenAiCompatibleLogEvent) => events.push(event)),
      error: vi.fn((event: OpenAiCompatibleLogEvent) => events.push(event)),
    };
    const reflectedMessage = `${baseRequest.apiKey} ${baseRequest.systemPrompt}`;
    const service = new OpenAiCompatibleLlmService({
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            { error: { message: reflectedMessage } },
            { status: 401 },
          ),
        ),
      logger,
    });

    await expect(service.call(baseRequest)).rejects.toMatchObject({
      message: "LLM provider request failed",
      kind: "non-retryable",
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(baseRequest.apiKey);
    expect(serialized).not.toContain(baseRequest.systemPrompt);
    expect(serialized).not.toContain(reflectedMessage);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "llm.call.failed",
        errorKind: "non-retryable",
        status: 401,
      }),
    );
  });

  it("rejects invalid UI configuration before creating an SDK request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, apiKey: "  " }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    await expect(
      service.call({ ...baseRequest, baseUrl: "file:///tmp/model" }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    await expect(
      service.call({
        ...baseRequest,
        additionalHeaders: { "x-invalid": "value\r\ninjected: yes" },
      }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    await expect(
      service.call({
        ...baseRequest,
        additionalHeaders: { "Content-Type": "text/plain" },
      }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    await expect(
      service.call({ ...baseRequest, apiKeyHeader: "Content-Type" }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });

    await expect(
      service.call({
        ...baseRequest,
        apiKeyHeader: 42 as unknown as string,
      }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    await expect(
      service.call({
        ...baseRequest,
        additionalHeaders: [] as unknown as Record<string, string>,
      }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });

    const reservedHeaders = [
      "Host",
      "content-length",
      "Transfer-Encoding",
      "Connection",
      "Proxy-Authorization",
      "Keep-Alive",
      "TE",
      "Trailer",
      "Upgrade",
      "__proto__",
      "constructor",
      "prototype",
    ];
    for (const header of reservedHeaders) {
      await expect(
        service.call({ ...baseRequest, apiKeyHeader: header }),
      ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
      await expect(
        service.call({
          ...baseRequest,
          additionalHeaders: { [header.toLowerCase()]: "value" },
        }),
      ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
