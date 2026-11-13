import { expect, it } from "vitest";
import { nativeMemorySnapshotSchema } from "@kaguya/schema";
import { createFormationPromptRenderer } from "./formation-prompt.js";

it("renders the frozen request unchanged and preserves legacy prompt variables", () => {
  const input = {
    batchId: "batch",
    scope: "scope",
    sources: [],
    existing: nativeMemorySnapshotSchema.parse({
      version: 1,
      status: "enabled",
      frozenAt: "2026-11-01T00:00:00Z",
      scope: "scope",
      owners: [],
      fixed: [],
      recalled: [],
      degraded: [],
      budget: { dynamicCharacters: 0, omittedNodeIds: [] },
    }),
  };
  const render = createFormationPromptRenderer("{{context}}");
  const prompt = render(input, ["source"]);
  expect(prompt.templateId).toBe("memory.native.form.v1");
  expect(JSON.parse(prompt.text)).toEqual(input);
  expect(prompt.variables).toEqual([
    {
      name: "context",
      content: JSON.stringify(input),
      informationIds: ["source"],
    },
  ]);
  const next = render(
    { ...input, formationPolicy: "experience-operations.v1" },
    ["source"],
  );
  expect(JSON.parse(next.text)).toMatchObject({
    ...input,
    formationRules: { policy: "experience-operations.v1" },
  });
  expect(JSON.parse(next.text).formationRules.instructions).toContain(
    "不把旁观者内容归给被提问者",
  );
  expect(JSON.parse(prompt.text)).not.toHaveProperty("formationRules");
  expect(input).not.toHaveProperty("formationRules");
});
