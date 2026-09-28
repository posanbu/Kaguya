import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  defaultCordisTree,
  loadCordisTree,
  writeCordisModuleEnabled,
} from "./cordis-tree.js";
import { loadModuleInstanceConfigs } from "./module-config.js";

const roots: string[] = [];
const modules = [
  {
    version: 1 as const,
    instanceId: "heavy.default",
    definitionId: "agent.heavy",
    enabled: true,
    settings: {},
  },
  {
    version: 1 as const,
    instanceId: "memory.raw.default",
    definitionId: "memory.raw",
    enabled: false,
    settings: {},
  },
];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "kaguya-cordis-"));
  roots.push(rootDir);
  await loadModuleInstanceConfigs({ rootDir, defaults: modules });
  return rootDir;
}

it("projects only tree switches while instance JSON has no enabled field", async () => {
  const rootDir = await fixture();
  const jsonPath = join(rootDir, "modules/memory.raw.default/config.json");
  const before = await readFile(jsonPath, "utf8");
  await writeCordisModuleEnabled(rootDir, modules, "memory.raw.default", true);
  expect(await readFile(jsonPath, "utf8")).toBe(before);
  const loaded = await loadModuleInstanceConfigs({
    rootDir,
    defaults: modules,
    initialize: false,
  });
  expect(
    loaded.find((item) => item.instanceId === "memory.raw.default")?.enabled,
  ).toBe(true);
  expect(JSON.parse(before)).not.toHaveProperty("enabled");
});

it("rejects unknown entries, disabled required services and YAML aliases", async () => {
  const rootDir = await fixture();
  const path = join(rootDir, "cordis.yml");
  const original = await readFile(path, "utf8");
  for (const invalid of [
    original.replace("id: service.configuration", "id: service.unknown"),
    original.replace(
      "id: service.configuration\n    name: kaguya/configuration\n    disabled: false",
      "id: service.configuration\n    name: kaguya/configuration\n    disabled: true",
    ),
    "plugins: &entries\n  - id: service.configuration\n    name: kaguya/configuration\n    disabled: false\ncopy: *entries\n",
  ]) {
    await writeFile(path, invalid);
    await expect(
      loadCordisTree({ rootDir, modules, initialize: false }),
    ).rejects.toMatchObject({
      code: "CONFIG_CORRUPT_STORE",
    });
  }
});

it("keeps a boot snapshot when the disk tree changes", async () => {
  const rootDir = await fixture();
  const boot = defaultCordisTree(modules);
  await writeCordisModuleEnabled(rootDir, modules, "memory.raw.default", true);
  const applied = await loadModuleInstanceConfigs({
    rootDir,
    defaults: modules,
    initialize: false,
    treeSnapshot: boot,
  });
  expect(
    applied.find((item) => item.instanceId === "memory.raw.default")?.enabled,
  ).toBe(false);
});
