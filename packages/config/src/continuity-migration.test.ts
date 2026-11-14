/** Synthetic file stores cover upgrade, interruption and strict corruption handling. */
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { migrateContinuityConfig } from "./continuity-migration.js";
import {
  loadModuleInstanceConfigs,
  type ModuleInstanceConfig,
} from "./module-config.js";
import { loadCordisTree, writeCordisTree } from "./cordis-tree.js";

const previous: readonly ModuleInstanceConfig[] = [
  {
    version: 1,
    instanceId: "heavy.default",
    definitionId: "agent.heavy",
    enabled: false,
    settings: { retained: "synthetic preference" },
  },
];
const defaults: readonly ModuleInstanceConfig[] = [
  ...previous,
  {
    version: 1,
    instanceId: "continuity.default",
    definitionId: "agent.continuity",
    // An upgrade must not inherit a future enabled-by-default policy.
    enabled: true,
    settings: {},
  },
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(configs = previous) {
  const root = await mkdtemp(join(tmpdir(), "continuity-migrate-"));
  roots.push(root);
  await loadModuleInstanceConfigs({ rootDir: root, defaults: configs });
  return root;
}
async function snapshot(root: string) {
  const paths = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [
          path,
          entry.isDirectory() ? null : await readFile(path, "utf8"),
        ];
      }),
    ),
  );
}
async function load(root: string) {
  return loadModuleInstanceConfigs({
    rootDir: root,
    defaults,
    initialize: false,
  });
}

it("upgrades the old store, preserves settings and extra plugins, and remains idempotent", async () => {
  const root = await fixture();
  const oldTree = await loadCordisTree({ rootDir: root, modules: previous });
  const plugin = {
    id: "module.echo.extra",
    name: "@example/echo",
    definitionId: "example.echo",
    disabled: true,
    settings: { label: "retained" },
  };
  await writeCordisTree(
    root,
    { plugins: [...oldTree.plugins, plugin] },
    previous,
  );
  const saved = await snapshot(root);
  await expect(load(root)).rejects.toMatchObject({
    code: "CONFIG_CORRUPT_STORE",
  });
  const result = await migrateContinuityConfig(root, defaults);
  expect(result.migrated).toBe(true);
  const configs = await load(root);
  expect(configs[0]).toEqual(previous[0]);
  expect(configs[1]).toMatchObject({
    definitionId: "agent.continuity",
    enabled: false,
    settings: {},
  });
  expect(configs[2]).toMatchObject({
    definitionId: plugin.definitionId,
    enabled: false,
    settings: plugin.settings,
  });
  for (const [path, contents] of Object.entries(saved))
    if (path !== join(root, "cordis.yml"))
      expect((await snapshot(root))[path]).toEqual(contents);
  const upgraded = await snapshot(root);
  expect((await migrateContinuityConfig(root, defaults)).migrated).toBe(false);
  expect(await snapshot(root)).toEqual(upgraded);
  if (process.platform !== "win32") {
    expect((await stat(result.backup!)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(root, "modules/continuity.default/config.json"))).mode &
        0o777,
    ).toBe(0o600);
  }
});

it("leaves first-run initialization and already configured continuity untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-new-"));
  roots.push(root);
  expect((await migrateContinuityConfig(root, defaults)).migrated).toBe(false);
  expect(await readdir(root)).toEqual([]);
  await loadModuleInstanceConfigs({ rootDir: root, defaults });
  const saved = await snapshot(root);
  expect((await migrateContinuityConfig(root, defaults)).migrated).toBe(false);
  expect(await snapshot(root)).toEqual(saved);
  expect((await load(root))[1]!.enabled).toBe(true);
});

it.each([
  "missing old module",
  "invalid old module",
  "invalid tree",
  "missing tree",
  "target directory only",
  "target node only",
])("rejects %s without rewriting the store", async (damage) => {
  const root = await fixture();
  if (damage === "missing old module")
    await rm(join(root, "modules/heavy.default"), { recursive: true });
  if (damage === "invalid old module")
    await writeFile(
      join(root, "modules/heavy.default/config.json"),
      JSON.stringify({ version: 2 }),
    );
  if (damage === "invalid tree")
    await writeFile(join(root, "cordis.yml"), "plugins: []\n");
  if (damage === "missing tree") await unlink(join(root, "cordis.yml"));
  if (damage === "target directory only")
    await mkdir(join(root, "modules/continuity.default"));
  if (damage === "target node only") {
    const tree = await loadCordisTree({ rootDir: root, modules: previous });
    await writeCordisTree(
      root,
      {
        plugins: [
          ...tree.plugins,
          {
            id: "module.continuity.default",
            name: "kaguya/module/agent.continuity",
            disabled: true,
          },
        ],
      },
      defaults,
    );
  }
  const saved = await snapshot(root);
  await expect(
    (async () => {
      await migrateContinuityConfig(root, defaults);
      await load(root);
    })(),
  ).rejects.toMatchObject({ code: "CONFIG_CORRUPT_STORE" });
  expect(await snapshot(root)).toEqual(saved);
});

it.each(["journal", "empty target directory", "target config", "target tree"])(
  "resumes an interruption after %s without recomputing the journal",
  async (boundary) => {
    const root = await fixture();
    const oldTree = await readFile(join(root, "cordis.yml"), "utf8");
    const result = await migrateContinuityConfig(root, defaults);
    const journal = await readFile(result.backup!, "utf8");
    await unlink(join(root, "migrations/continuity-v1.complete.json"));
    if (boundary !== "target tree")
      await writeFile(join(root, "cordis.yml"), oldTree);
    if (boundary === "journal" || boundary === "empty target directory") {
      await rm(join(root, "modules/continuity.default"), { recursive: true });
      if (boundary === "empty target directory")
        await mkdir(join(root, "modules/continuity.default"));
    }
    expect(
      (
        await migrateContinuityConfig(
          root,
          defaults.map((item) =>
            item.definitionId === "agent.continuity"
              ? { ...item, settings: { changedDefault: true } }
              : item,
          ),
        )
      ).migrated,
    ).toBe(true);
    expect((await load(root))[1]).toMatchObject({
      enabled: false,
      settings: {},
    });
    expect(await readFile(result.backup!, "utf8")).toBe(journal);
  },
);

it.each(["tree", "target config", "journal"])(
  "refuses to overwrite a changed %s during recovery",
  async (changed) => {
    const root = await fixture();
    await migrateContinuityConfig(root, defaults);
    await unlink(join(root, "migrations/continuity-v1.complete.json"));
    if (changed === "tree") {
      const tree = await loadCordisTree({ rootDir: root, modules: defaults });
      await writeCordisTree(
        root,
        {
          plugins: tree.plugins.map((entry) =>
            entry.id === "module.heavy.default"
              ? { ...entry, disabled: false }
              : entry,
          ),
        },
        defaults,
      );
    } else if (changed === "target config") {
      const path = join(root, "modules/continuity.default/config.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      await writeFile(
        path,
        JSON.stringify({ ...config, settings: { changed: true } }),
      );
    } else
      await writeFile(
        join(root, "migrations/continuity-v1.json"),
        JSON.stringify({ version: 2 }),
      );
    const saved = await snapshot(root);
    await expect(migrateContinuityConfig(root, defaults)).rejects.toMatchObject(
      { code: "CONFIG_CORRUPT_STORE" },
    );
    expect(await snapshot(root)).toEqual(saved);
  },
);

it("does not repair deleted configuration after a completed migration", async () => {
  const root = await fixture();
  await migrateContinuityConfig(root, defaults);
  await rm(join(root, "modules/continuity.default"), { recursive: true });
  const saved = await snapshot(root);
  expect((await migrateContinuityConfig(root, defaults)).migrated).toBe(false);
  await expect(load(root)).rejects.toMatchObject({
    code: "CONFIG_CORRUPT_STORE",
  });
  expect(await snapshot(root)).toEqual(saved);
});
