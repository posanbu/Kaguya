import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  moduleInstanceConfigSchema,
  type ModuleInstanceConfig,
} from "./module-config.js";
import {
  loadCordisTree,
  writeCordisTree,
  type CordisPluginTree,
} from "./cordis-tree.js";
import {
  assertPathInside,
  readSensitiveJson,
  writeSensitiveJson,
} from "./secure-files.js";

const oldIds = ["attention-arousal.default", "heartbeat.default"] as const;
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Explicit startup migration. The journal is outside modules, so strict readers stay strict. */
export async function migrateLifecycleConfig(
  rootDir: string,
  defaults: readonly ModuleInstanceConfig[],
) {
  const target = defaults.find((c) => c.definitionId === "agent.lifecycle");
  if (!target) return { migrated: false };
  const backup = join(rootDir, "migrations", "lifecycle-v1.json");
  const complete = join(rootDir, "migrations", "lifecycle-v1.complete.json");
  for (const path of [
    backup,
    complete,
    ...oldIds.map((id) => join(rootDir, "modules", id)),
  ])
    assertPathInside(rootDir, path);
  if (await exists(complete)) return { migrated: false, backup };
  type Journal = {
    old: unknown[];
    tree: CordisPluginTree;
    config: unknown;
    nextTree: CordisPluginTree;
  };
  let journal: Journal;
  if (await exists(backup))
    journal = (await readSensitiveJson(backup)) as Journal;
  else {
    const present = await Promise.all(
      oldIds.map((id) => exists(join(rootDir, "modules", id))),
    );
    if (present.every((p) => !p)) return { migrated: false };
    if (
      present.some((p) => !p) ||
      (await exists(join(rootDir, "modules", target.instanceId)))
    )
      throw new Error(
        "Lifecycle migration requires both legacy instances and no unjournaled target",
      );
    const old = await Promise.all(
      oldIds.map(async (id) =>
        moduleInstanceConfigSchema.parse(
          await readSensitiveJson(join(rootDir, "modules", id, "config.json")),
        ),
      ),
    );
    if (
      old[0]!.definitionId !== "agent.attention.arousal" ||
      old[1]!.definitionId !== "agent.heartbeat.short"
    )
      throw new Error(
        "Lifecycle migration found an unexpected legacy identity",
      );
    const legacyDefaults = [
      ...defaults.filter((c) => c !== target),
      ...old.map((c) => ({ ...c, enabled: true })),
    ];
    const tree = await loadCordisTree({
      rootDir,
      modules: legacyDefaults,
      initialize: false,
    });
    const nodes = tree.plugins.filter((p) =>
      oldIds.some((id) => p.id === `module.${id}`),
    );
    if (nodes.length !== 2 || nodes[0]!.disabled !== nodes[1]!.disabled)
      throw new Error(
        "Lifecycle migration cannot merge different enabled states",
      );
    const config = {
      version: 1,
      instanceId: target.instanceId,
      definitionId: target.definitionId,
      settings: {
        ...target.settings,
        sleep: {
          ...old[0]!.settings,
          idleSleepEnabled: true,
          idleSleepAfterMs: 600000,
          nightSleepEnabled: false,
          periodicWakeEnabled: true,
          periodicWakeEveryMs: 300000,
        },
        observation: { ...old[1]!.settings },
      },
    };
    const nextTree = {
      plugins: [
        ...tree.plugins.filter((p) => !nodes.includes(p)),
        {
          id: `module.${target.instanceId}`,
          name: "kaguya/module/agent.lifecycle",
          disabled: nodes[0]!.disabled,
        },
      ],
    };
    journal = { old, tree, config, nextTree };
    await writeSensitiveJson(backup, journal);
  }
  const config = moduleInstanceConfigSchema.parse(journal.config);
  await writeSensitiveJson(
    join(rootDir, "modules", target.instanceId, "config.json"),
    config,
  );
  await writeCordisTree(rootDir, journal.nextTree, defaults);
  for (const id of oldIds)
    await rm(join(rootDir, "modules", id), { recursive: true, force: true });
  await writeSensitiveJson(complete, {
    version: 1,
    completedAt: new Date().toISOString(),
  });
  return { migrated: true, backup };
}
