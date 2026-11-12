/**
 * 功能概述：以真实 Lifecycle schema 验收旧配置迁移、journal 恢复与失败前不落盘。
 * 主要职责：fixture 建立独立临时配置；snapshot 保存原始文件内容；migrate 调用生产入口；
 * 用例覆盖显式旧值、新默认、禁用状态、非法输入、混合目录、固定 journal 和重复执行。
 * 代码库关系：此跨包测试位于 Server，直接组合 @kaguya/config 与 @kaguya/modules；
 * 不在 config 包复制模块 schema，也不为基础配置包增加反向模块依赖。
 * 输入输出与副作用：仅操作各用例临时目录，所有文件操作有 await；afterEach 清理目录。
 * 无 Runtime、数据库、模型、平台适配器或后台消费者，不用固定 sleep 和轮询替代完成边界。
 */
import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  unlink,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadModuleInstanceConfigs,
  migrateLifecycleConfig,
  type ModuleInstanceConfig,
} from "@kaguya/config";
import { lifecycleSettingsSchema } from "@kaguya/modules";

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
    settings: lifecycleSettingsSchema.parse({}),
  },
];
async function fixture(configs: readonly ModuleInstanceConfig[] = legacy) {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-migrate-"));
  roots.push(root);
  await loadModuleInstanceConfigs({ rootDir: root, defaults: configs });
  return root;
}
function migrate(root: string, nextDefaults = defaults) {
  return migrateLifecycleConfig(root, nextDefaults, lifecycleSettingsSchema);
}
async function snapshot(root: string) {
  return Promise.all([
    readFile(join(root, "cordis.yml"), "utf8"),
    ...legacy.map((c) =>
      readFile(join(root, "modules", c.instanceId, "config.json"), "utf8"),
    ),
  ]);
}
async function current(root: string) {
  return (
    await loadModuleInstanceConfigs({
      rootDir: root,
      defaults,
      initialize: false,
    })
  )[0]!;
}

it("preserves explicit sleep and observation settings, backs up and is idempotent", async () => {
  const root = await fixture();
  const original = await snapshot(root);
  const result = await migrate(root);
  expect(result.migrated).toBe(true);
  expect(await readdir(join(root, "modules"))).toEqual(["lifecycle.default"]);
  expect((await current(root)).settings).toEqual({
    ...lifecycleSettingsSchema.parse({}),
    sleep: {
      ...lifecycleSettingsSchema.parse({}).sleep,
      idleSleepEnabled: false,
      idleSleepAfterMs: 120000,
    },
    observation: {
      ...lifecycleSettingsSchema.parse({}).observation,
      interruptQuietMs: 1500,
    },
  });
  const backup = JSON.parse(await readFile(result.backup!, "utf8"));
  expect(
    backup.old.map((item: { settings: unknown }) => item.settings),
  ).toEqual(legacy.map((item) => item.settings));
  expect(
    backup.tree.plugins.some(
      (p: { id: string }) => p.id === "module.heartbeat.default",
    ),
  ).toBe(true);
  expect(original[0]).toContain("module.heartbeat.default");
  const beforeRepeat = await readFile(
    join(root, "modules/lifecycle.default/config.json"),
    "utf8",
  );
  expect((await migrate(root)).migrated).toBe(false);
  expect(
    await readFile(join(root, "modules/lifecycle.default/config.json"), "utf8"),
  ).toBe(beforeRepeat);
});

it("fills only absent fields from current defaults", async () => {
  const root = await fixture(legacy.map((c) => ({ ...c, settings: {} })));
  await migrate(root);
  expect((await current(root)).settings).toEqual(
    lifecycleSettingsSchema.parse({}),
  );
});

it("preserves all explicit sleep fields and joint disabled state", async () => {
  const sleep = {
    idleSleepEnabled: false,
    idleSleepAfterMs: 120000,
    nightSleepEnabled: true,
    nightSleepStart: "22:30",
    nightSleepEnd: "06:15",
    periodicWakeEnabled: false,
    periodicWakeEveryMs: 45000,
  };
  const root = await fixture(
    legacy.map((c, i) => ({
      ...c,
      enabled: false,
      settings: i === 0 ? sleep : c.settings,
    })),
  );
  await migrate(root);
  const config = await current(root);
  expect(config.enabled).toBe(false);
  expect(config.settings.sleep).toEqual(sleep);
});

it("resumes a journaled migration with mixed directories and ignores changed defaults", async () => {
  const root = await fixture();
  const result = await migrate(root);
  const journalBefore = await readFile(result.backup!, "utf8");
  const configBefore = await readFile(
    join(root, "modules/lifecycle.default/config.json"),
    "utf8",
  );
  await unlink(join(root, "migrations/lifecycle-v1.complete.json"));
  await mkdir(join(root, "modules/heartbeat.default"));
  const changedDefaults = defaults.map((c) => ({
    ...c,
    settings: lifecycleSettingsSchema.parse({
      sleep: { idleSleepAfterMs: 900000 },
    }),
  }));
  expect((await migrate(root, changedDefaults)).migrated).toBe(true);
  expect(await readdir(join(root, "modules"))).toEqual(["lifecycle.default"]);
  expect(await readFile(result.backup!, "utf8")).toBe(journalBefore);
  expect(
    await readFile(join(root, "modules/lifecycle.default/config.json"), "utf8"),
  ).toBe(configBefore);
  expect((await current(root)).settings.sleep).toMatchObject({
    idleSleepEnabled: false,
    idleSleepAfterMs: 120000,
  });
});

it("replays an existing old journal decision without silently rewriting it", async () => {
  const root = await fixture();
  const result = await migrate(root);
  const journal = JSON.parse(await readFile(result.backup!, "utf8"));
  journal.config.settings.sleep.idleSleepEnabled = true;
  journal.config.settings.sleep.idleSleepAfterMs = 600000;
  await writeFile(result.backup!, JSON.stringify(journal));
  await unlink(join(root, "migrations/lifecycle-v1.complete.json"));
  await migrate(root);
  expect((await current(root)).settings.sleep).toMatchObject({
    idleSleepEnabled: true,
    idleSleepAfterMs: 600000,
  });
});

const invalidSettings: {
  module: number;
  settings: ModuleInstanceConfig["settings"];
}[] = [
  { module: 0, settings: { idleSleepAfterMs: 4999 } },
  { module: 0, settings: { idleSleepEnabled: "false" } },
  { module: 0, settings: { nightSleepStart: "25:00" } },
  { module: 0, settings: { periodicWakeEveryMs: -1 } },
  { module: 0, settings: { unexpected: true } },
  { module: 1, settings: { interruptQuietMs: -1 } },
  { module: 1, settings: { maxReplacementAttempts: 0 } },
];
it.each(invalidSettings)(
  "rejects invalid legacy settings before journal or target writes: %j",
  async ({ module, settings }) => {
    const root = await fixture(
      legacy.map((c, i) => ({
        ...c,
        settings: i === module ? settings : c.settings,
      })),
    );
    const before = await snapshot(root);
    await expect(migrate(root)).rejects.toThrow();
    expect(await snapshot(root)).toEqual(before);
    expect((await readdir(join(root, "modules"))).sort()).toEqual(
      legacy.map((c) => c.instanceId).sort(),
    );
    await expect(readdir(join(root, "migrations"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("refuses contradictory enablement before writing a backup", async () => {
  const root = await fixture(
    legacy.map((c, i) => ({ ...c, enabled: i === 0 })),
  );
  const before = await snapshot(root);
  await expect(migrate(root)).rejects.toThrow("different enabled states");
  expect(await snapshot(root)).toEqual(before);
  await expect(readdir(join(root, "migrations"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["missing-legacy", "unjournaled-target"])(
  "refuses %s directories before writing a journal",
  async (mode) => {
    const root = await fixture();
    if (mode === "missing-legacy")
      await rm(join(root, "modules/heartbeat.default"), { recursive: true });
    else await mkdir(join(root, "modules/lifecycle.default"));
    await expect(migrate(root)).rejects.toThrow(
      "both legacy instances and no unjournaled target",
    );
    await expect(readdir(join(root, "migrations"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("validates a journal before replacing target configuration", async () => {
  const root = await fixture();
  const result = await migrate(root);
  const before = await readFile(
    join(root, "modules/lifecycle.default/config.json"),
    "utf8",
  );
  const journal = JSON.parse(await readFile(result.backup!, "utf8"));
  journal.config.settings.sleep.idleSleepAfterMs = -1;
  await writeFile(result.backup!, JSON.stringify(journal));
  await unlink(join(root, "migrations/lifecycle-v1.complete.json"));
  await expect(migrate(root)).rejects.toThrow();
  expect(
    await readFile(join(root, "modules/lifecycle.default/config.json"), "utf8"),
  ).toBe(before);
  await expect(
    readFile(join(root, "migrations/lifecycle-v1.complete.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
