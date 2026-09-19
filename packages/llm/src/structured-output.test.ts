/**
 * 功能概述：验证 JSON mode 在本地 Schema 校验失败后的有界恢复与安全诊断。
 * 主要职责：通过确定性模型覆盖协议分流、空响应/解析/结构/截断分类、usage 累加及取消边界。
 * 代码库关系：直接调用 client.ts；模型只记录 AI SDK 请求，不读取配置或访问外部 Provider。
 * 输入输出与副作用：合成失败响应只在内存使用，断言重试保持 Prompt 且不暴露原始响应。
 */
import { z, type CompiledPrompt } from "@kaguya/schema";
import { MockLanguageModelV3 } from "ai/test";
import { APICallError, jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { KaguyaLlmClient } from "./client.js";

const prompt: CompiledPrompt = {
  kind: "route",
  text: "Choose an answer.",
  templateId: "test.route",
  templates: [{ name: "main", content: "Choose an answer." }],
  variables: [],
};
const outputSchema = z.object({ answer: z.string() }).strict();
const request = {
  modelId: "test",
  prompt,
  outputMode: "object" as const,
  outputSchema,
};
function response(text: string, finishReason: "stop" | "length" = "stop") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: finishReason, raw: undefined },
    usage: {
      inputTokens: {
        total: 2,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 3, text: 3, reasoning: undefined },
    },
    warnings: [],
  };
}

describe("bounded JSON output recovery", () => {
  it.each(["", " ", "not-json-secret", '{"wrong":"secret"}'])(
    "recovers from %j with the frozen prompt",
    async (bad) => {
      const model = new MockLanguageModelV3({
        doGenerate: [response(bad), response('{"answer":"ok"}')],
      });
      const result = await new KaguyaLlmClient({ model }).generate(request);
      expect(result).toMatchObject({
        output: { answer: "ok" },
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(model.doGenerateCalls[0]?.responseFormat).toEqual({
        type: "json",
      });
      expect(model.doGenerateCalls[1]?.prompt).toEqual(
        model.doGenerateCalls[0]?.prompt,
      );
      const sent = JSON.stringify(model.doGenerateCalls[0]?.prompt);
      expect(sent).toContain("answer");
      expect(sent).toContain("required");
      expect(sent).not.toContain("secret");
    },
  );

  it.each([
    ["", "stop", "empty"],
    ["not-json-secret", "stop", "invalid-json"],
    ['{"wrong":"secret"}', "stop", "schema-mismatch"],
    ['{"answer":', "length", "truncated"],
  ] as const)(
    "classifies exhausted %s safely",
    async (bad, finish, failure) => {
      const model = new MockLanguageModelV3({
        doGenerate: response(bad, finish),
      });
      const error = await new KaguyaLlmClient({ model })
        .generate(request)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        kind: "non-retryable",
        stage: "structured-output-parse",
        structuredOutputFailure: failure,
        attemptCount: 2,
        usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      });
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(error).not.toHaveProperty("cause");
      expect(model.doGenerateCalls).toHaveLength(2);
    },
  );

  it("uses native schema output only for explicit support", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: response('{"answer":"ok"}'),
    });
    const client = new KaguyaLlmClient({
      model,
      resolveGenerationOptions: () => ({ structuredOutputMode: "schema" }),
    });
    await expect(client.generate(request)).resolves.toMatchObject({
      output: { answer: "ok" },
    });
    expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({
      type: "json",
      schema: { type: "object", required: ["answer"] },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("retains local validation in native schema mode without JSON retries", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: response('{"wrong":true}'),
    });
    const client = new KaguyaLlmClient({
      model,
      resolveGenerationOptions: () => ({ structuredOutputMode: "schema" }),
    });
    await expect(client.generate(request)).rejects.toMatchObject({
      structuredOutputFailure: "schema-mismatch",
      attemptCount: 1,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("does not retry after cancellation while receiving invalid output", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        controller.abort(new DOMException("secret", "AbortError"));
        return response("invalid");
      },
    });
    await expect(
      new KaguyaLlmClient({ model }).generate({
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("applies the local validator and its defaults", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response("{}") });
    await expect(
      new KaguyaLlmClient({ model }).generate({
        ...request,
        outputSchema: z.object({ answer: z.string().default("ok") }),
      }),
    ).resolves.toMatchObject({ output: { answer: "ok" } });
  });

  it("shares the hard timeout across both attempts", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let retrySignal: AbortSignal | undefined;
      const model = new MockLanguageModelV3({
        doGenerate: async ({ abortSignal }) => {
          if (calls++ === 0) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return response("invalid");
          }
          retrySignal = abortSignal;
          return new Promise((_resolve, reject) => {
            abortSignal!.addEventListener(
              "abort",
              () => reject(abortSignal!.reason),
              { once: true },
            );
          });
        },
      });
      const client = new KaguyaLlmClient({
        model,
        resolveGenerationOptions: () => ({ timeoutMs: 100 }),
      });
      const assertion = expect(client.generate(request)).rejects.toMatchObject({
        stage: "provider-request",
        attemptCount: 2,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(model.doGenerateCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(39);
      expect(retrySignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(retrySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies JSON null as a schema mismatch", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response("null") });
    await expect(
      new KaguyaLlmClient({ model }).generate(request),
    ).rejects.toMatchObject({
      structuredOutputFailure: "schema-mismatch",
      attemptCount: 2,
    });
  });

  it("rejects JSON schemas without a local validator before calling a provider", async () => {
    const model = new MockLanguageModelV3();
    await expect(
      new KaguyaLlmClient({ model }).generate({
        ...request,
        outputSchema: jsonSchema({ type: "object" }),
      }),
    ).rejects.toMatchObject({ stage: "provider-request" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("does not retry transport errors after the first invalid output", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        if (calls++ === 0) return response("invalid");
        throw new APICallError({
          message: "secret",
          url: "https://secret.invalid",
          requestBodyValues: {},
          isRetryable: true,
        });
      },
    });
    await expect(
      new KaguyaLlmClient({ model }).generate(request),
    ).rejects.toMatchObject({
      kind: "retryable",
      stage: "provider-request",
      attemptCount: 2,
      usage: { totalTokens: 5 },
    });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("keeps text generation to one unmodified request", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: response("  plain text  "),
    });
    await expect(
      new KaguyaLlmClient({ model }).generate({
        ...request,
        outputMode: "text",
        outputSchema: z.string(),
      }),
    ).resolves.toMatchObject({ output: "plain text" });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.responseFormat).toEqual({ type: "text" });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain(
      "JSON Schema",
    );
  });
});
