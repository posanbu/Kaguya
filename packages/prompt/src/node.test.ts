import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PromptResourceDefinition } from "./index.js";
import {
  initializeLocalPromptTemplates,
  readPromptResources,
  validatePromptResourceInventory,
} from "./node.js";

function root() {
  const directory = `${mkdtempSync(join(tmpdir(), "kaguya-prompt-"))}/`;
  return pathToFileURL(directory);
}
function definition(
  mutability: "editable" | "readonly" = "editable",
): PromptResourceDefinition {
  return {
    templateId: "sample",
    name: "sample",
    displayName: "Sample",
    description: "Sample resource",
    content: "",
    allowedVariables: ["value"],
    allowedPartials: [],
    composes: [],
    mutability,
  };
}

describe("Prompt resource inventory", () => {
  it("initializes only editable resources", () => {
    const directory = root();
    writeFileSync(new URL("sample.default.hbs", directory), "{{value}}");
    expect(
      initializeLocalPromptTemplates([definition()], directory).created,
    ).toEqual(["sample"]);
    expect(readPromptResources([definition()], directory)[0]?.source).toBe(
      "local",
    );
  });
  it("rejects readonly overrides and orphan resources", () => {
    const readonlyRoot = root();
    writeFileSync(new URL("sample.default.hbs", readonlyRoot), "{{value}}");
    writeFileSync(new URL("sample.local.hbs", readonlyRoot), "override");
    expect(() =>
      readPromptResources([definition("readonly")], readonlyRoot),
    ).toThrow(/Readonly/u);

    const orphanRoot = root();
    writeFileSync(new URL("sample.default.hbs", orphanRoot), "{{value}}");
    writeFileSync(new URL("orphan.default.hbs", orphanRoot), "orphan");
    expect(() =>
      validatePromptResourceInventory([definition()], orphanRoot),
    ).toThrow(/Orphan/u);
  });
});
