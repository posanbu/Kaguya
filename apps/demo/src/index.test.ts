import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("demo entry point", () => {
  it("runs the deterministic message workflow without a platform sender", () => {
    const result = spawnSync(
      "pnpm",
      ["--filter", "@kaguya/demo", "start"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("message workflow: completed");
  });
});
