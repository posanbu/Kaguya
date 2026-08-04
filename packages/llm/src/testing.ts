import { MockLanguageModelV3 } from "ai/test";

export function createDeterministicModel(
  outputs: readonly unknown[],
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "kaguya-deterministic",
    modelId: "deterministic-model",
    doGenerate: outputs.map((output) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(output) ?? "null",
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
    })),
  });
}
