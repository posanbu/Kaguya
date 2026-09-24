/**
 * 功能概述：验证联网行为评测的失败边界，防止非法模型结果或服务错误被当作通过。
 * 主要职责：用临时虚构 profile 和内存 fetch 替身覆盖焦点越界、等待耗尽、非法 JSON、
 * 本轮 schema 与旧版对照、合法动作与 HTTP 错误脱敏；不请求真实模型或服务器。
 * 旧冻结快照缺少冷启动字段时保持 unknown，新快照原样重放，不能把缺字段解释为空库。
 * 代码库关系：直接调用 planner-behavior-provider.cjs，并使用生产渲染器和动作 schema。
 * 输入输出与副作用：临时文件在结束后移除，环境变量及 fetch 在每个用例后恢复。
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const Provider = require("./planner-behavior-provider.cjs");
const cases = require("./planner-behavior-cases.json");
const directory = mkdtempSync(join(tmpdir(), "planner-behavior-"));
const profilePath = join(directory, "profile.json");
writeFileSync(
  profilePath,
  JSON.stringify({
    ai: {
      modelTiers: { light: { providerId: "test", modelId: "test" } },
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
const context = (id: string) => ({
  vars: cases.find((c: any) => c.vars.caseId === id).vars,
});
it("requires an explicit profile before making network requests", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    (await new Provider({}).callApi("", context("direct-question"))).error,
  ).toContain("explicitly");
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [
    "direct-question",
    '{"action":"message","reason":"respond","composition":{"focusInputIndexes":[0],"topic":"评测","replyAct":"解释"}}',
    true,
  ],
  [
    "direct-question",
    '{"action":"message","reason":"respond","composition":{"focusInputIndexes":[1],"topic":"评测","replyAct":"解释"}}',
    false,
  ],
  [
    "unfinished",
    '{"action":"wait","reason":"await-more-context","waitSeconds":10}',
    true,
  ],
  [
    "budget-incomplete",
    '{"action":"wait","reason":"await-more-context","waitSeconds":10}',
    false,
  ],
  [
    "direct-question",
    '```json\n{"action":"silent","reason":"no-response-needed"}\n```',
    false,
  ],
  ["direct-question", '{"action":"silent","reason":"respond"}', false],
])("validates %s without repairing output %s", async (id, output, valid) => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: output } }] }),
    }),
  );
  const result = await new Provider({}).callApi("", context(id));
  expect(result.output).toBe(output);
  expect(result.metadata.valid).toBe(valid);
});
it("does not expose provider error bodies or credentials", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const json = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 401, json }),
  );
  expect(
    await new Provider({}).callApi("", context("direct-question")),
  ).toEqual({ error: "Model HTTP 401" });
  expect(json).not.toHaveBeenCalled();
});

it.each([undefined, '{"mode":"contextual","memoryCount":1}'])(
  "preserves snapshot grounding without inferring legacy familiarity: %s",
  async (grounding) => {
    vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"action":"silent","reason":"no-response-needed"}',
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const snapshot = structuredClone(context("direct-question"));
    if (grounding !== undefined)
      snapshot.vars.fixture.variables.context_bootstrap = grounding;
    await new Provider({}).callApi("", snapshot);
    const prompt = JSON.parse(fetch.mock.calls[0]![1].body).messages[0].content;
    expect(prompt).toContain(
      `本轮上下文来源状态：${grounding ?? '{"mode":"unknown","reason":"legacy-snapshot"}'}`,
    );
    if (grounding === undefined)
      expect(snapshot.vars.fixture.variables).not.toHaveProperty(
        "context_bootstrap",
      );
  },
);

it.each(["1", "2"])(
  "uses the requested task contract for an exhausted turn: v%s",
  async (version) => {
    vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
    vi.stubEnv("KAGUYA_EVAL_TASK_VERSION", version);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"action":"silent","reason":"no-response-needed"}',
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const result = await new Provider({}).callApi(
      "",
      context("budget-incomplete"),
    );
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    const schemaText = body.messages[0].content.split(
      "JSON Schema 的 JSON 值，不要使用 Markdown 代码块：",
    )[1];
    expect(schemaText).toBeDefined();
    const schema = JSON.parse(schemaText);
    expect(
      schema.oneOf.some(
        (branch: any) => branch.properties.action.const === "wait",
      ),
    ).toBe(version === "1");
    expect(result.metadata.taskVersion).toBe(version);
    expect(result.metadata.valid).toBe(true);
  },
);
