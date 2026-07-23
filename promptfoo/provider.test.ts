import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ProviderResponse {
  output: string;
  metadata: {
    compilerSource: string;
    kind: string;
  };
}

interface ProviderConstructor {
  new (options: { id: string }): {
    callApi(
      prompt: string,
      context: { vars: Record<string, unknown> },
    ): Promise<ProviderResponse>;
  };
  PROMPT_SOURCE_PATH: string;
}

const require = createRequire(import.meta.url);
const KaguyaPromptProvider = require("./provider.cjs") as ProviderConstructor;

describe("KaguyaPromptProvider", () => {
  it("loads the prompt compiler through the repository source bridge", async () => {
    const promptfooDirectory = path.dirname(fileURLToPath(import.meta.url));
    const expectedSourcePath = path.resolve(
      promptfooDirectory,
      "..",
      "packages",
      "prompt",
      "src",
      "index.ts",
    );
    const provider = new KaguyaPromptProvider({ id: "kaguya-source-test" });

    const response = await provider.callApi("", {
      vars: {
        kind: "state",
        history: [{ role: "user", content: "hello" }],
        currentState: "awake",
        statePolicy: "stay concise",
      },
    });

    expect(KaguyaPromptProvider.PROMPT_SOURCE_PATH).toBe(expectedSourcePath);
    expect(response.metadata.compilerSource).toBe(
      "packages/prompt/src/index.ts",
    );
    expect(response.output).toContain(
      '<state source="state-current">\nawake\n</state>',
    );
  });
});
