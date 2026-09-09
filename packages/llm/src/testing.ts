import { MockLanguageModelV3 } from "ai/test";

export function createDeterministicModel(
  outputs: readonly unknown[],
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "kaguya-deterministic",
    modelId: "deterministic-model",
    doGenerate: outputs.map(deterministicResult),
  });
}

export function createRepeatingDeterministicModel(
  output: unknown,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "kaguya-deterministic",
    modelId: "deterministic-model",
    doGenerate: async (request) =>
      deterministicResult(
        request.responseFormat?.type === "text" ? textOutput(output) : output,
      ),
  });
}

export function createDeferredDeterministicModel(output: unknown): {
  readonly model: MockLanguageModelV3;
  readonly started: Promise<void>;
  release(): void;
} {
  let markStarted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    model: new MockLanguageModelV3({
      provider: "kaguya-deterministic",
      modelId: "deferred-deterministic-model",
      async doGenerate(request) {
        markStarted?.();
        await gate;
        return deterministicResult(
          request.responseFormat?.type === "text" ? textOutput(output) : output,
        );
      },
    }),
    started,
    release() {
      release?.();
    },
  };
}

function textOutput(output: unknown): unknown {
  if (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    Object.keys(output).length === 1 &&
    typeof (output as { text?: unknown }).text === "string"
  )
    return (output as { text: string }).text;
  return output;
}

function deterministicResult(output: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof output === "string"
            ? output
            : (JSON.stringify(output) ?? "null"),
      },
    ],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: {
        total: 0,
        noCache: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: 0,
        text: 0,
        reasoning: 0,
      },
    },
    warnings: [],
  };
}
