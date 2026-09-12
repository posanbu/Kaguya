/**
 * 功能概述：验证通用 LLM 客户端请求边界接收调用方提供的结构化 schema 与取消信号。
 * 主要职责：确认 schema 校验、外部取消与 SDK 总超时、关闭 SDK 重试、usage/duration 规范化及错误分类。
 * 代码库关系：使用 AI SDK 的内存模型隔离 provider；客户端实现位于同目录的 client.ts。
 * 输入输出与副作用：仅在内存中调用模型，不产生持久化；无效输出应转为分类后的客户端错误。
 */
import type { CompiledPrompt } from "@kaguya/schema";
import { z } from "@kaguya/schema";
import { APICallError } from "ai";
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
