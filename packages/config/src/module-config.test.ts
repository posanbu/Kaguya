/**
 * 功能概述：验证模块配置首次落盘与已有配置的拒绝策略。
 * 主要职责：覆盖只读状态查询不初始化配置、message-composer 默认实例、版本/身份校验、旧 reply 配置重新初始化提示及原文件保留。
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
  type ModuleInstanceConfig,
} from "./module-config.js";

const roots: string[] = [];
const defaults: readonly ModuleInstanceConfig[] = [
  {
    version: 1,
    instanceId: "message-composer.default",
    definitionId: "agent.message-composer",
    enabled: true,
    settings: { modelTier: "heavy" },
  },
  {
    version: 1,
    instanceId: "heartbeat.default",
    definitionId: "agent.heartbeat.short",
    enabled: false,
    settings: { messageDebounceMs: 1500 },
  },
];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("module instance configuration", () => {
  it("bootstraps complete v1 files only when the modules directory is absent", async () => {
    const rootDir = await createRoot();
    await expect(
      loadModuleInstanceConfigs({ rootDir, defaults }),
    ).resolves.toEqual(defaults);
    expect(await readdir(join(rootDir, "modules"))).toEqual([
      "heartbeat.default",
      "message-composer.default",
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(rootDir, "modules/message-composer.default/config.json"),
          "utf8",
        ),
      ),
    ).toEqual(defaults[0]);
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
        message: expect.stringContaining("Reinitialize module configuration"),
      });
      expect(await readdir(join(rootDir, "modules"))).not.toContain(
        "message-composer.default",
      );
    },
  );

  it.each([
    ["legacy definition", { ...defaults[0], definitionId: "demo.reply.llm" }],
    ["wrong version", { ...defaults[0], version: 2 }],
    [
      "missing settings",
      {
        version: 1,
        instanceId: "message-composer.default",
        definitionId: "agent.message-composer",
        enabled: true,
      },
    ],
    [
      "mismatched identity",
      { ...defaults[0], instanceId: "heartbeat.default" },
    ],
  ])("rejects %s without repairing the file", async (_label, invalid) => {
    const rootDir = await createRoot();
    await loadModuleInstanceConfigs({ rootDir, defaults });
    const path = join(rootDir, "modules/message-composer.default/config.json");
    const serialized = `${JSON.stringify(invalid)}\n`;
    await writeFile(path, serialized, "utf8");
    await expect(
      loadModuleInstanceConfigs({ rootDir, defaults }),
    ).rejects.toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
      message: expect.stringContaining("Reinitialize module configuration"),
    });
    expect(await readFile(path, "utf8")).toBe(serialized);
  });

  it("rejects unsafe and duplicate default identities", async () => {
    expect(
      moduleInstanceConfigSchema.safeParse({
        ...defaults[0],
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
