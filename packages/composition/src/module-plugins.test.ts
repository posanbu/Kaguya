/**
 * 功能概述：以安装到临时 node_modules 的独立示例包验证插件的完整持久化生命周期。
 * 主要职责：安装、任意实例配置、写 Kind、升级、重启读旧 Atom、停用、卸载、重新安装；
 * 同时检查同名契约冲突整批回滚、缺失能力与非法配置不会部分激活。
 * 代码库关系：真实 Cordis、Runtime、ModuleHost 和 PGlite 共用冻结声明；测试包不修改宿主。
 * 输入输出与副作用：仅合成消息与临时配置；持久投递条件轮询沿用 8 秒/20 毫秒，清理等待关闭 Promise。
 */
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  defaultCordisTree,
  loadModuleInstanceConfigs,
  validateCordisTree,
  type CordisPluginTree,
} from "@kaguya/config";
import {
  defineInformationModuleCatalog,
  readPluginInformation,
  defineVersionedInformationKind,
} from "@kaguya/sdk";
import { z } from "@kaguya/schema";
import { KaguyaRuntime } from "@kaguya/runtime";
import { CordisAssembly } from "./cordis-assembly.js";
import { loadModulePlugins } from "./module-plugins.js";

// 完整安装用例包含六次 Runtime 启停；沿用 Server 多次热应用的 45 秒上限。
vi.setConfig({ testTimeout: 45_000 });
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length)
    throw new AggregateError(errors, "Plugin fixture cleanup failed");
}, 15_000);

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "kaguya-module-plugin-"));
  cleanups.push(() => rm(rootDir, { recursive: true, force: true }));
  const moduleRoot = join(rootDir, "node_modules");
  await mkdir(join(moduleRoot, "@kaguya"), { recursive: true });
  const require = createRequire(import.meta.url);
  for (const name of ["sdk", "schema", "modules"]) {
    await symlink(
      dirname(dirname(require.resolve(`@kaguya/${name}`))),
      join(moduleRoot, "@kaguya", name),
      "junction",
    );
  }
  const packageDir = join(moduleRoot, "@kaguya-example", "echo");
  await cp(
    fileURLToPath(new URL("../../../examples/plugins/echo", import.meta.url)),
    packageDir,
    { recursive: true },
  );
  const database = await createTestingDatabase();
  cleanups.push(() => database.close());
  const base = defaultCordisTree([]);
  await loadModuleInstanceConfigs({ rootDir, defaults: [] });
  const tree = (name = "@kaguya-example/echo", disabled = false) =>
    validateCordisTree(
      {
        plugins: [
          ...base.plugins,
          {
            id: "module.echo.arbitrary",
            name,
            disabled,
            definitionId: "example.echo",
            settings: { label: "installed" },
          },
        ],
      },
      [],
    );
  let runtime: KaguyaRuntime | undefined;
  let assembly: CordisAssembly | undefined;
  const stop = async () => {
    await runtime?.close({ drain: true });
    runtime = undefined;
    await assembly?.dispose();
    assembly = undefined;
  };
  cleanups.push(stop);
  const load = async (treeSnapshot: CordisPluginTree) => {
    const configs = await loadModuleInstanceConfigs({
      rootDir,
      defaults: [],
      treeSnapshot,
    });
    return loadModulePlugins({
      rootDir,
      tree: treeSnapshot,
      configs,
      catalog: defineInformationModuleCatalog(),
    });
  };
  const start = async (
    treeSnapshot: CordisPluginTree,
    capabilities: readonly import("@kaguya/sdk").ModuleCapabilityImplementation[] = [],
  ) => {
    const snapshot = await load(treeSnapshot);
    await database.prepareSchema();
    await database.information.synchronizeKinds(
      snapshot.kindRegistry.definitions().map((kind) => kind.kind),
      snapshot.kindRegistry.definitions(),
    );
    assembly = await CordisAssembly.create(treeSnapshot);
    await assembly.mount("catalog", [], () => snapshot.catalog);
    runtime = new KaguyaRuntime({
      database,
      catalog: snapshot.catalog,
      kindRegistry: snapshot.kindRegistry,
      moduleLifecycle: assembly.moduleLifecycle,
      capabilities,
      activations: snapshot.configs
        .filter((config) => config.enabled)
        .map((config) => ({ ...config })),
    });
    await runtime.start();
    return snapshot;
  };
  let sequence = 0;
  const submit = async () => {
    await runtime!.submit({
      platform: "web",
      adapterId: "web.ui.main",
      platformMessageId: `message-${++sequence}`,
      occurredAt: "2026-09-28T00:00:00.000Z",
      text: "hello",
      mentions: [],
      target: { kind: "web" },
      sender: { userId: "fixture" },
      raw: {},
    });
    await vi.waitFor(
      async () => {
        expect((await database.information.reliable.health()).pending).toBe(0);
      },
      { timeout: 8000, interval: 20 },
    );
  };
  return {
    rootDir,
    packageDir,
    moduleRoot,
    database,
    tree,
    base,
    start,
    stop,
    submit,
    load,
    assembly: () => assembly!,
  };
}

it("installs, upgrades, restarts, disables, uninstalls and reinstalls an independent plugin", async () => {
  const f = await fixture();
  await f.start(f.tree());
  await f.submit();
  const [old] = await f.database.information.find({
    kinds: ["example.echo.record.v1"],
    limit: 10,
  });
  expect(old?.payload).toEqual({ label: "installed", length: 5 });
  expect(old?.source).toBe("module:echo.arbitrary");
  const storedBefore = JSON.stringify(old);
  await f.stop();
  const v2Dir = join(f.moduleRoot, "@kaguya-example", "echo-v2");
  await cp(f.packageDir, v2Dir, { recursive: true });
  const source = await readFile(join(v2Dir, "index.mjs"), "utf8");
  const oldDefinition = source
    .slice(
      source.indexOf("export const echoKind"),
      source.indexOf("export default"),
    )
    .replace("echoKind", "oldEchoKind");
  const upgraded = source
    .replace(
      /version: 1,\s*kind: "example.echo.record.v1"/u,
      'version: 2, kind: "example.echo.record.v2"',
    )
    .replaceAll('"1.0.0"', '"2.0.0"')
    .replaceAll("length:", "characters:")
    .replace("export default", `${oldDefinition}\nexport default`)
    .replace(
      "modules: [",
      "compatibility: [{ from: oldEchoKind, to: echoKind, convert: ({ label, length }) => ({ label, characters: length }) }], modules: [",
    );
  await writeFile(join(v2Dir, "index.mjs"), upgraded);
  const v2 = await f.start(f.tree("@kaguya-example/echo-v2"));
  await f.submit();
  expect(
    (
      await f.database.information.find({
        kinds: ["example.echo.record.v2"],
        limit: 10,
      })
    )[0]?.payload,
  ).toEqual({ label: "installed", characters: 5 });
  expect(v2.plugins[0]!.compatibility).toHaveLength(1);
  expect(
    readPluginInformation(v2.plugins[0]!, old!, "example.echo.record.v2"),
  ).toEqual({ label: "installed", characters: 5 });
  await f.stop();
  await f.start(f.tree("@kaguya-example/echo-v2"));
  expect(
    JSON.stringify(await f.database.information.get(old!.informationId)),
  ).toBe(storedBefore);
  await f.stop();
  await f.start(f.tree("missing-package-after-disable", true));
  await f.submit();
  expect(
    await f.database.information.find({
      kinds: ["example.echo.record.v1", "example.echo.record.v2"],
      limit: 10,
    }),
  ).toHaveLength(2);
  await f.stop();
  await f.start(f.base);
  await f.submit();
  expect(
    (await f.database.information.listKindContracts()).filter((row) =>
      row.kind.startsWith("example.echo."),
    ),
  ).toHaveLength(2);
  await f.stop();
  await f.start(f.tree());
  await f.submit();
  expect(
    await f.database.information.find({
      kinds: ["example.echo.record.v1"],
      limit: 10,
    }),
  ).toHaveLength(2);
  expect(
    JSON.stringify(await f.database.information.get(old!.informationId)),
  ).toBe(storedBefore);
});

it("rejects contract reuse and rolls back the whole new Kind batch", async () => {
  const f = await fixture();
  await f.start(f.tree());
  await f.submit();
  const changed = defineVersionedInformationKind({
    owner: "example.echo",
    version: 1,
    kind: "example.echo.record.v1",
    displayName: "错误变更",
    description: "同名不兼容",
    payloadSchema: z.strictObject({ value: z.string() }),
    references: {},
    log: { enabled: false },
  });
  await expect(
    f.database.information.synchronizeKinds(
      ["example.new.v1", changed.kind],
      [changed],
    ),
  ).rejects.toThrow("contract conflict");
  expect(
    (await f.database.information.listKindContracts()).some(
      (row) => row.kind === "example.new.v1",
    ),
  ).toBe(false);
  await f.submit();
  expect(
    await f.database.information.find({ kinds: [changed.kind], limit: 10 }),
  ).toHaveLength(2);
});

it("rejects missing capabilities and invalid settings before activating handlers", async () => {
  const f = await fixture();
  const source = await readFile(join(f.packageDir, "index.mjs"), "utf8");
  await writeFile(
    join(f.packageDir, "index.mjs"),
    source.replace(
      "requires: []",
      'requires: [{ id: "example:missing", apiVersion: 1 }]',
    ),
  );
  await expect(f.start(f.tree())).rejects.toThrow(
    "Missing capability: example:missing",
  );
  expect(
    (
      await f.database.sql.query(
        "SELECT * FROM information_subscriptions WHERE enabled = true",
      )
    ).rows,
  ).toHaveLength(0);
  await f.stop();
  const invalid = {
    plugins: f
      .tree()
      .plugins.map((entry) =>
        entry.definitionId ? { ...entry, settings: { label: 3 } } : entry,
      ),
  } as unknown as CordisPluginTree;
  await expect(f.load(invalid)).rejects.toThrow("Invalid plugin settings");
  await expect(f.load(invalid)).rejects.toMatchObject({
    validationIssues: [
      {
        code: "PLUGIN_SETTINGS_INVALID",
        path: "module.echo.arbitrary.settings",
      },
    ],
  });
  await expect(f.load(f.tree("@missing/plugin"))).rejects.toMatchObject({
    validationIssues: [
      { code: "PLUGIN_LOAD_FAILED", path: "module.echo.arbitrary" },
    ],
  });
});

it("unloads a real module fiber only after in-flight work drains and fences late writes", async () => {
  const f = await fixture();
  const source = await readFile(join(f.packageDir, "index.mjs"), "utf8");
  await writeFile(
    join(f.packageDir, "index.mjs"),
    source
      .replace(
        "requires: []",
        'requires: [{ id: "example:gate", apiVersion: 1 }]',
      )
      .replace('delivery: "durable"', 'delivery: "live"')
      .replace(
        "await context.registerOnce(",
        'const gate = context.use({ id: "example:gate", apiVersion: 1 }); context.signal.addEventListener("abort", gate.stopped, { once: true }); gate.entered(); await gate.wait; await context.registerOnce(',
      ),
  );
  let entered!: () => void, release!: () => void, stopped!: () => void;
  const aborted = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await f.start(f.tree(), [
    {
      capability: { id: "example:gate", apiVersion: 1 },
      value: { entered, wait, stopped },
    },
  ]);
  const sending = f.submit();
  let finished = false;
  let unloading: Promise<void> | undefined;
  try {
    await began;
    unloading = f
      .assembly()
      .moduleLifecycle.unmount("echo.arbitrary")
      .then(() => {
        finished = true;
      });
    await aborted;
    expect(finished).toBe(false);
    release();
    await Promise.all([sending, unloading]);
    expect(finished).toBe(true);
    expect(
      await f.database.information.find({
        kinds: ["example.echo.record.v1"],
        limit: 10,
      }),
    ).toHaveLength(0);
    await f.submit();
    expect(
      await f.database.information.find({
        kinds: ["example.echo.record.v1"],
        limit: 10,
      }),
    ).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled([sending, unloading]);
  }
});
