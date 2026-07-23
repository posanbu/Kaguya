import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  scripts?: Record<string, string>;
}

function readPromptTestCommand(): string {
  const promptfooDirectory = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(promptfooDirectory, "..", "package.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as PackageManifest;
  const command = manifest.scripts?.["prompt:test"];
  if (command === undefined) {
    throw new Error("package.json must define scripts.prompt:test");
  }
  return command;
}

function readCrossEnvAssignments(command: string): Record<string, string> {
  const tokens = command.trim().split(/\s+/);
  if (tokens.shift() !== "cross-env") {
    throw new Error("prompt:test must use cross-env");
  }

  const assignments: Record<string, string> = {};
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator < 1) {
      break;
    }
    assignments[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return assignments;
}

describe("prompt:test command", () => {
  it("retains the telemetry controls and loopback egress block", () => {
    const command = readPromptTestCommand();
    const proxySink = "http://127.0.0.1:9";

    expect(readCrossEnvAssignments(command)).toMatchObject({
      PROMPTFOO_DISABLE_TELEMETRY: "1",
      PROMPTFOO_DISABLE_UPDATE: "1",
      HTTPS_PROXY: proxySink,
      HTTP_PROXY: proxySink,
      ALL_PROXY: proxySink,
      NO_PROXY: "",
      https_proxy: proxySink,
      http_proxy: proxySink,
      all_proxy: proxySink,
      no_proxy: "",
    });
    expect(command).toMatch(/\spromptfoo eval --no-cache$/);
  });
});
