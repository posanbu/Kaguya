/**
 * 功能概述：验证离线评测 provider 确实加载仓库源码，而非复制生产 Prompt 逻辑。
 * 主要职责：测试通用 state 渲染桥与 message 真实编译、完整输入和旧版 kind 拒绝。
 * 代码库关系：直接调用 provider.cjs 并检查实际文本和 rendererSource，无模型服务。
 * 输入输出与副作用：动态加载本地 TypeScript 源码和模板，不访问网络。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ProviderResponse {
  output: string;
  metadata: {
    rendererSource: string;
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
  it("loads the pure prompt renderer through the repository source bridge", async () => {
    const promptfooDirectory = path.dirname(fileURLToPath(import.meta.url));
    const expectedSourcePath = path.resolve(
      promptfooDirectory,
      "..",
      "packages",
      "modules",
      "src",
      "prompt-template.ts",
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
    expect(response.metadata.rendererSource).toBe(
      "packages/modules/src/prompt-template.ts",
    );
    expect(response.output).toContain("[state-current]\nawake");
    expect(response.output).not.toContain("<state");
  });
});

describe("message composer evaluation", () => {
  it("uses the real composer and preserves all frozen inputs", async () => {
    const provider = new KaguyaPromptProvider({ id: "message-source-test" });
    const inputs = Array.from({ length: 35 }, (_, i) => `TURN_INPUT_${i}`);
    const result = await provider.callApi("", {
      vars: { kind: "message", persona: "MESSAGE_PERSONA", turn: { inputs } },
    });
    expect(result.metadata.rendererSource).toBe(
      "packages/modules/src/first-party/message-composer/message-prompt.ts",
    );
    expect(result.metadata.kind).toBe("message");
    for (const input of inputs) expect(result.output).toContain(input);
    expect(result.output).not.toContain("LEGACY_COPIED_BODY");
    expect(result.output).not.toContain("【目标消息】");
  });
  it("rejects the retired reply kind", async () => {
    const provider = new KaguyaPromptProvider({ id: "message-source-test" });
    await expect(
      provider.callApi("", { vars: { kind: "reply" } }),
    ).rejects.toThrow("unsupported prompt kind");
  });
});
