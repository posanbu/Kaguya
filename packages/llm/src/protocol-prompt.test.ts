import { describe, expect, it } from "vitest";
import { loadStructuredOutputPromptRenderer } from "./node.js";

describe("structured output Prompt resource", () => {
  it("appends the audited template, variable and rendered schema", () => {
    const render = loadStructuredOutputPromptRenderer();
    const prompt = render(
      {
        kind: "route",
        templateId: "test",
        templates: [{ name: "test", content: "route" }],
        text: "route",
        variables: [],
      },
      { type: "object", required: ["action"] },
    );
    expect(prompt.text).toContain("JSON Schema");
    expect(prompt.text).toContain('"required":["action"]');
    expect(prompt.templates.at(-1)?.name).toBe("structured-output-json");
    expect(prompt.variables.at(-1)?.name).toBe("json_schema");
    expect(render(prompt, { type: "object", required: ["action"] })).toBe(
      prompt,
    );
  });
});
