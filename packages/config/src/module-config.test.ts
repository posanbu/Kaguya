/**
 * 功能概述：验证模块配置首次落盘与已有配置的拒绝策略。
 * 主要职责：覆盖只读状态查询不初始化配置、默认实例、版本/身份及插件树校验；附加实例以内联 settings 独立保存。
 * 代码库关系：直接调用 module-config 的加载器与信封 schema，使用临时目录模拟 Server 配置根。
 * 输入输出与副作用：仅写测试临时目录，afterEach 清理；错误不得悄悄重写用户配置。
 */
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadModuleInstanceConfigs,
  moduleInstanceConfigSchema,
  writeModuleInstanceConfig,
  type ModuleInstanceConfig,
} from "./module-config.js";
import { loadCordisTree, writeCordisTree } from "./cordis-tree.js";

const roots: string[] = [];
const defaults: readonly ModuleInstanceConfig[] = [
  {
    version: 1,
    instanceId: "heavy.default",
    definitionId: "agent.heavy",
    enabled: true,
    settings: {},
  },
  {
    version: 1,
    instanceId: "heartbeat.default",
    definitionId: "agent.heartbeat.short",
    enabled: false,
    settings: { interruptQuietMs: 1000 },
  },
];
const storedHeavy = {
  version: 1 as const,
  instanceId: "heavy.default",
  definitionId: "agent.heavy",
  settings: {},
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("module instance configuration", () => {
  it("loads arbitrary instances and updates their inline settings without instance directories", async () => {
    const rootDir = await createRoot();
    await loadModuleInstanceConfigs({ rootDir, defaults });
    const base = await loadCordisTree({ rootDir, modules: defaults });
    const entries = ["first", "second"].map((name) => ({
      id: `module.echo.${name}`,
      name: "@example/echo",
      definitionId: "example.echo",
      disabled: name === "second",
      settings: { label: name },
    }));
    await writeCordisTree(
      rootDir,
      { plugins: [...base.plugins, ...entries] },
      defaults,
    );
    const configs = await loadModuleInstanceConfigs({ rootDir, defaults });
    expect(configs.slice(defaults.length)).toEqual(
      entries.map((entry) => ({
        version: 1,
        instanceId: entry.id.slice(7),
        definitionId: entry.definitionId,
        enabled: !entry.disabled,
        settings: entry.settings,
      })),
    );
    await writeModuleInstanceConfig(
      rootDir,
      {
        ...configs[defaults.length]!,
        settings: { label: "edited" },
      },
      defaults,
    );
    const updated = await loadModuleInstanceConfigs({ rootDir, defaults });
    expect(updated[defaults.length]?.settings).toEqual({ label: "edited" });
    expect(updated[defaults.length + 1]).toEqual(configs[defaults.length + 1]);
    expect((await readdir(join(rootDir, "modules"))).sort()).toEqual(
      defaults.map((item) => item.instanceId).sort(),
    );
  });

  it("bootstraps complete v1 files only when the modules directory is absent", async () => {
    const rootDir = await createRoot();
    await expect(
      loadModuleInstanceConfigs({ rootDir, defaults }),
    ).resolves.toEqual(defaults);
    expect(await readdir(join(rootDir, "modules"))).toEqual([
      "heartbeat.default",
      "heavy.default",
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(rootDir, "modules/heavy.default/config.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      version: 1,
      instanceId: "heavy.default",
      definitionId: "agent.heavy",
      settings: {},
    });
    expect(await readFile(join(rootDir, "cordis.yml"), "utf8")).toContain(
      "module.heavy.default",
    );
    await expect(
      loadModuleInstanceConfigs({ rootDir, defaults }),
    ).resolves.toEqual(defaults);
  });

  it.each([
    ["missing instance", async (root: string) => mkdir(join(root, "modules"))],
    [
      "legacy reply instance",
      async (root: string) =>
        mkdir(join(root, "modules/reply.default"), { recursive: true }),
    ],
    [
      "unknown instance",
      async (root: string) =>
        mkdir(join(root, "modules/unknown"), { recursive: true }),
    ],
  ])(
    "rejects an existing directory with %s without writing defaults",
    async (_label, prepare) => {
      const rootDir = await createRoot();
      await prepare(rootDir);
      await expect(
        loadModuleInstanceConfigs({ rootDir, defaults }),
      ).rejects.toMatchObject({
        code: "CONFIG_CORRUPT_STORE",
      });
      expect(await readdir(join(rootDir, "modules"))).not.toContain(
        "heavy.default",
      );
    },
  );

  it.each([
    ["legacy definition", { ...storedHeavy, definitionId: "demo.reply.llm" }],
    [
      "legacy memory definition",
      { ...storedHeavy, definitionId: "core.identity.normalize" },
    ],
    ["wrong version", { ...storedHeavy, version: 2 }],
    ["old enabled field", { ...storedHeavy, enabled: true }],
    [
      "missing settings",
      {
        version: 1,
        instanceId: "heavy.default",
        definitionId: "agent.heavy",
      },
    ],
    [
      "mismatched identity",
      { ...storedHeavy, instanceId: "heartbeat.default" },
    ],
  ])("rejects %s without repairing the file", async (_label, invalid) => {
    const rootDir = await createRoot();
    await loadModuleInstanceConfigs({ rootDir, defaults });
    const path = join(rootDir, "modules/heavy.default/config.json");
    const serialized = `${JSON.stringify(invalid)}\n`;
    await writeFile(path, serialized, "utf8");
    await expect(
      loadModuleInstanceConfigs({ rootDir, defaults }),
    ).rejects.toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
    });
    expect(await readFile(path, "utf8")).toBe(serialized);
  });

  it("rejects unsafe and duplicate default identities", async () => {
    expect(
      moduleInstanceConfigSchema.safeParse({
        version: 1,
        definitionId: "agent.heavy",
        settings: {},
        instanceId: "../reply",
      }).success,
    ).toBe(false);
    const rootDir = await createRoot();
    await expect(
      loadModuleInstanceConfigs({
        rootDir,
        defaults: [defaults[0]!, defaults[0]!],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID_INPUT" });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kaguya-modules-"));
  roots.push(root);
  return root;
}

it("does not initialize absent modules when reading a hot-application snapshot", async () => {
  const rootDir = await createRoot();
  await expect(
    loadModuleInstanceConfigs({ rootDir, defaults, initialize: false }),
  ).rejects.toMatchObject({ code: "CONFIG_CORRUPT_STORE" });
  expect(await readdir(rootDir)).toEqual([]);
});
