import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
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
  removeSensitiveFile,
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
    expect(await readdir(root)).toEqual(["index.json"]);
  });

  it("does not expose values that cause JSON serialization to fail", async () => {
    const root = await temporaryRoot();
    const file = join(root, "index.json");
    const secret = "serialization-secret-7f889ea4";
    const serializationError = Object.assign(new Error(secret), {
      detail: secret,
    });
    const value = {
      toJSON(): never {
        throw serializationError;
      },
    };

    const error: unknown = await writeSensitiveJson(file, value).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "CONFIG_IO_ERROR" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    for (const property of Object.getOwnPropertyNames(error)) {
      expect(String(Reflect.get(Object(error), property))).not.toContain(
        secret,
      );
    }
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

  it("removes a validated managed file", async () => {
    const root = await temporaryRoot();
    const file = join(root, "index.json");
    await writeSensitiveJson(file, { version: 1 });

    await removeSensitiveFile(file);

    await expect(readFile(file, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects intermediate symlinks that escape the configured root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const file = join(root, "profiles", "secret.json");
    await writeFile(join(outside, "secret.json"), '{"secret":"outside"}');
    await symlink(outside, join(root, "profiles"));

    expect(() => assertPathInside(root, file)).toThrow(
      expect.objectContaining({ code: "CONFIG_UNSAFE_PATH" }),
    );
  });

  it("allows missing managed paths inside a missing configured root", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "config");

    expect(() =>
      assertPathInside(root, join(root, "profiles", "profile_1.json")),
    ).not.toThrow();
  });

  it("rejects paths outside the configured root", async () => {
    const root = await temporaryRoot();
    expect(() => assertPathInside(root, join(root, "..", "outside"))).toThrow(
      expect.objectContaining({ code: "CONFIG_UNSAFE_PATH" }),
    );
  });
});
