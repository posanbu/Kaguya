import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("demo entry point", () => {
  it("runs the deterministic message workflow without a platform sender", () => {
    const root = mkdtempSync(join(tmpdir(), "kaguya-demo-test-"));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      {
        cwd: demoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          KAGUYA_DEMO_DATABASE_PATH: join(root, "kaguya.sqlite"),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    rmSync(root, { recursive: true, force: true });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("message module pipeline: completed");
  });
});
