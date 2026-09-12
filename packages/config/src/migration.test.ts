/**
 * 功能概述：验证 v3 Registry 启动迁移的保真、安全边界与中断恢复。
 * 主要职责：构造多 Profile 旧仓库，检查原始凭据/退役字段备份、v1 就绪检查、权限及幂等性；
 * 对未知字段、索引引用、符号链接、锁和写失败注入断言，防止迁移部分覆盖未验证的数据。
 * 代码库关系：真实调用 migration、manager 与 secure-files；仅在指定落盘点模拟 I/O 失败。
 * 输入输出与副作用：在系统临时目录读写虚构凭据，afterEach 清理，绝不读取实际用户配置。
 */
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrateLegacyUserConfigRegistry } from "./migration.js";
import { FileUserConfigManager } from "./manager.js";
import { writeSensitiveJson } from "./secure-files.js";

const faults = vi.hoisted(() => ({ target: "" }));
vi.mock("./secure-files.js", async (original) => {
  const actual = await original<typeof import("./secure-files.js")>();
  return {
    ...actual,
    writeSensitiveJson: async (path: string, value: unknown) => {
      if (
        path === faults.target ||
        (faults.target === "backup" && path.includes("migration-backup-v3-"))
      ) {
        faults.target = "";
        throw new Error("Injected write failure");
      }
      await actual.writeSensitiveJson(path, value);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  faults.target = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const secondaryId = "70aa75a2-8d9b-4ca0-8796-f5af15a12ec2";
const timestamp = "2026-09-11T00:00:00.000Z";
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "kaguya-migration-"));
  roots.push(rootDir);
  const index = {
    version: 3,
    selectedProfileId: secondaryId,
    profiles: [
      {
        id: "default",
        name: "default",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: secondaryId,
        name: "QQ",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
  const profiles = index.profiles.map(({ id, name }) => ({
    version: 1,
    id,
    name,
    ai: {
      defaultProviderId: "provider",
      providers: [
        {
          id: "provider",
          type: "openai-compatible",
          enabled: true,
          apiKey: "test-api-secret",
          baseUrl: "https://example.com/v1",
          models: ["model"],
          settings: { custom: true },
        },
      ],
    },
    platforms: [
      {
        id: "qq",
        type: "napcat",
        enabled: true,
        credentials: { accessToken: "test-platform-secret" },
        settings: { wsUrl: "ws://localhost:3001" },
      },
    ],
    plugins: [
      { id: "legacy", enabled: true, settings: { key: "test-plugin-secret" } },
    ],
    runtime: {
      host: "127.0.0.1",
      port: 3000,
      databaseUrl: "postgresql://user:password@localhost/kaguya",
      gatewayToken: "test-legacy-gateway-token",
      webDistPath: "apps/web/dist",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      logLevel: "info",
      logFormat: "json",
    },
  }));
  await writeSensitiveJson(join(rootDir, "index.json"), index);
  for (const profile of profiles)
    await writeSensitiveJson(profilePath(rootDir, profile.id), profile);
  return { rootDir, index, profiles };
}
function profilePath(root: string, id: string) {
  return join(root, "profiles", `profile_${id}.json`);
}
async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

it("migrates every profile, preserves selection and credentials, and keeps a complete private backup", async () => {
  const { rootDir, index, profiles } = await fixture();
  await expect(
    FileUserConfigManager.inspect({ rootDir }),
  ).rejects.toMatchObject({ code: "CONFIG_CORRUPT_STORE" });
  const result = await migrateLegacyUserConfigRegistry({ rootDir });
  expect(result).toBeDefined();
  expect(await json(join(result!.backupPath, "index.json"))).toEqual(index);
  for (const original of profiles) {
    expect(await json(profilePath(result!.backupPath, original.id))).toEqual(
      original,
    );
    const converted = await json(profilePath(rootDir, original.id));
    expect(converted).toMatchObject({
      ai: original.ai,
      platforms: original.platforms,
      identity: { name: "Kaguya" },
      memory: { enabled: false },
      runtime: { databaseMode: "external", gatewayAllowlist: [] },
    });
    expect(converted).not.toHaveProperty("plugins");
    expect(converted.runtime).not.toHaveProperty("gatewayToken");
    if (process.platform !== "win32")
      expect(
        (await stat(profilePath(result!.backupPath, original.id))).mode & 0o777,
      ).toBe(0o600);
  }
  if (process.platform !== "win32")
    expect((await stat(result!.backupPath)).mode & 0o777).toBe(0o700);
  const manager = await FileUserConfigManager.open({ rootDir });
  expect(manager.getSelectedProfileId()).toBe(secondaryId);
  expect(manager.listProfiles()).toEqual(index.profiles);
  await expect(
    FileUserConfigManager.inspect({ rootDir }),
  ).resolves.toMatchObject({ selectedProfileId: secondaryId });
  const before = await readdir(rootDir);
  expect(await migrateLegacyUserConfigRegistry({ rootDir })).toBeUndefined();
  expect(await readdir(rootDir)).toEqual(before);
});

it.each(["unknown-field", "bad-plugin", "mismatched-id", "invalid-runtime"])(
  "rejects %s before replacing any live content or making backups",
  async (kind) => {
    const { rootDir, profiles } = await fixture();
    const invalid = structuredClone(profiles[1]!) as Record<string, unknown>;
    if (kind === "unknown-field") invalid.unrecognized = "sensitive-input";
    if (kind === "bad-plugin") invalid.plugins = [{ enabled: true }];
    if (kind === "mismatched-id") invalid.id = "default";
    if (kind === "invalid-runtime")
      invalid.runtime = { databaseUrl: "sensitive-input" };
    await writeSensitiveJson(profilePath(rootDir, secondaryId), invalid);
    const beforeIndex = await readFile(join(rootDir, "index.json"), "utf8");
    const beforeProfile = await readFile(
      profilePath(rootDir, "default"),
      "utf8",
    );
    const error = await migrateLegacyUserConfigRegistry({ rootDir }).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code: "CONFIG_CORRUPT_STORE" });
    expect(String(error)).not.toContain("sensitive-input");
    expect(await readFile(join(rootDir, "index.json"), "utf8")).toBe(
      beforeIndex,
    );
    expect(await readFile(profilePath(rootDir, "default"), "utf8")).toBe(
      beforeProfile,
    );
    expect((await readdir(rootDir)).sort()).toEqual(["index.json", "profiles"]);
  },
);

it("preserves existing memory, identity, managed database mode, and allowlist", async () => {
  const { rootDir, profiles } = await fixture();
  await writeSensitiveJson(profilePath(rootDir, "default"), {
    ...profiles[0],
    memory: { enabled: true },
    identity: { name: "Custom", aliases: ["Alias"], persona: "Custom persona" },
    runtime: {
      ...profiles[0]!.runtime,
      databaseMode: "managed",
      gatewayAllowlist: ["qq:group:123"],
    },
  });
  await migrateLegacyUserConfigRegistry({ rootDir });
  expect(await json(profilePath(rootDir, "default"))).toMatchObject({
    memory: { enabled: true },
    identity: { name: "Custom" },
    runtime: { databaseMode: "managed", gatewayAllowlist: ["qq:group:123"] },
  });
});

it.each(["index", "second-profile"])(
  "can resume after a failed %s write without losing the original backup",
  async (target) => {
    const { rootDir, profiles } = await fixture();
    faults.target =
      target === "index"
        ? join(rootDir, "index.json")
        : profilePath(rootDir, secondaryId);
    await expect(migrateLegacyUserConfigRegistry({ rootDir })).rejects.toThrow(
      "Injected write failure",
    );
    expect((await json(join(rootDir, "index.json"))).version).toBe(3);
    const backup = (await readdir(rootDir)).find((name) =>
      name.startsWith("migration-backup-"),
    )!;
    expect(await json(profilePath(join(rootDir, backup), "default"))).toEqual(
      profiles[0],
    );
    await migrateLegacyUserConfigRegistry({ rootDir });
    await expect(
      FileUserConfigManager.open({ rootDir }),
    ).resolves.toBeInstanceOf(FileUserConfigManager);
    expect(await json(profilePath(join(rootDir, backup), "default"))).toEqual(
      profiles[0],
    );
  },
);

it("refuses concurrent or stale migration locks", async () => {
  const { rootDir } = await fixture();
  await mkdir(join(rootDir, ".migration-lock"));
  await expect(
    migrateLegacyUserConfigRegistry({ rootDir }),
  ).rejects.toMatchObject({ code: "CONFIG_IO_ERROR" });
  expect((await json(join(rootDir, "index.json"))).version).toBe(3);
});
it("rejects symlinked profile files without touching the target", async () => {
  const { rootDir } = await fixture();
  const target = profilePath(rootDir, "default");
  const before = await readFile(target, "utf8");
  await rm(profilePath(rootDir, secondaryId));
  await symlink(target, profilePath(rootDir, secondaryId));
  await expect(
    migrateLegacyUserConfigRegistry({ rootDir }),
  ).rejects.toMatchObject({ code: "CONFIG_UNSAFE_PATH" });
  expect(await readFile(target, "utf8")).toBe(before);
});
it.each([2, 4])(
  "leaves unsupported index v%s unchanged for strict manager rejection",
  async (version) => {
    const { rootDir, index } = await fixture();
    await writeSensitiveJson(join(rootDir, "index.json"), {
      ...index,
      version,
    });
    expect(await migrateLegacyUserConfigRegistry({ rootDir })).toBeUndefined();
    await expect(FileUserConfigManager.open({ rootDir })).rejects.toMatchObject(
      { code: "CONFIG_CORRUPT_STORE" },
    );
    expect((await json(join(rootDir, "index.json"))).version).toBe(version);
  },
);
it("does not bootstrap a missing registry", async () => {
  const { rootDir } = await fixture();
  const missing = join(rootDir, "missing");
  expect(
    await migrateLegacyUserConfigRegistry({ rootDir: missing }),
  ).toBeUndefined();
  await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not replace live files when backup creation fails", async () => {
  const { rootDir, index, profiles } = await fixture();
  faults.target = "backup";
  await expect(migrateLegacyUserConfigRegistry({ rootDir })).rejects.toThrow(
    "Injected write failure",
  );
  expect(await json(join(rootDir, "index.json"))).toEqual(index);
  for (const profile of profiles)
    expect(await json(profilePath(rootDir, profile.id))).toEqual(profile);
  expect(await readdir(rootDir)).not.toContain(".migration-lock");
  await expect(
    migrateLegacyUserConfigRegistry({ rootDir }),
  ).resolves.toHaveProperty("backupPath");
});
it("rejects an empty root instead of interpreting it as the current working directory", async () => {
  await expect(
    migrateLegacyUserConfigRegistry({ rootDir: " " }),
  ).rejects.toMatchObject({ code: "CONFIG_INVALID_INPUT" });
});
