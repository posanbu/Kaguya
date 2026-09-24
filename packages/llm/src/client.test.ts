/**
 * 功能概述：验证通用 LLM 客户端请求边界接收调用方提供的结构化 schema 与取消信号。
 * 主要职责：确认 schema 校验、取消/超时、关闭 SDK 重试、usage/duration，以及 Provider
 * 诊断从直接、RetryError/cause 包装的 API 错误中安全归一化且不泄露响应或请求材料。
 * 代码库关系：使用 AI SDK 的内存模型隔离 provider；客户端实现位于同目录的 client.ts。
 * 输入输出与副作用：仅在内存中调用模型，不产生持久化；无效输出应转为分类后的客户端错误。
 */
import type { CompiledPrompt } from "@kaguya/schema";
import { z } from "@kaguya/schema";
import { APICallError, RetryError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { KaguyaLlmClient, KaguyaLlmError } from "./client.js";

const prompt: CompiledPrompt = {
  kind: "route",
  text: "hello",
  templateId: "test.route",
  templates: [{ name: "main", content: "hello" }],
  variables: [],
};
const outputSchema = z.object({ answer: z.string() }).strict();

describe("generic KaguyaLlmClient boundary", () => {
  it.each(["direct", "retry", "cause"] as const)(
    "extracts blocked credential diagnosis from %s API errors without exposing raw data",
    async (wrapper) => {
      const secret = "sk_test_private_credential_215";
      const promptText = "private_prompt_marker_215";
      const query = "private_query_marker_215";
      const raw = new APICallError({
        message: `provider said ${secret}`,
        url: `https://provider.invalid/v1/chat?key=${query}`,
        requestBodyValues: { prompt: promptText },
        responseHeaders: { Authorization: secret },
        responseBody: JSON.stringify({
          error: {
            code: 401,
            type: "auth_error",
            message: `Authentication Error, Key is blocked. ${secret}`,
          },
        }),
        statusCode: 401,
        isRetryable: false,
      });
      const failure =
        wrapper === "direct"
          ? raw
          : wrapper === "retry"
            ? new RetryError({
                message: secret,
                reason: "errorNotRetryable",
                errors: [raw],
              })
            : new Error(secret, { cause: raw });
      const model = new MockLanguageModelV3({
        doGenerate: () => Promise.reject(failure),
      });
      const client = new KaguyaLlmClient({ model });
      let caught: unknown;
      try {
        await client.generate({
          modelId: "model",
          prompt: { ...prompt, text: promptText },
          outputMode: "text",
          outputSchema: z.string(),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KaguyaLlmError);
      expect(caught).toMatchObject({
        stage: "provider-request",
        providerFailure: {
          statusCode: 401,
          type: "auth_error",
          reason: "credential-blocked",
        },
      });
      const exposed = JSON.stringify(caught);
      for (const probe of [secret, promptText, query, "Key is blocked"])
        expect(exposed).not.toContain(probe);
      expect(model.doGenerateCalls).toHaveLength(1);
    },
  );

  it.each([
    {
      statusCode: 401,
      body: '{"error":{"type":"auth_error"}}',
      reason: "authentication-failed",
    },
    {
      statusCode: 403,
      body: '{"error":{"code":"permission_denied"}}',
      reason: "model-access-denied",
    },
    { statusCode: 429, body: "<html>private</html>", reason: "rate-limited" },
    { statusCode: 400, body: "not json", reason: "invalid-request" },
    { statusCode: 422, body: "{}", reason: "invalid-request" },
    { statusCode: 503, body: "{}", reason: "provider-unavailable" },
    {
      statusCode: 404,
      body: '{"error":{"code":"model_not_found"}}',
      reason: "model-not-found",
    },
    { statusCode: 404, body: "{}", reason: "unknown" },
  ])(
    "classifies safe HTTP $statusCode diagnostics as $reason",
    async ({ statusCode, body, reason }) => {
      const client = new KaguyaLlmClient({
        model: new MockLanguageModelV3({
          doGenerate: () =>
            Promise.reject(
              new APICallError({
                message: "private provider message",
                url: "https://provider.invalid",
                requestBodyValues: {},
                statusCode,
                responseBody: body,
                isRetryable: false,
              }),
            ),
        }),
      });
      await expect(
        client.generate({
          modelId: "model",
          prompt,
          outputMode: "text",
          outputSchema: z.string(),
        }),
      ).rejects.toMatchObject({ providerFailure: { statusCode, reason } });
    },
  );

  it("drops unrecognized provider identifiers and body text", async () => {
    const secret = "sk_test_private_credential_215";
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: () =>
          Promise.reject(
            new APICallError({
              message: secret,
              url: "https://provider.invalid",
              requestBodyValues: {},
              responseBody: JSON.stringify({
                error: {
                  code: secret,
                  type: "unexpected_error_type",
                  message: `unknown response ${secret}`,
                },
              }),
              isRetryable: false,
            }),
          ),
      }),
    });
    await expect(
      client.generate({
        modelId: "model",
        prompt,
        outputMode: "text",
        outputSchema: z.string(),
      }),
    ).rejects.toMatchObject({ providerFailure: { reason: "unknown" } });
    try {
      await client.generate({
        modelId: "model",
        prompt,
        outputMode: "text",
        outputSchema: z.string(),
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as KaguyaLlmError).providerFailure).toEqual({
        reason: "unknown",
      });
    }
  });
  it("normalizes Profile generation controls into the provider call", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    });
    const client = new KaguyaLlmClient({
      model,
      resolveGenerationOptions: () => ({
        reasoning: "low",
        recommendedDurationMs: 2_000,
      }),
    });

    const generation = await client.generate({
      modelId: "model",
      prompt,
      outputMode: "text",
      outputSchema: z.string(),
    });

    expect(model.doGenerateCalls[0]).toMatchObject({
      reasoning: "low",
    });
    expect(generation).toMatchObject({
      recommendedDurationMs: 2_000,
      exceededRecommendedDuration: false,
    });
  });

  it("passes the request signal", async () => {
    const signal = new AbortController().signal;
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: '{"answer":"ok"}' }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    });
    const client = new KaguyaLlmClient({ model });

    await expect(
      client.generate({
        modelId: "model",
        prompt,
        outputMode: "object",
        outputSchema,
        signal,
      }),
    ).resolves.toMatchObject({
      output: { answer: "ok" },
    });
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("does not retry a retryable provider error when retries are disabled", async () => {
    const providerError = new APICallError({
      message: "secret endpoint",
      url: "https://secret.invalid",
      requestBodyValues: {},
      isRetryable: true,
    });
    const model = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(providerError),
    });
    const client = new KaguyaLlmClient({ model });
    await expect(
      client.generate({
        modelId: "model",
        prompt,
        outputMode: "object",
        outputSchema,
      }),
    ).rejects.toMatchObject({
      kind: "retryable",
      stage: "provider-request",
      message: "Language model request failed and may be retried",
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("rejects output that violates the supplied schema with only a classified error", async () => {
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: {
          content: [{ type: "text", text: '{"wrong":true}' }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: undefined,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: undefined,
              text: undefined,
              reasoning: undefined,
            },
          },
          warnings: [],
        },
      }),
    });

    await expect(
      client.generate({
        modelId: "model",
        prompt,
        outputMode: "object",
        outputSchema,
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof KaguyaLlmError &&
        error.kind === "non-retryable" &&
        error.stage === "structured-output-parse" &&
        !("cause" in error),
    );
  });
});

it("aborts a pending provider call at the configured hard timeout", async () => {
  let providerSignal: AbortSignal | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        providerSignal = abortSignal;
        abortSignal!.addEventListener(
          "abort",
          () => reject(abortSignal!.reason),
          { once: true },
        );
      }),
  });
  const client = new KaguyaLlmClient({
    model,
    resolveGenerationOptions: () => ({ timeoutMs: 20 }),
  });
  await expect(
    client.generate({
      modelId: "model",
      prompt,
      outputMode: "text",
      outputSchema: z.string(),
    }),
  ).rejects.toBeInstanceOf(KaguyaLlmError);
  expect(providerSignal?.aborted).toBe(true);
  expect(model.doGenerateCalls).toHaveLength(1);
});

it("propagates caller cancellation before a long model timeout", async () => {
  const controller = new AbortController();
  const model = new MockLanguageModelV3({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal!.addEventListener(
          "abort",
          () => reject(abortSignal!.reason),
          { once: true },
        );
        controller.abort(new DOMException("cancel", "AbortError"));
      }),
  });
  const client = new KaguyaLlmClient({
    model,
    resolveGenerationOptions: () => ({ timeoutMs: 300_000 }),
  });
  await expect(
    client.generate({
      modelId: "model",
      prompt,
      outputMode: "text",
      outputSchema: z.string(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ kind: "cancelled" });
  expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
});
it.each([0, -1, 300_001, 1.5, NaN, Infinity])(
  "rejects invalid timeout %s without invoking the provider",
  async (timeoutMs) => {
    const model = new MockLanguageModelV3();
    const client = new KaguyaLlmClient({
      model,
      resolveGenerationOptions: () => ({ timeoutMs }),
    });
    await expect(
      client.generate({
        modelId: "model",
        prompt,
        outputMode: "text",
        outputSchema: z.string(),
      }),
    ).rejects.toBeInstanceOf(KaguyaLlmError);
    expect(model.doGenerateCalls).toHaveLength(0);
  },
);
