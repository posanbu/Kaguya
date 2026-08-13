import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "./errors.js";
import { FileUserConfigManager } from "./manager.js";
import type { JsonObject, UserConfigProfileSettings } from "./model.js";
import { configurationSetupGuidance } from "./readiness.js";

const atomicWriteFaults = vi.hoisted(() => ({
  postRenameDirectoryFailure: undefined as
    | {
        kind: "open" | "sync" | "close";
        remainingDirectoryOpens: number;
      }
    | undefined,
}));

const sensitiveFileFaults = vi.hoisted(() => ({
  write: [] as {
    target: "index" | "profile";
    message: string;
  }[],
  remove: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      const pendingFailure = atomicWriteFaults.postRenameDirectoryFailure;
      let selectedFailure: "open" | "sync" | "close" | undefined;
      if (pendingFailure !== undefined && flags === "r") {
        pendingFailure.remainingDirectoryOpens -= 1;
        if (pendingFailure.remainingDirectoryOpens === 0) {
          selectedFailure = pendingFailure.kind;
          atomicWriteFaults.postRenameDirectoryFailure = undefined;
        }
      }
      if (selectedFailure === "open") {
        throw Object.assign(new Error("injected directory open failure"), {
          code: "EIO",
        });
      }
      const handle = await actual.open(path, flags, mode);
      if (selectedFailure === "sync") {
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") {
              return async () => {
                throw Object.assign(
                  new Error("injected directory sync failure"),
                  { code: "EIO" },
                );
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      if (selectedFailure === "close") {
        return new Proxy(handle, {
          get(target, property) {
            if (property === "close") {
              return async () => {
                await target.close();
                throw Object.assign(
                  new Error("injected directory close failure"),
                  { code: "EIO" },
                );
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return handle;
    },
  };
});

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
  await initializeReadyManager(root);
  return root;
}

function readySettings(
  models: readonly string[],
  options: { readonly baseUrl?: boolean } = {},
): UserConfigProfileSettings {
  return {
    ai: {
      defaultProviderId: "provider-1",
      modelTiers: {
        light: { providerId: "provider-1", modelId: models[0] ?? "missing" },
        heavy: { providerId: "provider-1", modelId: models[1] ?? "missing" },
      },
      providers: [
        {
          id: "provider-1",
          type: "openai-compatible",
          enabled: true,
          ...(options.baseUrl === false
            ? {}
            : { baseUrl: "https://api.example.test/v1" }),
          apiKey: "test-api-key",
          models: [...models],
          settings: {},
        },
      ],
    },
    platforms: [
      {
        id: "platform-1",
        type: "test",
        enabled: true,
        credentials: {},
        settings: {},
      },
    ],
    plugins: [{ id: "plugin-1", enabled: true, settings: {} }],
  };
}

function reviewSettings(): UserConfigProfileSettings {
  return {
    ai: {
      defaultProviderId: "provider-1",
      modelTiers: {
        light: { providerId: "provider-1", modelId: "model-a" },
        heavy: { providerId: "provider-1", modelId: "model-b" },
      },
      providers: [
        {
          id: "provider-1",
          type: "openai-compatible",
          enabled: true,
          models: ["model-a", "model-b"],
          settings: {},
        },
      ],
    },
    platforms: [],
    plugins: [],
  };
}

async function initializeReadyManager(
  rootDir: string,
): Promise<FileUserConfigManager> {
  return FileUserConfigManager.initialize({
    rootDir,
    name: "default",
    settings: readySettings(["model-a", "model-b"]),
  });
}

afterEach(async () => {
  atomicWriteFaults.postRenameDirectoryFailure = undefined;
  sensitiveFileFaults.write.splice(0);
  sensitiveFileFaults.remove.splice(0);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FileUserConfigManager profile lifecycle", () => {
  it("inspects a missing store without creating files", async () => {
    const rootDir = await createRoot();
    const missingRootDir = join(rootDir, "not-created");

    await expect(
      FileUserConfigManager.inspect({ rootDir: missingRootDir }),
    ).resolves.toEqual({
      status: "setup_required",
      guidance: configurationSetupGuidance,
    });
    await expect(access(missingRootDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      FileUserConfigManager.open({ rootDir: missingRootDir }),
    ).rejects.toMatchObject({
      code: "CONFIG_SETUP_REQUIRED",
    });
    await expect(access(missingRootDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("initializes only a complete acknowledged candidate", async () => {
    const parent = await createRoot();
    const incompleteRootDir = join(parent, "incomplete");
    const reviewRootDir = join(parent, "review");
    const readyRootDir = join(parent, "ready");

    await expect(
      FileUserConfigManager.initialize({
        rootDir: incompleteRootDir,
        name: "incomplete",
        settings: readySettings(["model-a"]),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INCOMPLETE" });
    await expect(access(incompleteRootDir)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      FileUserConfigManager.initialize({
        rootDir: reviewRootDir,
        name: "review",
        settings: readySettings(["model-a", "model-b"], { baseUrl: false }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_REVIEW_REQUIRED" });
    await expect(access(reviewRootDir)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const initialized = await FileUserConfigManager.initialize({
      rootDir: readyRootDir,
      name: "ready",
      settings: readySettings(["model-a", "model-b"]),
    });
    const initializedId = initialized.getDefaultProfileId();
    const reopened = await FileUserConfigManager.open({
      rootDir: readyRootDir,
    });

    expect(reopened.getDefaultProfileId()).toBe(initializedId);
    await expect(reopened.getProfile(initializedId)).resolves.toMatchObject({
      name: "ready",
      ai: { defaultProviderId: "provider-1" },
    });
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

  it.each(["baseUrl", "apiKey", "defaultProviderId"] as const)(
    "rejects an own optional %s key with undefined before changing disk",
    async (field) => {
      const rootDir = await createRoot();
      const manager = await FileUserConfigManager.open({ rootDir });
      const indexPath = join(rootDir, "index.json");
      const beforeIndex = await readFile(indexPath, "utf8");
      const beforeProfiles = await readdir(join(rootDir, "profiles"));
      const provider = {
        id: "provider-1",
        type: "test",
        enabled: true,
        models: [],
        settings: {},
        ...(field === "baseUrl" ? { baseUrl: undefined } : {}),
        ...(field === "apiKey" ? { apiKey: undefined } : {}),
      };
      const initial = {
        ai: {
          providers: [provider],
          ...(field === "defaultProviderId"
            ? { defaultProviderId: undefined }
            : {}),
        },
        platforms: [],
        plugins: [],
      };

      const error = await manager
        .createProfile(`invalid-${field}`, initial as never)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "CONFIG_INVALID_INPUT",
        message: "Configuration profile input failed validation",
      });
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect(manager.listProfiles().map(({ name }) => name)).toEqual([
        "default",
      ]);
      expect(await readFile(indexPath, "utf8")).toBe(beforeIndex);
      expect(await readdir(join(rootDir, "profiles"))).toEqual(beforeProfiles);
    },
  );

  it("keeps absent optional keys absent across create and reopen", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const created = await manager.createProfile("omitted-optionals", {
      ai: {
        providers: [
          {
            id: "provider-1",
            type: "test",
            enabled: true,
            models: [],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });
    const reopened = await FileUserConfigManager.open({ rootDir });
    const reopenedProfile = await reopened.getProfile(created.id);

    expect(reopenedProfile).toEqual(created);
    expect(Object.hasOwn(created.ai, "defaultProviderId")).toBe(false);
    expect(Object.hasOwn(created.ai.providers[0]!, "baseUrl")).toBe(false);
    expect(Object.hasOwn(created.ai.providers[0]!, "apiKey")).toBe(false);
  });

  it("treats an undefined initial value as omitted", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });

    await expect(
      manager.createProfile("omitted-initial", undefined),
    ).resolves.toMatchObject({
      ai: { providers: [] },
      platforms: [],
      plugins: [],
    });
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

  it.each(["open", "sync", "close"] as const)(
    "commits create when post-rename directory %s fails",
    async (failure) => {
      const rootDir = await createRoot();
      const manager = await FileUserConfigManager.open({ rootDir });
      atomicWriteFaults.postRenameDirectoryFailure = {
        kind: failure,
        remainingDirectoryOpens: 2,
      };

      const created = await manager.createProfile("committed-create");

      expect(manager.listProfiles()).toContainEqual(
        expect.objectContaining({
          id: created.id,
          name: "committed-create",
        }),
      );
      expect(
        JSON.parse(
          await readFile(
            join(rootDir, "profiles", `profile_${created.id}.json`),
            "utf8",
          ),
        ),
      ).toMatchObject({ id: created.id, name: "committed-create" });
      expect(
        JSON.parse(await readFile(join(rootDir, "index.json"), "utf8"))
          .profiles,
      ).toContainEqual(
        expect.objectContaining({
          id: created.id,
          name: "committed-create",
        }),
      );
      const reopened = await FileUserConfigManager.open({ rootDir });
      await expect(reopened.getProfile(created.id)).resolves.toMatchObject({
        id: created.id,
        name: "committed-create",
      });
    },
  );

  it.each(["open", "sync", "close"] as const)(
    "commits update when post-rename directory %s fails",
    async (failure) => {
      const rootDir = await createRoot();
      const manager = await FileUserConfigManager.open({ rootDir });
      const created = await manager.createProfile("before-update");
      atomicWriteFaults.postRenameDirectoryFailure = {
        kind: failure,
        remainingDirectoryOpens: 2,
      };

      const updated = await manager.updateProfile(created.id, {
        name: "after-update",
        ai: { providers: [] },
        platforms: [],
        plugins: [{ id: "new-plugin", enabled: true, settings: {} }],
      });

      expect(updated).toMatchObject({
        id: created.id,
        name: "after-update",
        plugins: [{ id: "new-plugin" }],
      });
      expect(manager.listProfiles()).toContainEqual(
        expect.objectContaining({
          id: created.id,
          name: "after-update",
        }),
      );
      expect(
        JSON.parse(
          await readFile(
            join(rootDir, "profiles", `profile_${created.id}.json`),
            "utf8",
          ),
        ),
      ).toMatchObject({
        id: created.id,
        name: "after-update",
        plugins: [{ id: "new-plugin" }],
      });
      const reopened = await FileUserConfigManager.open({ rootDir });
      await expect(reopened.getProfile(created.id)).resolves.toMatchObject({
        id: created.id,
        name: "after-update",
        plugins: [{ id: "new-plugin" }],
      });
    },
  );

  it("rejects non-JSON settings before changing metadata or disk", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const indexPath = join(rootDir, "index.json");
    const beforeIndex = await readFile(indexPath, "utf8");
    const beforeProfiles = await readdir(join(rootDir, "profiles"));

    await expect(
      manager.createProfile("invalid-json", {
        ai: {
          providers: [
            {
              id: "provider-1",
              type: "test",
              enabled: true,
              models: [],
              settings: { nested: { invalid: undefined } },
            },
          ],
        },
        platforms: [],
        plugins: [],
      } as never),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Configuration profile input failed validation",
    });

    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["default"]);
    expect(await readFile(indexPath, "utf8")).toBe(beforeIndex);
    expect(await readdir(join(rootDir, "profiles"))).toEqual(beforeProfiles);
  });

  it("rejects a secret-bearing toJSON value without exposing the secret", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const secret = "rejected-to-json-secret";
    const error = await manager
      .createProfile("invalid-to-json", {
        ai: { providers: [] },
        platforms: [],
        plugins: [
          {
            id: "plugin-1",
            enabled: true,
            settings: {
              nested: {
                toJSON(): never {
                  throw new Error(secret);
                },
              },
            },
          },
        ],
      } as never)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Configuration profile input failed validation",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("round-trips prototype-like JSON keys through create, get, and reopen", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const settings = JSON.parse(
      '{"__proto__":{"constructor":{"prototype":"nested-secret"}},"constructor":"own-constructor","prototype":["own-prototype"]}',
    ) as JsonObject;
    const credentials = JSON.parse(
      '{"__proto__":"credential-proto","constructor":"credential-constructor","prototype":"credential-prototype"}',
    ) as JsonObject;

    const created = await manager.createProfile("prototype-keys", {
      ai: { providers: [] },
      platforms: [
        {
          id: "platform-1",
          type: "test",
          enabled: true,
          credentials,
          settings: {},
        },
      ],
      plugins: [{ id: "plugin-1", enabled: true, settings }],
    });
    const firstRead = await manager.getProfile(created.id);
    const reopened = await FileUserConfigManager.open({ rootDir });
    const reopenedRead = await reopened.getProfile(created.id);

    for (const profile of [created, firstRead, reopenedRead]) {
      const pluginSettings = profile.plugins[0]!.settings;
      const platformCredentials = profile.platforms[0]!.credentials;
      expect(Object.hasOwn(pluginSettings, "__proto__")).toBe(true);
      expect(Object.hasOwn(pluginSettings, "constructor")).toBe(true);
      expect(Object.hasOwn(pluginSettings, "prototype")).toBe(true);
      expect(JSON.stringify(pluginSettings)).toBe(JSON.stringify(settings));
      expect(JSON.stringify(platformCredentials)).toBe(
        JSON.stringify(credentials),
      );
    }

    expect(Object.prototype).not.toHaveProperty("nested-secret");
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
  it("acknowledges current configuration warnings and clears review on update", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profile = await manager.createProfile("review", reviewSettings());
    const profilePath = join(rootDir, "profiles", `profile_${profile.id}.json`);
    const warningIds = [
      "provider-base-url-missing:provider-1",
      "provider-api-key-missing:provider-1",
      "platforms-empty",
      "plugins-empty",
    ];

    const readiness = await manager.inspectProfile(profile.id);
    expect(readiness.status).toBe("review_required");
    if (readiness.status === "review_required") {
      expect(readiness.warnings.map(({ id }) => id)).toEqual(warningIds);
    }
    await manager.bindSession("review-session", profile.id);
    await expect(
      manager.resolveProfile("review-session"),
    ).rejects.toMatchObject({ code: "CONFIG_REVIEW_REQUIRED" });

    const beforeInvalidAcknowledgement = await readFile(profilePath, "utf8");
    await expect(
      manager.acknowledgeConfigurationWarnings(profile.id, ["stale-warning"]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID_INPUT" });
    await expect(readFile(profilePath, "utf8")).resolves.toBe(
      beforeInvalidAcknowledgement,
    );

    await manager.acknowledgeConfigurationWarnings(profile.id, warningIds);
    await expect(
      manager.resolveProfile("review-session"),
    ).resolves.toMatchObject({ id: profile.id });
    await expect(manager.getProfile(profile.id)).resolves.toMatchObject({
      review: { acknowledgedWarnings: [...warningIds].sort() },
    });

    await manager.updateProfile(profile.id, reviewSettings());
    const persistedAfterUpdate = JSON.parse(
      await readFile(profilePath, "utf8"),
    ) as Record<string, unknown>;
    expect(Object.hasOwn(persistedAfterUpdate, "review")).toBe(false);
    await expect(
      manager.resolveProfile("review-session"),
    ).rejects.toMatchObject({ code: "CONFIG_REVIEW_REQUIRED" });
  });

  it("does not fall back when the bound or default profile is incomplete", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const secret = "readiness-error-secret";
    const incomplete = await manager.createProfile("incomplete", {
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            baseUrl: "https://api.example.test/v1",
            apiKey: secret,
            models: ["only-model"],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });

    await manager.bindSession("bound-session", incomplete.id);
    const boundError = await manager
      .resolveProfile("bound-session")
      .catch((caught: unknown) => caught);
    expect(boundError).toMatchObject({ code: "CONFIG_INCOMPLETE" });
    expect(boundError).not.toMatchObject({ id: manager.getDefaultProfileId() });
    for (const representation of [
      String(boundError),
      JSON.stringify(boundError),
    ]) {
      expect(representation).not.toContain(secret);
    }

    await manager.setDefaultProfile(incomplete.id);
    await expect(
      manager.resolveProfile("unbound-session"),
    ).rejects.toMatchObject({ code: "CONFIG_INCOMPLETE" });
  });

  it("keeps secrets out of readiness errors", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const secret = "readiness-error-secret";
    const incomplete = await manager.createProfile("incomplete", {
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            baseUrl: "https://api.example.test/v1",
            apiKey: secret,
            models: ["only-model"],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });
    await manager.bindSession("secret-session", incomplete.id);

    const error = await manager
      .resolveProfile("secret-session")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CONFIG_INCOMPLETE" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

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
    const work = await manager.createProfile(
      "work",
      readySettings(["model-a", "model-b"]),
    );

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
    const work = await manager.createProfile(
      "work",
      readySettings(["model-a", "model-b"]),
    );

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
    const work = await manager.createProfile(
      "work",
      readySettings(["model-a", "model-b"]),
    );

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
    const profile = await manager.createProfile(
      "safe",
      readySettings(["model-a", "model-b"]),
    );

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
    const profile = await manager.createProfile(
      "spaced",
      readySettings(["model-a", "model-b"]),
    );

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
    const profile = await manager.createProfile(
      "constructor-safe",
      readySettings(["model-a", "model-b"]),
    );

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
    const profile = await manager.createProfile(
      "work",
      readySettings(["model-a", "model-b"]),
    );
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
    const profile = await manager.createProfile(
      "work",
      readySettings(["model-a", "model-b"]),
    );
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
    const profile = await manager.createProfile(
      "work",
      readySettings(["model-a", "model-b"]),
    );
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

  it("maps a missing referenced profile to a path-free corrupt-store error", async () => {
    const rootDir = await createRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profileId = manager.getDefaultProfileId();
    await unlink(join(rootDir, "profiles", `profile_${profileId}.json`));

    const error = await FileUserConfigManager.open({ rootDir }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
      message: "Configuration index references a missing profile",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(rootDir);
    expect(String(error)).not.toContain("ENOENT");
    expect(JSON.stringify(error)).not.toContain(rootDir);
    expect(JSON.stringify(error)).not.toContain("ENOENT");
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

describe("FileUserConfigManager runtime input validation", () => {
  const secret = "runtime-input-secret";
  const throwingOptions = new Proxy(
    {},
    {
      get(): never {
        throw new Error(secret);
      },
    },
  );

  it.each([
    ["undefined options", undefined],
    ["null options", null],
    ["missing rootDir", {}],
    ["null rootDir", { rootDir: null }],
    ["non-string rootDir", { rootDir: 42 }],
    ["blank rootDir", { rootDir: "   " }],
    ["NUL-containing rootDir", { rootDir: `invalid${String.fromCharCode(0)}` }],
    ["throwing rootDir getter", throwingOptions],
  ])("rejects %s with a fixed secret-free error", async (_label, options) => {
    const error = await FileUserConfigManager.open(options as never).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "CONFIG_INVALID_INPUT" });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("normalizes invalid public method arguments without native exceptions", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profileId = manager.getDefaultProfileId();
    const operations: [string, () => Promise<unknown>][] = [
      ["null profile name", () => manager.createProfile(null as never)],
      [
        "null initial settings",
        () => manager.createProfile("null-initial", null as never),
      ],
      [
        "primitive initial settings",
        () => manager.createProfile("primitive-initial", 42 as never),
      ],
      ["null update", () => manager.updateProfile(profileId, null as never)],
      ["null get profile ID", () => manager.getProfile(null as never)],
      [
        "numeric default profile ID",
        () => manager.setDefaultProfile(42 as never),
      ],
      [
        "symbol delete profile ID",
        () => manager.deleteProfile(Symbol(secret) as never),
      ],
      [
        "null binding session ID",
        () => manager.bindSession(null as never, profileId),
      ],
      [
        "null binding profile ID",
        () => manager.bindSession("session-1", null as never),
      ],
      [
        "object unbinding session ID",
        () => manager.unbindSession({ secret } as never),
      ],
      [
        "undefined resolving session ID",
        () => manager.resolveProfile(undefined as never),
      ],
    ];

    for (const [label, operation] of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error, label).toMatchObject({ code: "CONFIG_INVALID_INPUT" });
      expect((error as { cause?: unknown }).cause, label).toBeUndefined();
      expect(String(error), label).not.toContain(secret);
      expect(JSON.stringify(error), label).not.toContain(secret);
    }
  });

  it("normalizes revoked proxies across every public input boundary", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const profileId = manager.getDefaultProfileId();
    const revokedProxy = (): object => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    };
    const operations: [string, string, () => Promise<unknown>][] = [
      [
        "open options",
        "Configuration root is invalid",
        () => FileUserConfigManager.open(revokedProxy() as never),
      ],
      [
        "profile name",
        "Configuration profile name must not be empty",
        () => manager.createProfile(revokedProxy() as never),
      ],
      [
        "initial settings",
        "Configuration profile input failed validation",
        () => manager.createProfile("revoked-initial", revokedProxy() as never),
      ],
      [
        "profile update",
        "Configuration profile input failed validation",
        () => manager.updateProfile(profileId, revokedProxy() as never),
      ],
      [
        "get profile ID",
        "Configuration profile ID is invalid",
        () => manager.getProfile(revokedProxy() as never),
      ],
      [
        "default profile ID",
        "Configuration profile ID is invalid",
        () => manager.setDefaultProfile(revokedProxy() as never),
      ],
      [
        "delete profile ID",
        "Configuration profile ID is invalid",
        () => manager.deleteProfile(revokedProxy() as never),
      ],
      [
        "binding session ID",
        "Session ID must not be empty",
        () => manager.bindSession(revokedProxy() as never, profileId),
      ],
      [
        "binding profile ID",
        "Configuration profile ID is invalid",
        () => manager.bindSession("session-1", revokedProxy() as never),
      ],
      [
        "unbinding session ID",
        "Session ID must not be empty",
        () => manager.unbindSession(revokedProxy() as never),
      ],
      [
        "resolving session ID",
        "Session ID must not be empty",
        () => manager.resolveProfile(revokedProxy() as never),
      ],
    ];

    for (const [label, message, operation] of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error, label).toMatchObject({
        code: "CONFIG_INVALID_INPUT",
        message,
      });
      expect((error as { cause?: unknown }).cause, label).toBeUndefined();
      expect(String(error), label).not.toContain(secret);
      expect(JSON.stringify(error), label).not.toContain(secret);
    }
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["default"]);
  });

  it("drops a secret-bearing proxy trap from update errors", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const hostileUpdate = new Proxy(
      {},
      {
        get(): never {
          throw new Error(secret);
        },
      },
    );

    const error = await manager
      .updateProfile(manager.getDefaultProfileId(), hostileUpdate as never)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Configuration profile input failed validation",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("replaces getter-thrown ConfigErrors at create and update boundaries", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const attackerError = new ConfigError(
      "CONFIG_IO_ERROR",
      `${secret}-message`,
      { cause: { attackerCause: secret } },
    );
    const throwingInput = (): object =>
      new Proxy(
        {},
        {
          get(): never {
            throw attackerError;
          },
        },
      );
    const operations: [string, () => Promise<unknown>][] = [
      [
        "create",
        () => manager.createProfile("hostile-create", throwingInput() as never),
      ],
      [
        "update",
        () =>
          manager.updateProfile(
            manager.getDefaultProfileId(),
            throwingInput() as never,
          ),
      ],
    ];

    for (const [label, operation] of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error, label).not.toBe(attackerError);
      expect(error, label).toMatchObject({
        code: "CONFIG_INVALID_INPUT",
        message: "Configuration profile input failed validation",
      });
      expect((error as { cause?: unknown }).cause, label).toBeUndefined();
      for (const representation of [String(error), JSON.stringify(error)]) {
        expect(representation, label).not.toContain(secret);
        expect(representation, label).not.toContain("CONFIG_IO_ERROR");
        expect(representation, label).not.toContain("attackerCause");
      }
    }
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["default"]);
  });

  it.each(["name", "settings", "acknowledgedWarnings"] as const)(
    "replaces a getter-thrown ConfigError while reading initialize %s",
    async (field) => {
      const rootDir = await mkdtemp(join(tmpdir(), "kaguya-config-manager-"));
      roots.push(rootDir);
      const attackerError = new ConfigError(
        "CONFIG_IO_ERROR",
        `${secret}-message`,
        { cause: { attackerCause: secret } },
      );
      const options = new Proxy(
        {
          rootDir,
          name: "hostile-initialize",
          settings: readySettings(["model-a", "model-b"]),
          acknowledgedWarnings: [],
        },
        {
          get(target, property, receiver): unknown {
            if (property === field) {
              throw attackerError;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      const error = await FileUserConfigManager.initialize(
        options as never,
      ).catch((caught: unknown) => caught);

      expect(error).not.toBe(attackerError);
      expect(error).toMatchObject({
        code: "CONFIG_INVALID_INPUT",
        message: "Configuration profile input failed validation",
      });
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      for (const representation of [String(error), JSON.stringify(error)]) {
        expect(representation).not.toContain(secret);
        expect(representation).not.toContain("CONFIG_IO_ERROR");
        expect(representation).not.toContain("attackerCause");
      }
    },
  );

  it("does not inspect getter-thrown revoked proxies at create and update boundaries", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createRoot(),
    });
    const throwingInput = (): object =>
      new Proxy(
        {},
        {
          get(): never {
            const revocable = Proxy.revocable({}, {});
            revocable.revoke();
            throw revocable.proxy;
          },
        },
      );
    const operations: [string, () => Promise<unknown>][] = [
      [
        "create",
        () => manager.createProfile("revoked-create", throwingInput() as never),
      ],
      [
        "update",
        () =>
          manager.updateProfile(
            manager.getDefaultProfileId(),
            throwingInput() as never,
          ),
      ],
    ];

    for (const [label, operation] of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error, label).toMatchObject({
        code: "CONFIG_INVALID_INPUT",
        message: "Configuration profile input failed validation",
      });
      expect((error as { cause?: unknown }).cause, label).toBeUndefined();
    }
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["default"]);
  });
});
