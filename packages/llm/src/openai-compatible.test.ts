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

describe("OpenAiCompatibleLlmService", () => {
  it("uses UI-provided endpoint, model, prompts and credentials", async () => {
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
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-key",
          "content-type": "application/json",
        }),
      }),
    );
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

  it("accepts a full chat completions URL and custom API key header", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      ),
    );
    const service = new OpenAiCompatibleLlmService({ fetch });

    await service.call({
      ...baseRequest,
      baseUrl:
        "https://azure.example/openai/deployments/model/chat/completions?api-version=2026-01-01",
      apiKeyHeader: "api-key",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://azure.example/openai/deployments/model/chat/completions?api-version=2026-01-01",
      expect.objectContaining({
        headers: expect.objectContaining({ "api-key": "secret-key" }),
      }),
    );
  });

  it("retries transient responses with exponential backoff", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "busy" } }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "recovered" } }] }),
      );
    const sleep = vi.fn(() => Promise.resolve());
    const service = new OpenAiCompatibleLlmService({ fetch, sleep });

    await expect(
      service.call({ ...baseRequest, maxRetries: 2, retryDelayMs: 25 }),
    ).resolves.toMatchObject({ content: "recovered", attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("does not retry authentication failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse({ error: { message: "invalid key" } }, { status: 401 }),
      ),
    );
    const sleep = vi.fn(() => Promise.resolve());
    const service = new OpenAiCompatibleLlmService({ fetch, sleep });

    const error = await service
      .call(baseRequest)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAiCompatibleError);
    expect(error).toMatchObject({
      message: "invalid key",
      kind: "non-retryable",
      status: 401,
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
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

  it("rejects invalid UI configuration before sending a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = new OpenAiCompatibleLlmService({ fetch });

    await expect(
      service.call({ ...baseRequest, apiKey: "  " }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    await expect(
      service.call({ ...baseRequest, baseUrl: "file:///tmp/model" }),
    ).rejects.toMatchObject({ kind: "configuration", attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
