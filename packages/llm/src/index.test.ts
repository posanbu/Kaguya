/**
 * 功能概述：验证底层 `KaguyaLlmClient` 只负责模型调用、结构化输出校验、错误分类与耗时统计，
 * 不再承担 trace 或其他持久化副作用。
 * 主要职责：覆盖成功结果的 output/usage/duration、四类结构化输出、字符串规范化、SDK JSON
 * 输出请求，以及 provider、AbortError、无效 JSON/结构的 `KaguyaLlmError` 分类。
 * 代码库关系：测试使用 `ai/test` 的确定性模型驱动 `client.ts`；Runtime 的 LLM lifecycle
 * 会消费这里返回的 `KaguyaLlmGeneration` 并把 requested/completed/failed 事实写入信息账本。
 * 输入输出与副作用：测试仅执行内存模型，不连接数据库；断言构造 client 和调用 generate
 * 都不需要 trace writer，避免低层 client 恢复旧 `LlmTrace` 写入边界。
 */
import type { CompiledPrompt } from "@kaguya/schema";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { KaguyaLlmClient, KaguyaLlmError } from "./client.js";
import * as llm from "./index.js";
import { createDeterministicModel } from "./testing.js";

const prompt: CompiledPrompt = {
  kind: "route",
  text: "<policy>decide whether to reply</policy>",
  fragments: [],
  provenance: [],
};

function modelResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: {
        total: 3,
        noCache: 3,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  };
}

function request(kind: CompiledPrompt["kind"] = "route") {
  return {
    kind,
    modelId: "deterministic-model",
    prompt: { ...prompt, kind },
  };
}

function deterministicClock(...timestamps: string[]) {
  const dates = timestamps.map((timestamp) => new Date(timestamp));
  return () => {
    const next = dates.shift();
    if (next === undefined) throw new Error("test clock exhausted");
    return next;
  };
}

function clientFor(output: unknown): KaguyaLlmClient {
  return new KaguyaLlmClient({
    model: createDeterministicModel([output]),
    now: deterministicClock(
      "2026-09-04T00:00:00.000Z",
      "2026-09-04T00:00:00.025Z",
    ),
  });
}

describe("KaguyaLlmClient", () => {
  it("returns validated output, normalized usage, and duration without persistence", async () => {
    const model = new MockLanguageModelV3({
      modelId: "deterministic-model",
      doGenerate: modelResult('{"text":"Moonlight."}'),
    });
    const client = new KaguyaLlmClient({
      model,
      now: deterministicClock(
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.025Z",
      ),
    });

    await expect(client.generate(request("reply"))).resolves.toEqual({
      output: { text: "Moonlight." },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      durationMs: 25,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("rethrows a normalized provider error without a persistence dependency", async () => {
    const providerError = new APICallError({
      message: "provider unavailable",
      url: "https://provider.invalid/generate",
      requestBodyValues: {},
      isRetryable: false,
    });
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: () => Promise.reject(providerError),
      }),
      now: deterministicClock(
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.010Z",
      ),
    });

    await expect(client.generate(request())).rejects.toMatchObject({
      name: "KaguyaLlmError",
      kind: "non-retryable",
      message: "provider unavailable",
      cause: providerError,
    });
  });

  it("preserves explicit provider retryability through AI SDK retry wrapping", async () => {
    const providerError = new APICallError({
      message: "rate limited",
      url: "https://provider.invalid/generate",
      requestBodyValues: {},
      responseHeaders: { "retry-after-ms": "0" },
      isRetryable: true,
    });
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: () => Promise.reject(providerError),
      }),
      now: deterministicClock(
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request())).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("normalizes AbortError as cancelled", async () => {
    const abortError = new Error("cancelled by caller");
    abortError.name = "AbortError";
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: () => Promise.reject(abortError),
      }),
      now: deterministicClock(
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request())).rejects.toMatchObject({
      kind: "cancelled",
    });
  });

  it("rejects invalid structured output as non-retryable", async () => {
    await expect(
      clientFor({ shouldReply: "yes" }).generate(request("route")),
    ).rejects.toMatchObject({
      name: "KaguyaLlmError",
      kind: "non-retryable",
      message: "Invalid response structure for structured output",
    });
  });

  it("normalizes malformed JSON without parsing it manually", async () => {
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({ doGenerate: modelResult("plain text") }),
      now: deterministicClock(
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request())).rejects.toMatchObject({
      name: "KaguyaLlmError",
      kind: "non-retryable",
      message: "Invalid JSON response for structured output",
    });
  });

  it.each([
    ["reply", { text: "hello" }],
    [
      "state",
      {
        mood: "calm",
        relationship: "trusted",
        shortTermMemories: ["likes tea"],
      },
    ],
    ["memory", { memories: ["The user likes tea."] }],
  ] as const)("strictly parses %s outputs", async (kind, output) => {
    await expect(
      clientFor(output).generate(request(kind)),
    ).resolves.toMatchObject({
      output,
      durationMs: 25,
    });
  });

  it("requests structured output from the SDK for reply generation", async () => {
    const model = new MockLanguageModelV3({
      modelId: "deterministic-model",
      doGenerate: modelResult('{"text":"hello"}'),
    });
    const client = new KaguyaLlmClient({
      model,
      now: deterministicClock(
        "2026-09-04T00:00:00.000Z",
        "2026-09-04T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request("reply"))).resolves.toMatchObject({
      output: { text: "hello" },
    });
    expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({
      type: "json",
      name: "replyOutput",
      schema: { type: "object", required: ["text"] },
    });
  });

  it("exports the single per-kind output schemas consumed by applications", () => {
    const exports = llm as unknown as Record<string, unknown>;
    expect(exports.routeOutputSchema).toBeDefined();
    expect(exports.replyOutputSchema).toBeDefined();
    expect(exports.stateOutputSchema).toBeDefined();
    expect(exports.memoryOutputSchema).toBeDefined();
  });

  it.each([
    ["route", { shouldReply: true, reason: "   " }],
    ["reply", { text: "" }],
    ["state", { mood: " ", relationship: "trusted", shortTermMemories: [] }],
    ["memory", { memories: ["\n"] }],
  ] as const)("rejects blank generated %s content", async (kind, output) => {
    await expect(
      clientFor(output).generate(request(kind)),
    ).rejects.toBeInstanceOf(KaguyaLlmError);
  });

  it("trims every accepted generated string", async () => {
    const outputs = [
      { shouldReply: true, reason: "  direct question  " },
      { text: "  hello  " },
      {
        mood: "  calm ",
        relationship: " trusted  ",
        shortTermMemories: ["  likes tea ", "asks questions  "],
      },
      { memories: ["  durable fact  "] },
    ] as const;

    for (const [kind, output] of [
      ["route", outputs[0]],
      ["reply", outputs[1]],
      ["state", outputs[2]],
      ["memory", outputs[3]],
    ] as const) {
      const result = await clientFor(output).generate(request(kind));
      expect(JSON.stringify(result.output)).not.toMatch(/  /);
    }
  });
});
