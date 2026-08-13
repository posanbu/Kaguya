import type { CompiledPrompt, LlmTrace } from "@kaguya/schema";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

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

function request(
  kind: CompiledPrompt["kind"] = "route",
  traceRecordId = "llm-trace-1",
) {
  return {
    kind,
    modelId: "deterministic-model",
    prompt: { ...prompt, kind },
    traceId: "trace-1",
    workflowId: "message-workflow",
    nodeId: "decide-route",
    traceRecordId,
  };
}

function deterministicClock(...timestamps: string[]) {
  const dates = timestamps.map((timestamp) => new Date(timestamp));
  return () => {
    const next = dates.shift();
    if (next === undefined) {
      throw new Error("test clock exhausted");
    }
    return next;
  };
}

describe("KaguyaLlmClient", () => {
  it("writes a completed trace with normalized usage", async () => {
    const traces: LlmTrace[] = [];
    const model = new MockLanguageModelV3({
      modelId: "deterministic-model",
      doGenerate: modelResult(
        '{"shouldReply":true,"reason":"direct question"}',
      ),
    });
    const client = new KaguyaLlmClient({
      model,
      traceWriter: {
        write(trace) {
          traces.push(trace);
          return Promise.resolve();
        },
      },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.025Z",
      ),
    });

    await expect(client.generate(request())).resolves.toEqual({
      shouldReply: true,
      reason: "direct question",
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(traces).toEqual([
      {
        id: "llm-trace-1",
        traceId: "trace-1",
        workflowId: "message-workflow",
        nodeId: "decide-route",
        kind: "route",
        modelId: "deterministic-model",
        prompt,
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.025Z",
        durationMs: 25,
        status: "completed",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
        },
        response: { shouldReply: true, reason: "direct question" },
      },
    ]);
  });

  it("writes a failed trace before rethrowing a normalized provider error", async () => {
    const order: string[] = [];
    const providerError = new APICallError({
      message: "provider unavailable",
      url: "https://provider.invalid/generate",
      requestBodyValues: {},
      isRetryable: false,
    });
    const model = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(providerError),
    });
    const write = vi.fn((trace: LlmTrace) => {
      order.push(`write:${trace.status}`);
      return Promise.resolve();
    });
    const client = new KaguyaLlmClient({
      model,
      traceWriter: { write },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.010Z",
      ),
    });

    const caught = await client
      .generate(request("route", "llm-trace-2"))
      .catch((error: unknown) => {
        order.push("caught");
        return error;
      });

    expect(caught).toBeInstanceOf(KaguyaLlmError);
    expect(caught).toMatchObject({
      kind: "non-retryable",
      message: "provider unavailable",
      cause: providerError,
    });
    expect(order).toEqual(["write:failed", "caught"]);
    expect(write).toHaveBeenCalledWith({
      id: "llm-trace-2",
      traceId: "trace-1",
      workflowId: "message-workflow",
      nodeId: "decide-route",
      kind: "route",
      modelId: "deterministic-model",
      prompt,
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:00.010Z",
      durationMs: 10,
      status: "failed",
      error: {
        name: "KaguyaLlmError",
        message: "Language model generation failed",
        kind: "non-retryable",
      },
    });
  });

  it("keeps the generation error primary when failed-trace persistence rejects", async () => {
    const providerError = new APICallError({
      message: "provider unavailable",
      url: "https://provider.invalid/generate",
      requestBodyValues: {},
      isRetryable: false,
    });
    const traceWriteError = new Error("trace store unavailable");
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: () => Promise.reject(providerError),
      }),
      traceWriter: {
        write: () => Promise.reject(traceWriteError),
      },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.010Z",
      ),
    });

    const caught = await client
      .generate(request())
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(KaguyaLlmError);
    expect(caught).toMatchObject({
      kind: "non-retryable",
      cause: providerError,
      traceWriteError,
    });
  });

  it("does not persist provider details in a failed trace", async () => {
    const secret = "provider-api-key-must-not-enter-trace";
    const traces: LlmTrace[] = [];
    const client = new KaguyaLlmClient({
      model: new MockLanguageModelV3({
        doGenerate: () =>
          Promise.reject(
            new APICallError({
              message: `provider reflected ${secret}`,
              url: "https://provider.invalid/generate",
              requestBodyValues: {},
              isRetryable: false,
            }),
          ),
      }),
      traceWriter: {
        write(trace) {
          traces.push(trace);
          return Promise.resolve();
        },
      },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.010Z",
      ),
    });

    await expect(client.generate(request())).rejects.toBeInstanceOf(
      KaguyaLlmError,
    );
    expect(JSON.stringify(traces)).not.toContain(secret);
    expect(traces[0]).toMatchObject({
      status: "failed",
      error: { message: "Language model generation failed" },
    });
  });

  it("throws TracePersistenceError when completed-trace persistence rejects", async () => {
    const traceWriteError = new Error("trace store unavailable");
    const client = new KaguyaLlmClient({
      model: createDeterministicModel([{ shouldReply: true }]),
      traceWriter: {
        write: () => Promise.reject(traceWriteError),
      },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.010Z",
      ),
    });

    const caught = await client
      .generate(request())
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({
      name: "TracePersistenceError",
      message: "Failed to persist LLM trace",
      cause: traceWriteError,
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
    const model = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(providerError),
    });
    const client = new KaguyaLlmClient({
      model,
      traceWriter: { write: () => Promise.resolve() },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request())).rejects.toMatchObject({
      kind: "retryable",
    });
  });

  it("normalizes AbortError as cancelled", async () => {
    const abortError = new Error("cancelled by caller");
    abortError.name = "AbortError";
    const model = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(abortError),
    });
    const client = new KaguyaLlmClient({
      model,
      traceWriter: { write: () => Promise.resolve() },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request())).rejects.toMatchObject({
      kind: "cancelled",
    });
  });

  it("rejects invalid JSON structure as a non-retryable response error", async () => {
    const traces: LlmTrace[] = [];
    const client = new KaguyaLlmClient({
      model: createDeterministicModel([{ shouldReply: "yes" }]),
      traceWriter: {
        write(trace) {
          traces.push(trace);
          return Promise.resolve();
        },
      },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.001Z",
      ),
    });

    await expect(
      client.generate(request("route", "llm-trace-3")),
    ).rejects.toMatchObject({
      kind: "non-retryable",
    });
    expect(traces[0]).toMatchObject({
      status: "failed",
      error: { name: "KaguyaLlmError" },
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
    const client = new KaguyaLlmClient({
      model: createDeterministicModel([output]),
      traceWriter: { write: () => Promise.resolve() },
      now: deterministicClock(
        "2026-07-23T00:00:00.000Z",
        "2026-07-23T00:00:00.001Z",
      ),
    });

    await expect(client.generate(request(kind))).resolves.toEqual(output);
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
    [
      "state",
      {
        mood: " ",
        relationship: "trusted",
        shortTermMemories: [],
      },
    ],
    [
      "state",
      {
        mood: "calm",
        relationship: "\n\t",
        shortTermMemories: [],
      },
    ],
    [
      "state",
      {
        mood: "calm",
        relationship: "trusted",
        shortTermMemories: ["valid", " "],
      },
    ],
    ["memory", { memories: ["\n"] }],
  ] as const)(
    "rejects blank generated %s content as non-retryable",
    async (kind, output) => {
      const client = new KaguyaLlmClient({
        model: createDeterministicModel([output]),
        traceWriter: { write: () => Promise.resolve() },
        now: deterministicClock(
          "2026-07-23T00:00:00.000Z",
          "2026-07-23T00:00:00.001Z",
        ),
      });

      await expect(client.generate(request(kind))).rejects.toMatchObject({
        name: "KaguyaLlmError",
        kind: "non-retryable",
      });
    },
  );

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
      const client = new KaguyaLlmClient({
        model: createDeterministicModel([output]),
        traceWriter: { write: () => Promise.resolve() },
        now: deterministicClock(
          "2026-07-23T00:00:00.000Z",
          "2026-07-23T00:00:00.001Z",
        ),
      });

      const result = await client.generate(request(kind));
      expect(JSON.stringify(result)).not.toMatch(/  /);
    }
  });
});
