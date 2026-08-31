/**
 * 功能概述：本测试文件覆盖 `packages/config/src/manager.ts` 的文件制配置注册表实现，
 * 重点验证 v3 `index.json` 与各 Profile 文件之间的持久化契约、显式 bootstrap 流程、
 * Profile 生命周期、回滚/原子写入语义，以及运行时输入边界的失败关闭行为。
 * 主要职责：`bootstrap` 相关用例验证仅在缺失或空根目录下创建保留 `default` Profile，
 * 且按“先写 Profile、后发布 index”的顺序落盘；生命周期用例验证创建、完整替换、
 * 显式选择、删除保护与必填 ID 解析；损坏与输入校验用例验证 legacy 版本拒绝、
 * 敏感字段不泄漏、路径防护和串行化 mutation queue 在失败后仍可继续使用。
 * 代码库关系：该文件直接驱动 `FileUserConfigManager` 的公开 API，并通过 mock
 * `secure-files` 与 `node:fs/promises` 注入 index/profile 写入失败和目录 fsync 故障，
 * 以保护 `secure-files.ts` 的原子写实现和 `model.ts` 的 v3 schema 不变量不被回归。
 * 输入输出与副作用：测试会在系统临时目录创建隔离根目录，真实读写 `index.json`
 * 与 `profiles/profile_<id>.json`，然后在 `afterEach` 中清理；断言内容同时覆盖敏感权限
 * 写入、磁盘字节不变、错误码稳定性，以及默认/已选中 Profile 的删除保护。
 */
import {
  access,
  mkdir,
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  ensureDirectoryCalls: 0,
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
    async ensureSensitiveDirectory(path: string): Promise<void> {
      sensitiveFileFaults.ensureDirectoryCalls += 1;
      await actual.ensureSensitiveDirectory(path);
    },
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

async function createEmptyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-config-manager-"));
  roots.push(root);
  return root;
}

async function createBootstrappedRoot(): Promise<string> {
  const root = await createEmptyRoot();
  await FileUserConfigManager.bootstrap({ rootDir: root });
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

afterEach(async () => {
  atomicWriteFaults.postRenameDirectoryFailure = undefined;
  sensitiveFileFaults.write.splice(0);
  sensitiveFileFaults.remove.splice(0);
  sensitiveFileFaults.ensureDirectoryCalls = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FileUserConfigManager profile lifecycle", () => {
  it.each([
    ["missing root", false],
    ["empty root", true],
  ])(
    "bootstrap creates a reserved default profile for a %s",
    async (_label, precreateRoot) => {
      const parent = await createEmptyRoot();
      const rootDir = join(parent, precreateRoot ? "empty" : "missing");
      if (precreateRoot) {
        await mkdir(rootDir);
      }

      await expect(FileUserConfigManager.inspect({ rootDir })).resolves.toEqual(
        {
          status: "setup_required",
          guidance: configurationSetupGuidance,
        },
      );
      await expect(access(join(rootDir, "index.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const manager = await FileUserConfigManager.bootstrap({ rootDir });

      expect(await readJson(join(rootDir, "index.json"))).toEqual({
        version: 3,
        selectedProfileId: "default",
        profiles: [expect.objectContaining({ id: "default", name: "default" })],
      });
      expect(
        await readJson(join(rootDir, "profiles/profile_default.json")),
      ).toEqual({
        version: 1,
        id: "default",
        name: "default",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      });
      await expect(FileUserConfigManager.inspect({ rootDir })).resolves.toEqual(
        expect.objectContaining({
          status: "invalid",
          selectedProfileId: "default",
          profiles: [
            expect.objectContaining({ id: "default", name: "default" }),
          ],
        }),
      );
      expect(manager.getSelectedProfileId()).toBe("default");
    },
  );

  it("inspects a bootstrapped store without preparing directories", async () => {
    const rootDir = await createBootstrappedRoot();
    sensitiveFileFaults.ensureDirectoryCalls = 0;

    await expect(FileUserConfigManager.inspect({ rootDir })).resolves.toEqual(
      expect.objectContaining({
        status: "invalid",
        selectedProfileId: "default",
      }),
    );

    expect(sensitiveFileFaults.ensureDirectoryCalls).toBe(0);
  });

  it.each(["stray file", "orphaned profiles directory", "existing index"])(
    "bootstrap refuses a %s root without writing",
    async (fixture) => {
      const parent = await createEmptyRoot();
      const rootDir = join(parent, fixture.replaceAll(" ", "-"));
      const indexPath = join(rootDir, "index.json");
      const profilesDir = join(rootDir, "profiles");

      if (fixture === "stray file") {
        await writeFile(rootDir, "occupied", "utf8");
      } else if (fixture === "orphaned profiles directory") {
        await mkdir(rootDir);
        await mkdir(profilesDir);
      } else {
        await FileUserConfigManager.bootstrap({ rootDir });
      }

      const beforeIndex = await readFile(indexPath, "utf8").catch(
        () => undefined,
      );
      const beforeProfiles = await readdir(profilesDir).catch(() => undefined);

      await expect(
        FileUserConfigManager.bootstrap({ rootDir }),
      ).rejects.toMatchObject({
        code: "CONFIG_INVALID_INPUT",
      });

      await expect(
        readFile(indexPath, "utf8").catch(() => undefined),
      ).resolves.toBe(beforeIndex);
      await expect(
        readdir(profilesDir).catch(() => undefined),
      ).resolves.toEqual(beforeProfiles);
    },
  );

  it("round-trips plaintext secrets without listing them", async () => {
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const created = await manager.createProfile("work");
    await manager.replaceProfile(created.id, {
      acknowledgedWarnings: [],
      name: created.name,
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
      const rootDir = await createBootstrappedRoot();
      const manager = await FileUserConfigManager.open({ rootDir });
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

      const created = await manager.createProfile(`invalid-${field}`);
      const indexPath = join(rootDir, "index.json");
      const beforeIndex = await readFile(indexPath, "utf8");
      const beforeProfiles = await readdir(join(rootDir, "profiles"));
      const error = await manager
        .replaceProfile(created.id, {
          acknowledgedWarnings: [],
          name: created.name,
          ...initial,
        } as never)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "CONFIG_INVALID_INPUT",
        message: "Configuration profile input failed validation",
      });
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect(manager.listProfiles().map(({ name }) => name)).toEqual([
        "default",
        created.name,
      ]);
      expect(await readFile(indexPath, "utf8")).toBe(beforeIndex);
      expect(await readdir(join(rootDir, "profiles"))).toEqual(beforeProfiles);
    },
  );

  it("keeps absent optional keys absent across create and reopen", async () => {
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const created = await manager.createProfile("omitted-optionals");
    const replaced = await manager.replaceProfile(created.id, {
      acknowledgedWarnings: [],
      name: created.name,
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

    expect(reopenedProfile).toEqual(replaced);
    expect(Object.hasOwn(replaced.ai, "defaultProviderId")).toBe(false);
    expect(Object.hasOwn(replaced.ai.providers[0]!, "baseUrl")).toBe(false);
    expect(Object.hasOwn(replaced.ai.providers[0]!, "apiKey")).toBe(false);
  });

  it("returns detached profile values", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const created = await manager.createProfile("work");
    const replaced = await manager.replaceProfile(created.id, {
      acknowledgedWarnings: [],
      name: created.name,
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

    replaced.ai.providers[0]!.apiKey = "mutated";
    expect((await manager.getProfile(created.id)).ai.providers[0]?.apiKey).toBe(
      "test-plaintext-key",
    );
  });

  it("returns detached profile metadata", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const listed = manager.listProfiles();

    listed[0]!.name = "mutated";

    expect(manager.listProfiles()[0]?.name).toBe("default");
  });

  it("replaces a profile with a complete payload and keeps the reserved default name", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const work = await manager.createProfile(" work ");
    await expect(
      manager.replaceProfile(work.id, {
        acknowledgedWarnings: [],
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
      rootDir: await createBootstrappedRoot(),
    });
    const work = await manager.createProfile("work");
    await manager.createProfile("personal");

    await expect(
      manager.replaceProfile(work.id, {
        acknowledgedWarnings: [],
        name: " personal ",
        ai: { providers: [] },
        platforms: [],
        plugins: [],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_PROFILE_NAME_CONFLICT" });
  });

  it("protects the reserved default from deletion", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    await expect(manager.deleteProfile("default")).rejects.toMatchObject({
      code: "CONFIG_DEFAULT_PROFILE_PROTECTED",
    });
  });

  it("protects the selected profile from deletion after explicit selection", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const created = await manager.createProfile("work");
    await manager.selectProfile(created.id);

    expect(manager.getSelectedProfileId()).toBe(created.id);
    await expect(manager.deleteProfile(created.id)).rejects.toMatchObject({
      code: "CONFIG_PROFILE_IN_USE",
    });
  });

  it("deletes an unused non-default profile", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const removable = await manager.createProfile("removable");

    await manager.deleteProfile(removable.id);
    await expect(manager.getProfile(removable.id)).rejects.toMatchObject({
      code: "CONFIG_PROFILE_NOT_FOUND",
    });
  });

  it("creates an empty profile without selecting it and supports explicit selection", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const replacement = await manager.createProfile("replacement");

    expect(replacement.id).toMatch(UUID_PATTERN);
    expect(replacement.ai.providers).toEqual([]);
    expect(manager.getSelectedProfileId()).toBe("default");

    await manager.selectProfile(replacement.id);
    expect(manager.getSelectedProfileId()).toBe(replacement.id);
  });

  it("serializes competing profile names", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
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
      rootDir: await createBootstrappedRoot(),
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
      const rootDir = await createBootstrappedRoot();
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
    "commits profile replacement when post-rename directory %s fails",
    async (failure) => {
      const rootDir = await createBootstrappedRoot();
      const manager = await FileUserConfigManager.open({ rootDir });
      const created = await manager.createProfile("before-update");
      atomicWriteFaults.postRenameDirectoryFailure = {
        kind: failure,
        remainingDirectoryOpens: 2,
      };

      const updated = await manager.replaceProfile(created.id, {
        acknowledgedWarnings: [],
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
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const indexPath = join(rootDir, "index.json");
    const beforeIndex = await readFile(indexPath, "utf8");
    const beforeProfiles = await readdir(join(rootDir, "profiles"));

    await expect(
      manager.replaceProfile(manager.getSelectedProfileId(), {
        acknowledgedWarnings: [],
        name: "default",
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
      rootDir: await createBootstrappedRoot(),
    });
    const secret = "rejected-to-json-secret";
    const error = await manager
      .replaceProfile(manager.getSelectedProfileId(), {
        acknowledgedWarnings: [],
        name: "default",
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
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const settings = JSON.parse(
      '{"__proto__":{"constructor":{"prototype":"nested-secret"}},"constructor":"own-constructor","prototype":["own-prototype"]}',
    ) as JsonObject;
    const credentials = JSON.parse(
      '{"__proto__":"credential-proto","constructor":"credential-constructor","prototype":"credential-prototype"}',
    ) as JsonObject;

    const created = await manager.createProfile("prototype-keys");
    const replaced = await manager.replaceProfile(created.id, {
      acknowledgedWarnings: [],
      name: created.name,
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

    for (const profile of [replaced, firstRead, reopenedRead]) {
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
    const rootDir = await createBootstrappedRoot();
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

  it("reports bootstrap cleanup failure after an index write failure", async () => {
    const rootDir = await createEmptyRoot();
    const profilePath = join(rootDir, "profiles", "profile_default.json");
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected bootstrap index failure",
    });
    sensitiveFileFaults.remove.push("injected bootstrap cleanup failure");

    await expect(
      FileUserConfigManager.bootstrap({ rootDir }),
    ).rejects.toMatchObject({
      code: "CONFIG_IO_ERROR",
      message: `Failed to remove bootstrapped profile after index write failure: ${profilePath}`,
      cause: {
        code: "CONFIG_IO_ERROR",
        message: "injected bootstrap cleanup failure",
      },
    });
  });

  it("restores the old profile when its replacement index write fails", async () => {
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const work = await manager.createProfile("work");
    await manager.replaceProfile(work.id, {
      acknowledgedWarnings: [],
      name: work.name,
      ai: { providers: [] },
      platforms: [],
      plugins: [{ id: "old-plugin", enabled: true, settings: {} }],
    });
    sensitiveFileFaults.write.push({
      target: "index",
      message: "injected update index failure",
    });

    await expect(
      manager.replaceProfile(work.id, {
        acknowledgedWarnings: [],
        name: work.name,
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

  it("reports a failed replacement rollback as the cause", async () => {
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const work = await manager.createProfile("work");
    await manager.replaceProfile(work.id, {
      acknowledgedWarnings: [],
      name: work.name,
      ai: { providers: [] },
      platforms: [],
      plugins: [],
    });
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
      manager.replaceProfile(work.id, {
        acknowledgedWarnings: [],
        name: work.name,
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
    const rootDir = await createBootstrappedRoot();
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
      rootDir: await createBootstrappedRoot(),
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

describe("FileUserConfigManager profile resolution", () => {
  it("requires an explicit profile ID and resolves a ready profile by ID", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const profile = await manager.createProfile("work");
    await manager.replaceProfile(profile.id, {
      acknowledgedWarnings: [],
      name: profile.name,
      ...readySettings(["model-a", "model-b"]),
    });

    await expect(
      manager.resolveProfileById(undefined as never),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID_INPUT",
    });
    await expect(manager.resolveProfileById(profile.id)).resolves.toMatchObject(
      {
        id: profile.id,
      },
    );
  });

  it("requires configuration warnings to be acknowledged", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const profile = await manager.createProfile("review");
    await manager.replaceProfile(profile.id, {
      acknowledgedWarnings: [],
      name: profile.name,
      ...reviewSettings(),
    });
    const warningIds = [
      "provider-base-url-missing:provider-1",
      "provider-api-key-missing:provider-1",
      "platforms-empty",
      "plugins-empty",
    ];

    await expect(manager.resolveProfileById(profile.id)).rejects.toMatchObject({
      code: "CONFIG_REVIEW_REQUIRED",
    });
    await manager.acknowledgeConfigurationWarnings(profile.id, warningIds);
    await expect(manager.resolveProfileById(profile.id)).resolves.toMatchObject(
      {
        id: profile.id,
      },
    );
  });

  it("does not expose provider secrets in incomplete-profile errors", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
    });
    const secret = "readiness-error-secret";
    const incomplete = await manager.createProfile("incomplete");
    await manager.replaceProfile(incomplete.id, {
      acknowledgedWarnings: [],
      name: incomplete.name,
      ai: {
        defaultProviderId: "provider-1",
        providers: [
          {
            id: "provider-1",
            type: "openai-compatible",
            enabled: true,
            apiKey: secret,
            models: ["only-model"],
            settings: {},
          },
        ],
      },
      platforms: [],
      plugins: [],
    });

    const error = await manager
      .resolveProfileById(incomplete.id)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFIG_INCOMPLETE" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe("FileUserConfigManager corruption safety", () => {
  it("fails closed with a fixed error when index JSON is corrupt", async () => {
    const rootDir = await createBootstrappedRoot();
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

  it.each([1, 2] as const)(
    "rejects a version %i index without modifying it",
    async (version) => {
      const rootDir = await createBootstrappedRoot();
      await FileUserConfigManager.open({ rootDir });
      const path = join(rootDir, "index.json");
      const index = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      index.version = version;
      if (version === 1) {
        index.sessionBindings = {};
      }
      if (version === 2) {
        index.defaultProfileId = "default";
        delete index.selectedProfileId;
      }
      await writeFile(path, JSON.stringify(index), "utf8");
      const beforeOpen = await readFile(path, "utf8");

      for (const operation of [
        () => FileUserConfigManager.inspect({ rootDir }),
        () => FileUserConfigManager.open({ rootDir }),
        () => FileUserConfigManager.bootstrap({ rootDir }),
      ]) {
        const error = await operation().catch((caught: unknown) => caught);

        expect(error).toMatchObject({
          code: "CONFIG_UNSUPPORTED_VERSION",
          message:
            "Configuration index version 1 or 2 is unsupported; back up the configuration and reinitialize it.",
        });
        expect((error as { cause?: unknown }).cause).toBeUndefined();
        await expect(readFile(path, "utf8")).resolves.toBe(beforeOpen);
      }
    },
  );

  it("rejects a malformed referenced profile without exposing its secret", async () => {
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profileId = manager.getSelectedProfileId();
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
    const rootDir = await createBootstrappedRoot();
    const manager = await FileUserConfigManager.open({ rootDir });
    const profileId = manager.getSelectedProfileId();
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
      rootDir: await createBootstrappedRoot(),
    });
    const secret = "never-include-this-secret";

    const error = await manager
      .replaceProfile(manager.getSelectedProfileId(), {
        acknowledgedWarnings: [],
        name: "default",
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
      rootDir: await createBootstrappedRoot(),
    });
    const profileId = manager.getSelectedProfileId();
    const operations: [string, () => Promise<unknown>][] = [
      ["null profile name", () => manager.createProfile(null as never)],
      [
        "null replacement",
        () => manager.replaceProfile(profileId, null as never),
      ],
      ["null get profile ID", () => manager.getProfile(null as never)],
      ["numeric selected profile ID", () => manager.selectProfile(42 as never)],
      [
        "symbol delete profile ID",
        () => manager.deleteProfile(Symbol(secret) as never),
      ],
      [
        "null resolving profile ID",
        () => manager.resolveProfileById(null as never),
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
      rootDir: await createBootstrappedRoot(),
    });
    const profileId = manager.getSelectedProfileId();
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
        "replacement payload",
        "Configuration profile input failed validation",
        () => manager.replaceProfile(profileId, revokedProxy() as never),
      ],
      [
        "profile replacement",
        "Configuration profile input failed validation",
        () => manager.replaceProfile(profileId, revokedProxy() as never),
      ],
      [
        "get profile ID",
        "Configuration profile ID is invalid",
        () => manager.getProfile(revokedProxy() as never),
      ],
      [
        "selected profile ID",
        "Configuration profile ID is invalid",
        () => manager.selectProfile(revokedProxy() as never),
      ],
      [
        "delete profile ID",
        "Configuration profile ID is invalid",
        () => manager.deleteProfile(revokedProxy() as never),
      ],
      [
        "resolving profile ID",
        "Configuration profile ID is invalid",
        () => manager.resolveProfileById(revokedProxy() as never),
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
      rootDir: await createBootstrappedRoot(),
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
      .replaceProfile(manager.getSelectedProfileId(), hostileUpdate as never)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Configuration profile input failed validation",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("replaces getter-thrown ConfigErrors at replacement boundaries", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
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
        "replacement",
        () =>
          manager.replaceProfile(
            manager.getSelectedProfileId(),
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

  it("replaces a getter-thrown ConfigError while reading bootstrap options", async () => {
    const rootDir = await createEmptyRoot();
    const attackerError = new ConfigError(
      "CONFIG_IO_ERROR",
      `${secret}-message`,
      { cause: { attackerCause: secret } },
    );
    const options = new Proxy(
      {
        rootDir,
      },
      {
        get(target, property, receiver): unknown {
          if (property === "rootDir") {
            throw attackerError;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const error = await FileUserConfigManager.bootstrap(options as never).catch(
      (caught: unknown) => caught,
    );

    expect(error).not.toBe(attackerError);
    expect(error).toMatchObject({
      code: "CONFIG_INVALID_INPUT",
      message: "Configuration root is invalid",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    for (const representation of [String(error), JSON.stringify(error)]) {
      expect(representation).not.toContain(secret);
      expect(representation).not.toContain("CONFIG_IO_ERROR");
      expect(representation).not.toContain("attackerCause");
    }
  });

  it("does not inspect getter-thrown revoked proxies at replacement boundaries", async () => {
    const manager = await FileUserConfigManager.open({
      rootDir: await createBootstrappedRoot(),
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
        "replacement",
        () =>
          manager.replaceProfile(
            manager.getSelectedProfileId(),
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
