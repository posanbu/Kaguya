import { createRequire } from "node:module";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const Provider = require("./portrait-behavior-provider.cjs");
const directory = mkdtempSync(join(tmpdir(), "portrait-behavior-"));
const profilePath = join(directory, "profile.json");
writeFileSync(
  profilePath,
  JSON.stringify({
    ai: {
      modelTiers: {
        light: {
          providerId: "test",
          modelId: "formation-test",
          generation: { reasoning: "minimal" },
        },
        heavy: {
          providerId: "test",
          modelId: "reply-test",
          generation: { reasoning: "high" },
        },
      },
      providers: [
        {
          id: "test",
          enabled: true,
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-only-placeholder",
        },
      ],
    },
  }),
);
const at = "2026-11-01T12:00:00.000Z";
const scope = JSON.stringify(["qq", "eval", "group", "group-1"]);
const scenario = {
  people: [
    { id: "a", name: "阿岚" },
    { id: "b", name: "小夏" },
  ],
  steps: [
    {
      at,
      messages: [
        { id: "experiment", speaker: "a", text: "实验又得重跑了。" },
        { id: "meeting", speaker: "a", text: "导师让我组会前把结果整理好。" },
      ],
      questions: [
        {
          text: "阿岚最近在忙什么？",
          about: "a",
          review: "结合实验与组会推断近期活动。",
        },
      ],
    },
    {
      at: "2026-11-02T12:00:00.000Z",
      messages: [
        { id: "correction", speaker: "a", text: "我是实验室助理，不是学生。" },
      ],
      questions: [
        { text: "阿岚是什么身份？", about: "a", review: "使用更正后的认识。" },
      ],
    },
  ],
};
const context = { vars: { caseId: "test-inference", scenario } };
function node(
  key = "understanding",
  content = "看来在参与科研，最近忙实验和组会。",
  sourceIds = ["experiment", "meeting"],
) {
  return {
    key,
    kind: "person",
    ownerId: "person:a",
    scope,
    level: 0,
    content,
    sourceIds,
    aliases: ["阿岚"],
    tags: [],
    status: "active",
    evidence: {
      basis: "inference",
      temporality: "recent",
      observedAt: at,
      validFrom: null,
      validUntil: null,
      sourceScope: scope,
      supersedes: [],
    },
  };
}
function completion(value: unknown) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
  };
}
function formationInput(request: any) {
  return JSON.parse(
    request.messages
      .at(-1)
      .content.split("\n")
      .find((line: string) => line.startsWith('{"batchId":')),
  );
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("requires an explicit profile and baseline templates before model calls", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("KAGUYA_EVAL_PROFILE", "");
  expect((await new Provider({}).callApi("", context)).error).toContain(
    "explicitly",
  );
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  vi.stubEnv("KAGUYA_EVAL_BASELINE_TEMPLATES", "");
  expect(
    (
      await new Provider({ config: { variant: "baseline" } }).callApi(
        "",
        context,
      )
    ).error,
  ).toContain("BASELINE");
  expect(fetch).not.toHaveBeenCalled();
});

it("compares identical raw inputs and budgets while ignoring local overrides and review guidance", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const baseline = join(directory, "baseline");
  mkdirSync(baseline);
  const templates = new URL("../packages/modules/templates/", import.meta.url);
  for (const name of readdirSync(templates).filter((n) =>
    n.endsWith(".default.hbs"),
  ))
    copyFileSync(new URL(name, templates), join(baseline, name));
  const filename = join(baseline, "memory.native.form.default.hbs");
  writeFileSync(filename, readFileSync(filename, "utf8") + "\nBASELINE_MARKER");
  writeFileSync(
    join(baseline, "memory.native.form.local.hbs"),
    "LOCAL_OVERRIDE_MUST_NOT_APPEAR",
  );
  vi.stubEnv("KAGUYA_EVAL_BASELINE_TEMPLATES", baseline);
  const fetch = vi.fn(async (_url, init) =>
    completion(
      JSON.parse(init.body).model === "formation-test"
        ? { nodes: [node()], edges: [] }
        : { action: "message", text: "看来最近在做实验。", continuation: null },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const oneStep = {
    vars: {
      ...context.vars,
      scenario: { ...scenario, steps: [scenario.steps[0]] },
    },
  };
  const candidate = await new Provider({
    config: { reasoning: "minimal" },
  }).callApi("", oneStep);
  const baselineResult = await new Provider({
    config: { variant: "baseline", reasoning: "minimal" },
  }).callApi("", oneStep);
  expect(candidate.error).toBeUndefined();
  expect(baselineResult.error).toBeUndefined();
  const a = JSON.parse(candidate.output),
    b = JSON.parse(baselineResult.output);
  expect(a.scenarioDigest).toBe(b.scenarioDigest);
  expect(a.templateDigest).not.toBe(b.templateDigest);
  expect(a.formations[0].input).toEqual(b.formations[0].input);
  expect(a.calls.map((c: any) => [c.model, c.parameters])).toEqual(
    b.calls.map((c: any) => [c.model, c.parameters]),
  );
  expect(
    a.calls.every(
      (c: any) =>
        c.parameters.reasoning_effort === "minimal" &&
        c.parameters.max_tokens === 8192,
    ),
  ).toBe(true);
  expect(b.calls[0].prompt).toContain("BASELINE_MARKER");
  expect(b.calls[0].prompt).not.toContain("LOCAL_OVERRIDE_MUST_NOT_APPEAR");
  for (const request of fetch.mock.calls.map((c) => JSON.parse(c[1].body))) {
    expect(JSON.stringify(request.messages)).not.toContain(
      scenario.steps[0]!.questions[0]!.review,
    );
    expect(JSON.stringify(request.messages)).not.toContain(
      "test-only-placeholder",
    );
  }
});

it("forms from raw sources, publishes a correction, and retains original frozen versions", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const fetch = vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.model === "reply-test")
      return completion({
        action: "message",
        text: "看来最近在做实验。",
        continuation: null,
      });
    const input = formationInput(request);
    if (input.sources[0].id === "experiment") {
      expect(input.existing.fixed).toEqual([]);
      expect(input.sources.map((s: any) => s.text)).toEqual(
        scenario.steps[0]!.messages.map((m) => m.text),
      );
      return completion({ nodes: [node()], edges: [] });
    }
    const old = input.existing.fixed[0];
    return completion({
      nodes: [
        {
          ...node(old.id, "本人更正：是实验室助理。", [
            "experiment",
            "meeting",
            "correction",
          ]),
          evidence: {
            ...node().evidence,
            basis: "self-report",
            temporality: "stable",
            observedAt: scenario.steps[1]!.at,
          },
        },
      ],
      edges: [],
    });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await new Provider({}).callApi("", context);
  expect(result.error).toBeUndefined();
  expect(result.metadata.valid).toBe(true);
  const trace = JSON.parse(result.output);
  expect(trace.formations.map((f: any) => f.publication.status)).toEqual([
    "completed",
    "completed",
  ]);
  expect(trace.answers[0].snapshot.fixed[0]).toMatchObject({
    content: "看来在参与科研，最近忙实验和组会。",
    metadata: { revision: 1, evidence: { basis: "inference" } },
  });
  expect(trace.answers[1].snapshot.fixed[0]).toMatchObject({
    content: "本人更正：是实验室助理。",
    metadata: { revision: 2 },
  });
  expect(trace.historicalReplays[0].snapshot.fixed).toEqual(
    trace.answers[0].snapshot.fixed,
  );
  expect(trace.historicalReplays[0].snapshot.recalled).toEqual(
    trace.answers[0].snapshot.recalled,
  );
  expect(trace.historicalReplays[0].snapshot.cutoff).toEqual(
    trace.answers[0].snapshot.cutoff,
  );
  expect(trace.calls.map((c: any) => c.stage)).toEqual([
    "formation",
    "reply",
    "formation",
    "reply",
  ]);
  expect(trace.calls.map((c: any) => c.parameters.reasoning_effort)).toEqual([
    "minimal",
    "high",
    "minimal",
    "high",
  ]);
  expect(
    trace.calls.every(
      (c: any) => c.promptDigest && c.usage.total_tokens === 120,
    ),
  ).toBe(true);
  const requests = fetch.mock.calls.map((c: any) => JSON.parse(c[1].body));
  expect(requests[1].messages.at(-1).content).toContain("看来在参与科研");
  expect(requests[3].messages).toContainEqual({
    role: "assistant",
    content: "看来最近在做实验。",
  });
});

it.each(["scope", "source"])(
  "records rejected %s proposals without presenting them as valid model behavior",
  async (reason) => {
    vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
    const fetch = vi.fn().mockResolvedValue(
      completion({
        nodes: [
          {
            ...node(),
            ...(reason === "scope"
              ? { scope: "shared" }
              : { sourceIds: ["invented-source"] }),
          },
        ],
        edges: [],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new Provider({}).callApi("", context);
    expect(result.metadata.valid).toBe(false);
    expect(JSON.parse(result.output).formations[0].publication).toMatchObject({
      status: "rejected",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("executes bounded recall against the frozen publication and preserves its trace", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(completion({ nodes: [node()], edges: [] }))
    .mockResolvedValueOnce(
      completion({ action: "recall", query: "阿岚的实验", candidateIds: [] }),
    )
    .mockResolvedValueOnce(
      completion({
        action: "message",
        text: "似乎在忙实验。",
        continuation: null,
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await new Provider({}).callApi("", {
    vars: {
      ...context.vars,
      scenario: { ...scenario, steps: [scenario.steps[0]] },
    },
  });
  expect(result.error).toBeUndefined();
  const trace = JSON.parse(result.output);
  expect(trace.answers[0].recalls[0]).toMatchObject({
    query: "阿岚的实验",
    status: "completed",
    snapshot: { cutoff: trace.answers[0].snapshot.cutoff },
  });
  expect(trace.answers[0].snapshot.recalled).toEqual([]);
});

it("keeps earlier private inference out of a later group answer", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const privateScope = JSON.stringify(["qq", "eval", "private", "a"]);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      completion({
        nodes: [
          {
            ...node(),
            scope: privateScope,
            evidence: { ...node().evidence, sourceScope: privateScope },
          },
        ],
        edges: [],
      }),
    )
    .mockResolvedValueOnce(
      completion({
        action: "message",
        text: "目前没有可用背景。",
        continuation: null,
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await new Provider({}).callApi("", {
    vars: {
      ...context.vars,
      scenario: {
        ...scenario,
        steps: [
          { ...scenario.steps[0], scope: privateScope, questions: [] },
          {
            at: scenario.steps[1]!.at,
            messages: [],
            questions: scenario.steps[0]!.questions,
          },
        ],
      },
    },
  });
  expect(result.error).toBeUndefined();
  expect(JSON.parse(result.output).answers[0].snapshot.fixed).toEqual([]);
  expect(
    JSON.parse(fetch.mock.calls[1]![1].body).messages.at(-1).content,
  ).not.toContain("看来在参与科研");
});

it("rejects a third recall and retains failed calls and partial transcript", async () => {
  vi.stubEnv("KAGUYA_EVAL_PROFILE", profilePath);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(completion({ nodes: [], edges: [] }))
    .mockResolvedValue(
      completion({ action: "recall", query: "背景", candidateIds: [] }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await new Provider({}).callApi("", context);
  expect(result.error).toContain("invalid structured output");
  expect(result.metadata.valid).toBe(false);
  expect(JSON.parse(result.output).calls).toHaveLength(4);
  expect(JSON.parse(result.output).answers[0].recalls).toHaveLength(2);
});
