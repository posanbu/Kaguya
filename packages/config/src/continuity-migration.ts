/**
 * Adds the disabled continuity module to a complete pre-continuity store.
 * Strict loading remains unchanged. A journal freezes both trees before either
 * destination is written, so startup can resume after an interrupted write.
 * Existing module files and Profile data are never replaced. The caller owns
 * exclusive access to the configuration directory during migration.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import {
  loadCordisTree,
  parseCordisTreeText,
  validateCordisTree,
  writeCordisTree,
} from "./cordis-tree.js";
import {
  loadModuleInstanceConfigs,
  moduleInstanceConfigSchema,
  readStoredModuleInstanceConfig,
  type ModuleInstanceConfig,
} from "./module-config.js";
import {
  assertPathInside,
  readSensitiveJson,
  readSensitiveText,
  writeSensitiveJson,
} from "./secure-files.js";

const journalSchema = z.strictObject({
  version: z.literal(1),
  config: moduleInstanceConfigSchema,
  tree: z.unknown(),
  nextTree: z.unknown(),
});

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalidMigration(): never {
  throw new ConfigError(
    "CONFIG_CORRUPT_STORE",
    "Continuity migration found incomplete or changed configuration",
  );
}

export async function migrateContinuityConfig(
  rootDir: string,
  defaults: readonly ModuleInstanceConfig[],
): Promise<{ migrated: boolean; backup?: string }> {
  const target = defaults.find(
    (item) => item.definitionId === "agent.continuity",
  );
  if (!target) return { migrated: false };
  const previous = defaults.filter((item) => item !== target);
  const modulesRoot = join(rootDir, "modules");
  const targetRoot = join(modulesRoot, target.instanceId);
  const backup = join(rootDir, "migrations", "continuity-v1.json");
  const complete = join(rootDir, "migrations", "continuity-v1.complete.json");
  for (const path of [modulesRoot, targetRoot, backup, complete])
    assertPathInside(rootDir, path);
  if (await exists(complete)) return { migrated: false, backup };

  let journal: z.infer<typeof journalSchema>;
  const journalExists = await exists(backup);
  if (journalExists) {
    const parsed = journalSchema.safeParse(await readSensitiveJson(backup));
    if (!parsed.success) invalidMigration();
    journal = parsed.data;
  } else {
    // New installations use the regular initializer. Existing installations
    // with this module still go through the strict loader, without repair.
    if (!(await exists(modulesRoot)) || (await exists(targetRoot)))
      return { migrated: false };
    const tree = await loadCordisTree({
      rootDir,
      modules: previous,
      initialize: false,
    });
    await loadModuleInstanceConfigs({
      rootDir,
      defaults: previous,
      treeSnapshot: tree,
      initialize: false,
    });
    const { enabled: _enabled, ...config } = target;
    journal = {
      version: 1,
      config: moduleInstanceConfigSchema.parse(config),
      tree,
      nextTree: {
        plugins: [
          ...tree.plugins,
          {
            id: `module.${target.instanceId}`,
            name: "kaguya/module/agent.continuity",
            disabled: true,
          },
        ],
      },
    };
  }

  const tree = validateCordisTree(journal.tree, previous);
  const nextTree = validateCordisTree(journal.nextTree, defaults);
  if (
    journal.config.instanceId !== target.instanceId ||
    journal.config.definitionId !== target.definitionId ||
    !isDeepStrictEqual(nextTree.plugins, [
      ...tree.plugins,
      {
        id: `module.${target.instanceId}`,
        name: "kaguya/module/agent.continuity",
        disabled: true,
      },
    ])
  )
    invalidMigration();
  const treePath = join(rootDir, "cordis.yml");
  assertPathInside(rootDir, treePath);
  const currentTree = parseCordisTreeText(await readSensitiveText(treePath));
  if (
    !isDeepStrictEqual(currentTree, tree) &&
    !isDeepStrictEqual(currentTree, nextTree)
  )
    invalidMigration();

  // A crash can leave the target directory empty. Validate all old instances
  // before replaying, without treating that journaled directory as corruption.
  const entries = await readdir(modulesRoot, { withFileTypes: true });
  const oldEntries = entries.filter(
    (entry) => entry.name !== target.instanceId,
  );
  if (
    oldEntries.length !== previous.length ||
    entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
    oldEntries.some(
      (entry) => !previous.some((item) => item.instanceId === entry.name),
    )
  )
    invalidMigration();
  for (const expected of previous)
    await readStoredModuleInstanceConfig(modulesRoot, expected);
  const configPath = join(targetRoot, "config.json");
  assertPathInside(rootDir, configPath);
  if (await exists(configPath)) {
    if (
      !isDeepStrictEqual(
        await readStoredModuleInstanceConfig(modulesRoot, target),
        journal.config,
      )
    )
      invalidMigration();
  }
  if (!journalExists) await writeSensitiveJson(backup, journal);
  if (!(await exists(configPath)))
    await writeSensitiveJson(configPath, journal.config);
  await writeCordisTree(rootDir, nextTree, defaults);
  await writeSensitiveJson(complete, { version: 1 });
  return { migrated: true, backup };
}
