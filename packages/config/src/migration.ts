/**
 * 功能概述：启动前把已知 v3 Profile Registry 迁移为严格 v1，不改变 manager 的只读检查契约。
 * 主要职责：migrateLegacyUserConfigRegistry 校验整个索引和全部 Profile，备份后先写 Profile、
 * 最后发布 index；convertProfile 补齐 identity/memory，移除已退役 plugins 和持久化 token。
 * 代码库关系：Server 与开发 PostgreSQL 准备入口调用本模块；复用 model 和 secure-files 的
 * 路径、权限及原子 JSON 写入规则。未知字段与损坏引用报 CONFIG_CORRUPT_STORE；未知版本留给 manager 拒绝。
 * 输入输出与副作用：输入配置根目录，返回备份路径或 undefined；备份保留原 JSON 内容及凭据，
 * 目录 0700、文件 0600。锁阻止并发迁移；写入失败保留备份和 v3 index，重试兼容已转换的
 * Profile。进程崩溃留下的锁须在确认服务停止后人工移除；不输出任何配置正文。
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import {
  DEFAULT_AGENT_IDENTITY,
  jsonObjectSchema,
  userConfigIndexSchema,
  userConfigProfileSchema,
  type UserConfigProfile,
} from "./model.js";
import {
  assertPathInside,
  readSensitiveJson,
  writeSensitiveJson,
} from "./secure-files.js";

const legacyPluginsSchema = z
  .array(
    z.strictObject({
      id: z.string().trim().min(1),
      enabled: z.boolean(),
      settings: jsonObjectSchema,
    }),
  )
  .superRefine((plugins, context) => {
    if (new Set(plugins.map(({ id }) => id)).size !== plugins.length) {
      context.addIssue({ code: "custom", message: "Duplicate plugin IDs" });
    }
  });

export async function migrateLegacyUserConfigRegistry(options: {
  readonly rootDir: string;
}): Promise<{ readonly backupPath: string } | undefined> {
  if (typeof options?.rootDir !== "string" || options.rootDir.trim() === "") {
    throw new ConfigError(
      "CONFIG_INVALID_INPUT",
      "Configuration root directory is required for migration",
    );
  }
  const root = resolve(options.rootDir);
  const indexPath = join(root, "index.json");
  assertPathInside(root, indexPath);
  try {
    await lstat(indexPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const initial = await readSensitiveJson(indexPath);
  // Current and unknown versions remain the responsibility of strict manager validation.
  if (!isRecord(initial) || initial.version !== 3) return undefined;
  const lockPath = join(root, ".migration-lock");
  assertPathInside(root, lockPath);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    throw new ConfigError(
      "CONFIG_IO_ERROR",
      hasCode(error, "EEXIST")
        ? "Configuration migration is locked; stop all Kaguya processes before removing .migration-lock and retrying"
        : "Configuration migration lock could not be created",
    );
  }
  try {
    const originalIndex = await readSensitiveJson(indexPath);
    if (!isRecord(originalIndex) || originalIndex.version !== 3)
      return undefined;
    const parsed = userConfigIndexSchema.safeParse({
      ...originalIndex,
      version: 1,
    });
    if (!parsed.success)
      throw corrupt("Legacy configuration index failed validation");
    const profiles = [];
    for (const metadata of parsed.data.profiles) {
      const path = join(root, "profiles", `profile_${metadata.id}.json`);
      assertPathInside(root, path);
      const original = await readSensitiveJson(path);
      const converted = convertProfile(original);
      if (converted.id !== metadata.id || converted.name !== metadata.name) {
        throw corrupt("Legacy configuration profile does not match its index");
      }
      profiles.push({ path, original, converted });
    }
    const backupPath = join(root, `migration-backup-v3-${randomUUID()}`);
    assertPathInside(root, backupPath);
    // No live content is replaced until the complete backup is durable.
    for (const profile of profiles) {
      await writeSensitiveJson(
        join(backupPath, "profiles", `profile_${profile.converted.id}.json`),
        profile.original,
      );
    }
    // A backup index is published only after every referenced backup Profile exists.
    await writeSensitiveJson(join(backupPath, "index.json"), originalIndex);
    for (const profile of profiles) {
      await writeSensitiveJson(profile.path, profile.converted);
    }
    await writeSensitiveJson(indexPath, parsed.data);
    return { backupPath };
  } finally {
    await rmdir(lockPath);
  }
}

function convertProfile(value: unknown): UserConfigProfile {
  const current = userConfigProfileSchema.safeParse(value);
  if (current.success) return current.data;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Object.hasOwn(value, "plugins") ||
    !legacyPluginsSchema.safeParse(value.plugins).success
  ) {
    throw corrupt("Legacy configuration profile failed validation");
  }
  const converted = { ...value };
  delete converted.plugins;
  if (!Object.hasOwn(converted, "identity"))
    converted.identity = structuredClone(DEFAULT_AGENT_IDENTITY);
  if (!Object.hasOwn(converted, "memory"))
    converted.memory = { enabled: false };
  if (isRecord(converted.runtime)) {
    const runtime = { ...converted.runtime };
    if (
      Object.hasOwn(runtime, "gatewayToken") &&
      (typeof runtime.gatewayToken !== "string" ||
        runtime.gatewayToken.length < 16)
    ) {
      throw corrupt("Legacy runtime token failed validation");
    }
    delete runtime.gatewayToken;
    if (!Object.hasOwn(runtime, "databaseMode"))
      runtime.databaseMode = "external";
    // 缺少白名单时保持网关关闭，等待用户显式选择平台规则。
    if (!Object.hasOwn(runtime, "gatewayAllowlist"))
      runtime.gatewayAllowlist = [];
    converted.runtime = runtime;
  }
  const parsed = userConfigProfileSchema.safeParse(converted);
  if (!parsed.success)
    throw corrupt("Migrated configuration profile failed validation");
  return parsed.data;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
function corrupt(message: string): ConfigError {
  return new ConfigError("CONFIG_CORRUPT_STORE", message);
}
