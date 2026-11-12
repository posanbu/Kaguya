/**
 * 功能概述：把旧 arousal/heartbeat 配置离线合并为 Lifecycle，保留显式设置与启用状态。
 * 主要职责：migrateLifecycleConfig 在首次写入 journal 前合并新版默认与旧值，并使用调用方
 * 注入的真实 Lifecycle settings schema 校验；exists 区分缺失路径与文件系统错误。
 * 代码库关系：Server 和离线迁移入口传入 @kaguya/modules 的 lifecycleSettingsSchema，
 * config 包仅依赖 parse 契约，避免反向依赖模块实现；Cordis tree 继续决定实例启用状态。
 * 输入输出与副作用：仅改配置文件，不启动 Runtime。journal 固定迁移决定，重放时只校验，
 * 不按新默认重算；非法设置在新 journal/目标配置写入前失败，完成标记使再次调用幂等。
 * 调用方负责独占配置目录；写完目标及 tree 后才删除旧目录，失败可由现有 journal 恢复。
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  moduleInstanceConfigSchema,
  type ModuleInstanceConfig,
} from "./module-config.js";
import {
  loadCordisTree,
  writeCordisTree,
  validateCordisTree,
  type CordisPluginTree,
} from "./cordis-tree.js";
import {
  assertPathInside,
  readSensitiveJson,
  writeSensitiveJson,
} from "./secure-files.js";

import { jsonObjectSchema } from "./model.js";

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
  settingsSchema: { parse(input: unknown): unknown },
) {
  const target = defaults.find((c) => c.definitionId === "agent.lifecycle");
  if (!target) return { migrated: false };
  const backup = join(rootDir, "migrations", "lifecycle-v1.json");
  const complete = join(rootDir, "migrations", "lifecycle-v1.complete.json");
  for (const path of [
    backup,
    complete,
    join(rootDir, "modules", target.instanceId, "config.json"),
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
    const defaultSettings = jsonObjectSchema.parse(
      settingsSchema.parse(target.settings),
    );
    const config = moduleInstanceConfigSchema.parse({
      version: 1,
      instanceId: target.instanceId,
      definitionId: target.definitionId,
      settings: settingsSchema.parse({
        ...defaultSettings,
        sleep: {
          ...jsonObjectSchema.parse(defaultSettings.sleep),
          ...old[0]!.settings,
        },
        observation: {
          ...jsonObjectSchema.parse(defaultSettings.observation),
          ...old[1]!.settings,
        },
      }),
    });
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
    validateCordisTree(nextTree, defaults);
    journal = { old, tree, config, nextTree };
    await writeSensitiveJson(backup, journal);
  }
  const config = moduleInstanceConfigSchema.parse(journal.config);
  if (
    config.instanceId !== target.instanceId ||
    config.definitionId !== target.definitionId
  )
    throw new Error("Lifecycle migration journal has an unexpected target");
  // 旧 journal 是已经提交的迁移决定；校验后原样重放，不按当前默认重算。
  settingsSchema.parse(config.settings);
  validateCordisTree(journal.nextTree, defaults);
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
