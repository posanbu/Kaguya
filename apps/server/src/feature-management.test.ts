import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadModuleInstanceConfigs } from "@kaguya/config";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { FeatureManagement } from "./feature-management.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "kaguya-features-"));
  roots.push(rootDir);
  const defaults = createFirstPartyModuleConfigDefaults("test");
  await loadModuleInstanceConfigs({ rootDir, defaults });
  const committed = vi.fn();
  const management = new FeatureManagement({
    rootDir,
    defaults,
    exclusive: (operation) => operation(),
    activeMemory: () => [],
    napCatLifecycle: () => ({
      lifecycle: "stopped",
      connectivity: "disconnected",
    }),
    committed,
  });
  return { rootDir, defaults, management, committed };
}

it("writes the desired Memory switch only to the plugin tree and leaves runtime state alone", async () => {
  const f = await fixture();
  const path = join(f.rootDir, "modules/memory.raw.default/config.json");
  const before = await readFile(path, "utf8");
  const initial = await f.management.get();
  const saved = await f.management.toggle("memory.raw", true, initial.revision);
  expect(await readFile(path, "utf8")).toBe(before);
  expect(saved.features.find((item) => item.id === "memory.raw")).toMatchObject(
    {
      enabled: true,
      active: false,
      blocker: "restart_required",
    },
  );
  expect(await readFile(join(f.rootDir, "cordis.yml"), "utf8")).toContain(
    "id: module.memory.raw.default",
  );
  expect(f.committed).toHaveBeenCalledOnce();
});

it("rejects stale revisions without changing the plugin tree", async () => {
  const f = await fixture();
  const before = await f.management.get();
  await f.management.toggle("memory.raw", true, before.revision);
  const tree = await readFile(join(f.rootDir, "cordis.yml"), "utf8");
  await expect(
    f.management.toggle("memory.raw", false, before.revision),
  ).rejects.toMatchObject({
    status: 409,
    code: "feature_configuration_changed",
  });
  expect(await readFile(join(f.rootDir, "cordis.yml"), "utf8")).toBe(tree);
});

it("saves NapCat settings only in the instance file and requires restart", async () => {
  const f = await fixture();
  const before = await f.management.get();
  const tree = await readFile(join(f.rootDir, "cordis.yml"), "utf8");
  const saved = await f.management.updateNapCat(
    {
      enabled: false,
      wsUrl: "ws://127.0.0.1:9",
      selfId: "123",
      accessToken: "fake-napcat-token",
      reconnectMs: 4000,
    },
    before.revision,
  );
  expect(await readFile(join(f.rootDir, "cordis.yml"), "utf8")).toBe(tree);
  expect(saved.revision).not.toBe(before.revision);
  const configs = await loadModuleInstanceConfigs({
    rootDir: f.rootDir,
    defaults: f.defaults,
    initialize: false,
  });
  expect(
    configs.find((item) => item.definitionId === "adapter.napcat")?.settings,
  ).toMatchObject({
    reconnectMs: 4000,
  });
});
