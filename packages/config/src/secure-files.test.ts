import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "./errors.js";
import {
  assertPathInside,
  ensureSensitiveDirectory,
  readSensitiveJson,
  writeSensitiveJson,
} from "./secure-files.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-config-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("sensitive file primitives", () => {
  it.runIf(process.platform !== "win32")(
    "enforces owner-only directory and file modes",
    async () => {
      const root = await temporaryRoot();
      const directory = join(root, "profiles");
      const file = join(directory, "index.json");

      await ensureSensitiveDirectory(directory);
      await writeSensitiveJson(file, { version: 1 });
      await chmod(directory, 0o755);
      await chmod(file, 0o644);
      await ensureSensitiveDirectory(directory);
      await readSensitiveJson(file);

      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it("keeps the destination unchanged when failure occurs before rename", async () => {
    const root = await temporaryRoot();
    const file = join(root, "index.json");
    await writeSensitiveJson(file, { value: "original" });

    await expect(writeSensitiveJson(file, { value: 1n })).rejects.toMatchObject(
      { code: "CONFIG_IO_ERROR" },
    );

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      value: "original",
    });
  });

  it("rejects symlinked managed files", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.json");
    const link = join(root, "index.json");
    await writeFile(target, "{}");
    await symlink(target, link);

    await expect(readSensitiveJson(link)).rejects.toMatchObject({
      code: "CONFIG_UNSAFE_PATH",
    } satisfies Partial<ConfigError>);
  });

  it("rejects paths outside the configured root", async () => {
    const root = await temporaryRoot();
    expect(() => assertPathInside(root, join(root, "..", "outside"))).toThrow(
      expect.objectContaining({ code: "CONFIG_UNSAFE_PATH" }),
    );
  });
});
