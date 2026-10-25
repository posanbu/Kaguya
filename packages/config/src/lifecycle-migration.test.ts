import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  unlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadModuleInstanceConfigs,
  type ModuleInstanceConfig,
} from "./module-config.js";
import { migrateLifecycleConfig } from "./lifecycle-migration.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const legacy: ModuleInstanceConfig[] = [
  {
    version: 1,
    instanceId: "attention-arousal.default",
    definitionId: "agent.attention.arousal",
    enabled: true,
    settings: { idleSleepEnabled: false, idleSleepAfterMs: 120000 },
  },
  {
    version: 1,
    instanceId: "heartbeat.default",
    definitionId: "agent.heartbeat.short",
    enabled: true,
    settings: { interruptQuietMs: 1500 },
  },
];
const defaults: ModuleInstanceConfig[] = [
  {
    version: 1,
    instanceId: "lifecycle.default",
    definitionId: "agent.lifecycle",
    enabled: true,
    settings: {
      pulse: { intervalMs: 5000 },
      activity: { scopeIdleMs: 120000 },
    },
  },
];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-migrate-"));
  roots.push(root);
  await loadModuleInstanceConfigs({ rootDir: root, defaults: legacy });
  return root;
}
it("backs up, preserves observation settings, migrates both identities and is idempotent", async () => {
  const root = await fixture();
  const original = await readFile(join(root, "cordis.yml"), "utf8");
  const result = await migrateLifecycleConfig(root, defaults);
  expect(result.migrated).toBe(true);
  expect(await readdir(join(root, "modules"))).toEqual(["lifecycle.default"]);
  const configs = await loadModuleInstanceConfigs({
    rootDir: root,
    defaults,
    initialize: false,
  });
  expect(configs[0]?.settings).toMatchObject({
    pulse: { intervalMs: 5000 },
    activity: { scopeIdleMs: 120000 },
    sleep: {
      idleSleepEnabled: true,
      idleSleepAfterMs: 600000,
      nightSleepEnabled: false,
      periodicWakeEveryMs: 300000,
    },
    observation: { interruptQuietMs: 1500 },
  });
  const backup = JSON.parse(await readFile(result.backup!, "utf8"));
  expect(backup.old).toHaveLength(2);
  expect(
    backup.tree.plugins.some((p: any) => p.id === "module.heartbeat.default"),
  ).toBe(true);
  expect(original).toContain("module.heartbeat.default");
  const current = await readFile(
    join(root, "modules/lifecycle.default/config.json"),
    "utf8",
  );
  expect((await migrateLifecycleConfig(root, defaults)).migrated).toBe(false);
  expect(
    await readFile(join(root, "modules/lifecycle.default/config.json"), "utf8"),
  ).toBe(current);
});
it("resumes a journaled migration with mixed old/new directories", async () => {
  const root = await fixture();
  await migrateLifecycleConfig(root, defaults);
  await unlink(join(root, "migrations/lifecycle-v1.complete.json"));
  await mkdir(join(root, "modules/heartbeat.default"));
  expect((await migrateLifecycleConfig(root, defaults)).migrated).toBe(true);
  expect(await readdir(join(root, "modules"))).toEqual(["lifecycle.default"]);
  await expect(
    loadModuleInstanceConfigs({ rootDir: root, defaults, initialize: false }),
  ).resolves.toHaveLength(1);
});
it("refuses contradictory enablement before writing a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-migrate-"));
  roots.push(root);
  await loadModuleInstanceConfigs({
    rootDir: root,
    defaults: legacy.map((c, i) => ({ ...c, enabled: i === 0 })),
  });
  await expect(migrateLifecycleConfig(root, defaults)).rejects.toThrow(
    "different enabled states",
  );
  expect(await readdir(join(root, "modules"))).toHaveLength(2);
});
