import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const Provider = require("./portrait-behavior-provider.cjs");
const cases = require("./portrait-behavior-cases.json");
const directory = mkdtempSync(join(tmpdir(), "portrait-behavior-"));
const profilePath = join(directory, "profile.json");
writeFileSync(
  profilePath,
  JSON.stringify({
    ai: {
      modelTiers: { heavy: { providerId: "test", modelId: "test" } },
      providers: [
        {
          id: "test",
          enabled: true,
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-only-secret",
        },
      ],
    },
  }),
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("requires an explicit profile without calling the model", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await new Provider({}).callApi("", cases[0])).error).toContain(
    "explicitly",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it.each([true, false])(
  "carries actual replies across turns with background=%s",
  async (background) => {
    vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "message",
                text: "先理清当前卡点。",
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const result = await new Provider({ config: { background } }).callApi(
      "",
      cases[0],
    );
    expect(result.metadata.valid).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(first.messages[0].content.includes("正在学建筑")).toBe(background);
    const second = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(second.messages).toContainEqual({
      role: "assistant",
      content: "先理清当前卡点。",
    });
  },
);
it("rejects a third recall rather than resetting the expression budget", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: "recall",
              query: "背景",
              candidateIds: [],
            }),
          },
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetch);
  expect(await new Provider({}).callApi("", cases[0])).toEqual({
    error: "Model returned invalid structured output",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
