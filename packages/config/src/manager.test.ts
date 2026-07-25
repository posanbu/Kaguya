import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileUserConfigManager } from "./manager.js";

const sensitiveFileFaults = vi.hoisted(() => ({
  write: [] as {
    target: "index" | "profile";
    message: string;
  }[],
  remove: [] as string[],
}));

vi.mock("./secure-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./secure-files.js")>();
  const { ConfigError } = await import("./errors.js");

  return {
    ...actual,
    async writeSensitiveJson(path: string, value: unknown): Promise<void> {
      const target = path.endsWith("index.json") ? "index" : "profile";
      const fault = sensitiveFileFaults.write[0];
      if (fault?.target === target) {
        sensitiveFileFaults.write.shift();
        throw new ConfigError("CONFIG_IO_ERROR", fault.message);
      }
      await actual.writeSensitiveJson(path, value);
    },
    async removeSensitiveFile(path: string): Promise<void> {
      const message = sensitiveFileFaults.remove.shift();
      if (message !== undefined) {
        throw new ConfigError("CONFIG_IO_ERROR", message);
      }
      await actual.removeSensitiveFile(path);
    },
  };
});

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-config-manager-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  sensitiveFileFaults.write.splice(0);
  sensitiveFileFaults.remove.splice(0);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FileUserConfigManager profile lifecycle", () => {
  it("creates and reopens one default profile", async () => {
    const rootDir = await createRoot();
    const first = await FileUserConfigManager.open({ rootDir });
    const metadata = first.listProfiles();

    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.name).toBe("default");
    expect(first.getDefaultProfileId()).toBe(metadata[0]?.id);
    await expect(first.getProfile(metadata[0]!.id)).resolves.toMatchObject({
      version: 1,
      name: "default",
      ai: { providers: [] },
      platforms: [],
      plugins: [],
    });

    const reopened = await FileUserConfigManager.open({ rootDir });
    expect(reopened.listProfiles()).toEqual(metadata);
  });

  it("round-trips plaintext secrets without listing them", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const created = await manager.createProfile("work", {
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            apiKey: "test-plaintext-key",
            models: ["model-a"],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });

    expect((await manager.getProfile(created.id)).ai.providers[0]?.apiKey).toBe(
      "test-plaintext-key",
    );
    expect(
      await readFile(
        join(rootDir, "profiles", `profile_${created.id}.json`),
        "utf8",
      ),
    ).toContain("test-plaintext-key");
    expect(JSON.stringify(manager.listProfiles())).not.toContain(
      "test-plaintext-key",
    );
  });

  it("returns detached profile values", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const created = await manager.createProfile("work", {
      ai: {
        providers: [
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            apiKey: "test-plaintext-key",
            models: [],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });

    created.ai.providers[0]!.apiKey = "mutated";
    expect((await manager.getProfile(created.id)).ai.providers[0]?.apiKey).toBe(
      "test-plaintext-key",
    );
  });

  it("returns detached profile metadata", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const listed = manager.listProfiles();

    listed[0]!.name = "mutated";

    expect(manager.listProfiles()[0]?.name).toBe("default");
  });

  it("replaces complete settings and normalizes a new name", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile(" work ");
    await expect(
      manager.updateProfile(work.id, {
        name: " renamed ",
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "plugin-1", enabled: false, settings: {} }],
      }),
    ).resolves.toMatchObject({
      name: "renamed",
      plugins: [{ id: "plugin-1", enabled: false }],
    });
  });

  it("rejects a duplicate normalized profile name", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile("work");
    await manager.createProfile("personal");

    await expect(
      manager.updateProfile(work.id, {
        name: " personal ",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_PROFILE_NAME_CONFLICT" });
  });

  it("protects the current default from deletion", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const defaultId = manager.getDefaultProfileId();

    await expect(manager.deleteProfile(defaultId)).rejects.toMatchObject({
      code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
    });
  });

  it("protects the current default from renaming", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const defaultId = manager.getDefaultProfileId();

    await expect(
      manager.updateProfile(defaultId, {
        name: "renamed-default",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
    });
  });

  it("deletes an unused non-default profile", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const removable = await manager.createProfile("removable");

    await manager.deleteProfile(removable.id);
    await expect(manager.getProfile(removable.id)).rejects.toMatchObject({
      code: "CONFIG_PROFILE_NOT_FOUND",
    });
  });

  it("changes the default to an existing profile", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const replacement = await manager.createProfile("replacement");

    await manager.setDefaultProfile(replacement.id);
    expect(manager.getDefaultProfileId()).toBe(replacement.id);
  });

  it("serializes competing profile names", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });

    const results = await Promise.allSettled([
      manager.createProfile("shared"),
      manager.createProfile("shared"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
  });

  it("keeps the mutation queue usable after a rejected operation", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    await manager.createProfile("shared");
    await expect(manager.createProfile("shared")).rejects.toMatchObject({
      code: "CONFIG_PROFILE_NAME_CONFLICT",
    });

    await expect(manager.createProfile("after-failure")).resolves.toMatchObject(
      {
        name: "after-failure",
      },
    );
  });

  it("removes a new profile when its index write fails", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected create index failure",
    });

    await expect(manager.createProfile("work")).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected create index failure",
    });

    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["default"]);
    expect(await readdir(join(rootDir, "profiles"))).toHaveLength(1);
  });

  it("restores the old profile when its update index write fails", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const work = await manager.createProfile("work", {
      ai: { providers: [] },
      platforms: [],
      plugins: [{ id: "old-plugin", enabled: true, settings: {} }],
    });
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected update index failure",
    });

    await expect(
      manager.updateProfile(work.id, {
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "new-plugin", enabled: true, settings: {} }],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected update index failure",
    });

    expect(
      JSON.parse(
        await readFile(
          join(rootDir, "profiles", `profile_${work.id}.json`),
          "utf8",
        ),
      ).plugins,
    ).toEqual([{ id: "old-plugin", enabled: true, settings: {} }]);
  });

  it("reports a failed update rollback as the cause", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const work = await manager.createProfile("work");
    const path = join(rootDir, "profiles", `profile_${work.id}.json`);
    sensitiveFileFaults.write.push(
      {
        target: "index",
        message: "injected update index failure",
      },
      {
        target: "profile",
        message: "injected update rollback failure",
      },
    );

    await expect(
      manager.updateProfile(work.id, {
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "new-plugin", enabled: true, settings: {} }],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: `Failed to restore configuration profile after index write failure: ${path}`,
      cause: {
        code: "CONFIG_IO_ERROR",
        message: "injected update rollback failure",
      },
    });
  });

  it("commits deletion before reporting a profile removal failure", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const removable = await manager.createProfile("removable");
    const path = join(rootDir, "profiles", `profile_${removable.id}.json`);
    sensitiveFileFaults.remove.push("injected profile removal failure");

    await expect(manager.deleteProfile(removable.id)).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected profile removal failure",
    });

    expect(manager.listProfiles()).not.toContainEqual(
      expect.objectContaining({ id: removable.id }),
    );
    expect(
      JSON.parse(await readFile(join(rootDir, "index.json"), "utf8")).profiles,
    ).not.toContainEqual(expect.objectContaining({ id: removable.id }));
    expect(JSON.parse(await readFile(path, "utf8")).id).toBe(removable.id);
  });

  it("keeps the mutation queue usable after an index write failure", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected index write failure",
    });

    await expect(manager.createProfile("failed")).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected index write failure",
    });

    await expect(manager.createProfile("after-failure")).resolves.toMatchObject(
      {
        name: "after-failure",
      },
    );
  });
});

describe("FileUserConfigManager session selection", () => {
  it("falls back to the default profile", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });

    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("resolves an explicit session binding", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile("work");

    await manager.bindSession("session-1", work.id);

    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: work.id,
    });
  });

  it("returns to default fallback after unbinding a session", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile("work");

    await manager.bindSession("session-1", work.id);
    await manager.unbindSession("session-1");

    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("persists an explicit session binding across reopen", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const work = await manager.createProfile("work");

    await manager.bindSession("session-1", work.id);

    const reopened = await FileUserConfigManager.open({ rootDir });
    await expect(reopened.resolveProfile("session-1")).resolves.toMatchObject({
      id: work.id,
    });
  });

  it("persists an unbound session across reopen", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const work = await manager.createProfile("work");

    await manager.bindSession("session-1", work.id);
    await manager.unbindSession("session-1");

    const reopened = await FileUserConfigManager.open({ rootDir });
    await expect(reopened.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("waits for a pending binding before resolving", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const work = await manager.createProfile("work");

    const binding = manager.bindSession("session-1", work.id);
    const resolution = manager.resolveProfile("session-1");

    await binding;
    await expect(resolution).resolves.toMatchObject({ id: work.id });
  });

  it("treats an unbound constructor session ID as unbound", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });

    await expect(manager.resolveProfile("constructor")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("safely persists a __proto__ session binding across reopen", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profile = await manager.createProfile("safe");

    await manager.bindSession("__proto__", profile.id);

    const persistedIndex = JSON.parse(
      await readFile(join(rootDir, "index.json"), "utf8"),
    ) as { sessionBindings: Record<string, string> };
    expect(Object.hasOwn(persistedIndex.sessionBindings, "__proto__")).toBe(
      true,
    );
    expect(persistedIndex.sessionBindings["__proto__"]).toBe(profile.id);

    const reopened = await FileUserConfigManager.open({ rootDir });
    await expect(reopened.resolveProfile("__proto__")).resolves.toMatchObject({
      id: profile.id,
    });
    expect(Object.prototype).not.toHaveProperty("id");
  });

  it("rejects an empty session ID when resolving", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });

    await expect(manager.resolveProfile("   ")).rejects.toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Session ID must not be empty",
    });
  });

  it("rejects an empty session ID before binding writes", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("work");
    sensitiveFileFaults.write.push({
      target: "index",
      message: "unconsumed blank binding fault",
    });

    await expect(manager.bindSession("   ", profile.id)).rejects.toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Session ID must not be empty",
    });
    await expect(manager.createProfile("probe")).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "unconsumed blank binding fault",
    });
  });

  it("rejects an empty session ID before unbinding writes", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    sensitiveFileFaults.write.push({
      target: "index",
      message: "unconsumed blank unbinding fault",
    });

    await expect(manager.unbindSession("   ")).rejects.toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Session ID must not be empty",
    });
    await expect(manager.createProfile("probe")).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "unconsumed blank unbinding fault",
    });
  });

  it("preserves a non-empty session ID exactly", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profile = await manager.createProfile("spaced");

    await manager.bindSession(" session-1 ", profile.id);

    const reopened = await FileUserConfigManager.open({ rootDir });
    await expect(reopened.resolveProfile(" session-1 ")).resolves.toMatchObject(
      { id: profile.id },
    );
    await expect(reopened.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("safely persists a constructor session binding across reopen", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profile = await manager.createProfile("constructor-safe");

    await manager.bindSession("constructor", profile.id);

    const persistedIndex = JSON.parse(
      await readFile(join(rootDir, "index.json"), "utf8"),
    ) as { sessionBindings: Record<string, string> };
    expect(Object.hasOwn(persistedIndex.sessionBindings, "constructor")).toBe(
      true,
    );
    expect(persistedIndex.sessionBindings.constructor).toBe(profile.id);

    const reopened = await FileUserConfigManager.open({ rootDir });
    await expect(reopened.resolveProfile("constructor")).resolves.toMatchObject(
      { id: profile.id },
    );
  });

  it("rejects deleting a profile used by a session", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("bound");
    await manager.bindSession("session-1", profile.id);

    await expect(manager.deleteProfile(profile.id)).rejects.toMatchObject({
      code: "CONFIG_PROFILE_IN_USE",
    });
  });

  it("validates a binding against profile state inside the mutation queue", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("soon-deleted");

    const deletion = manager.deleteProfile(profile.id);
    const binding = manager.bindSession("session-1", profile.id);

    await deletion;
    await expect(binding).rejects.toMatchObject({
      code: "CONFIG_PROFILE_NOT_FOUND",
    });
  });

  it("keeps binding memory unchanged when its index write fails", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("work");
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected binding index failure",
    });

    await expect(
      manager.bindSession("session-1", profile.id),
    ).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected binding index failure",
    });

    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });

  it("keeps the queue usable after a binding index write failure", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("work");
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected binding queue failure",
    });

    await expect(
      manager.bindSession("failed-session", profile.id),
    ).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected binding queue failure",
    });

    await manager.bindSession("working-session", profile.id);
    await expect(
      manager.resolveProfile("working-session"),
    ).resolves.toMatchObject({ id: profile.id });
  });

  it("keeps unbinding memory unchanged when its index write fails", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("work");
    await manager.bindSession("session-1", profile.id);
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected unbinding index failure",
    });

    await expect(manager.unbindSession("session-1")).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected unbinding index failure",
    });

    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: profile.id,
    });
  });

  it("keeps the queue usable after an unbinding index write failure", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profile = await manager.createProfile("work");
    await manager.bindSession("session-1", profile.id);
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected unbinding queue failure",
    });

    await expect(manager.unbindSession("session-1")).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: "injected unbinding queue failure",
    });

    await manager.unbindSession("session-1");
    await expect(manager.resolveProfile("session-1")).resolves.toMatchObject({
      id: manager.getDefaultProfileId(),
    });
  });
});

describe("FileUserConfigManager corruption safety", () => {
  it("fails closed with a fixed error when index JSON is corrupt", async () => {
    const rootDir = await createRoot();
    await FileUserConfigManager.open({ rootDir });
    const secret = "corrupt-index-secret";
    await writeFile(
      join(rootDir, "index.json"),
      `{"token":"${secret}"`,
      "utf8",
    );

    const error = await FileUserConfigManager.open({ rootDir }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
      message: `Configuration JSON is invalid: ${join(rootDir, "index.json")}`,
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("fails closed when a __proto__ binding references an unknown profile", async () => {
    const rootDir = await createRoot();
    await FileUserConfigManager.open({ rootDir });
    const path = join(rootDir, "index.json");
    const index = JSON.parse(await readFile(path, "utf8")) as {
      sessionBindings: Record<string, string>;
    };
    index.sessionBindings = JSON.parse(
      '{"__proto__":"11111111-1111-4111-8111-111111111111"}',
    ) as Record<string, string>;
    await writeFile(path, JSON.stringify(index), "utf8");

    const error = await FileUserConfigManager.open({ rootDir }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
      message: `Configuration index failed validation: ${path}`,
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it("rejects a malformed referenced profile without exposing its secret", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profileId = manager.getDefaultProfileId();
    const path = join(rootDir, "profiles", `profile_${profileId}.json`);
    const secret = "corrupt-profile-secret";
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        id: profileId,
        name: "default",
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "", enabled: true, settings: { token: secret } }],
      }),
      "utf8",
    );

    const error = await FileUserConfigManager.open({ rootDir }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
      message: `Configuration profile failed validation: ${path}`,
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("does not expose rejected secrets in validation errors", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const secret = "never-include-this-secret";

    const error = await manager
      .createProfile("invalid", {
        ai: {
          defaultProviderId: "missing",
          providers: [],
        },
        platforms: [],
        plugins: [{ id: "", enabled: true, settings: { token: secret } }],
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Configuration profile input failed validation",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
