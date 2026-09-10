import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { ConfigError } from "./errors.js";
import { jsonObjectSchema, type JsonObject } from "./model.js";
import {
  assertPathInside,
  ensureSensitiveDirectory,
  readSensitiveJson,
  writeSensitiveJson,
} from "./secure-files.js";

const instanceIdSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u);

export const moduleInstanceConfigSchema = z.strictObject({
  version: z.literal(1),
  instanceId: instanceIdSchema,
  definitionId: z.string().trim().min(1),
  enabled: z.boolean(),
  settings: jsonObjectSchema,
});

export type ModuleInstanceConfig = z.infer<typeof moduleInstanceConfigSchema>;

export async function loadModuleInstanceConfigs(options: {
  readonly rootDir: string;
  readonly defaults: readonly ModuleInstanceConfig[];
}): Promise<readonly ModuleInstanceConfig[]> {
  const modulesRoot = join(options.rootDir, "modules");
  assertPathInside(options.rootDir, modulesRoot);
  assertUniqueDefaults(options.defaults);

  if (!(await pathExists(modulesRoot))) {
    await ensureSensitiveDirectory(modulesRoot);
    for (const config of options.defaults) {
      const path = configPath(modulesRoot, config.instanceId);
      await writeSensitiveJson(path, moduleInstanceConfigSchema.parse(config));
    }
    return options.defaults.map((config) => structuredClone(config));
  }

  const stats = await lstat(modulesRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw corrupt("Module configuration root must be a directory");
  }
  const expected = new Map(
    options.defaults.map((item) => [item.instanceId, item]),
  );
  const entries = await readdir(modulesRoot, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !expected.has(entry.name),
    )
  ) {
    throw corrupt("Module configuration contains an unknown instance");
  }
  if (entries.length !== expected.size) {
    throw corrupt("Module configuration is missing an instance");
  }

  const result: ModuleInstanceConfig[] = [];
  for (const expectedConfig of options.defaults) {
    const path = configPath(modulesRoot, expectedConfig.instanceId);
    let value: unknown;
    try {
      value = await readSensitiveJson(path);
    } catch (error) {
      throw error instanceof ConfigError && error.code !== "CONFIG_IO_ERROR"
        ? error
        : corrupt("Module configuration is missing or unreadable", error);
    }
    const parsed = moduleInstanceConfigSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.instanceId !== expectedConfig.instanceId ||
      parsed.data.definitionId !== expectedConfig.definitionId
    ) {
      throw corrupt("Module configuration failed validation");
    }
    result.push(parsed.data);
  }
  return result;
}

function configPath(modulesRoot: string, instanceId: string): string {
  const path = join(modulesRoot, instanceId, "config.json");
  assertPathInside(modulesRoot, path);
  return path;
}

function assertUniqueDefaults(defaults: readonly ModuleInstanceConfig[]): void {
  const ids = new Set<string>();
  for (const item of defaults) {
    const parsed = moduleInstanceConfigSchema.safeParse(item);
    if (!parsed.success || ids.has(item.instanceId)) {
      throw new ConfigError("CONFIG_INVALID_INPUT", "Invalid module defaults");
    }
    ids.add(item.instanceId);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function corrupt(message: string, cause?: unknown): ConfigError {
  return new ConfigError("CONFIG_CORRUPT_STORE", message, { cause });
}
