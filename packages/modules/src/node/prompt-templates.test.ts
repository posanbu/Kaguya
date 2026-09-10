import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadFirstPartyPromptTemplates } from "./prompt-templates.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function root(): { path: string; url: URL } {
  const path = mkdtempSync(join(tmpdir(), "kaguya-prompts-"));
  roots.push(path);
  return { path, url: pathToFileURL(`${path}/`) };
}

describe("loadFirstPartyPromptTemplates", () => {
  it("prefers local files and preserves whitespace", () => {
    const directory = root();
    writeDefaults(directory.path);
    writeFileSync(join(directory.path, "llm-reply.local.hbs"), "  local\n");

    const loaded = loadFirstPartyPromptTemplates({ root: directory.url });
    expect(loaded.llmReply.main).toBe("  local\n");
    expect(loaded.llmReply.history).toBe("llm-reply.history");
    expect(loaded.personFact).toBe("person-fact");
  });

  it("rejects an empty selected template", () => {
    const directory = root();
    writeDefaults(directory.path);
    writeFileSync(join(directory.path, "llm-reply.local.hbs"), "");
    expect(() =>
      loadFirstPartyPromptTemplates({ root: directory.url }),
    ).toThrow("Prompt template is empty: llm-reply");
  });

  it("does not hide a local-template read failure behind the default", () => {
    const directory = root();
    writeDefaults(directory.path);
    mkdirSync(join(directory.path, "llm-reply.local.hbs"));
    expect(() =>
      loadFirstPartyPromptTemplates({ root: directory.url }),
    ).toThrow();
  });

  it("keeps every local Handlebars override out of Git", () => {
    expect(readFileSync(join(process.cwd(), ".gitignore"), "utf8")).toContain(
      "packages/modules/templates/*.local.hbs",
    );
  });

  it("keeps tracked default templates on LF across Git checkouts", () => {
    expect(
      readFileSync(join(process.cwd(), ".gitattributes"), "utf8"),
    ).toContain("packages/modules/templates/*.default.hbs text eol=lf");
  });
});

const templateNames = [
  "llm-reply",
  "llm-reply.history",
  "llm-reply.history-inbound",
  "llm-reply.history-assistant",
  "llm-reply.memory",
  "llm-reply.memory-item",
  "llm-reply.quoted",
  "llm-reply.target",
  "person-fact",
] as const;

function writeDefaults(path: string): void {
  for (const name of templateNames)
    writeFileSync(join(path, `${name}.default.hbs`), name);
}
