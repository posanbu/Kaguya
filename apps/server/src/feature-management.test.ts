import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadModuleInstanceConfigs,
  type ModuleInstanceConfig,
} from "@kaguya/config";
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
  await loadModuleInstanceConfigs({ rootDir, defaults, initialize: true });
  let active: readonly string[] = [];
  let fail = false;
  const activateMemory = vi.fn(
    async (configs: readonly ModuleInstanceConfig[]) => {
      if (fail) throw new Error("activation failed");
      active = configs
        .filter(
          (config) =>
            config.enabled && config.definitionId.startsWith("memory."),
        )
        .map((config) => config.definitionId);
    },
  );
  const activateNapCat = vi.fn(async () => {});
  const committed = vi.fn();
  const recovered = vi.fn();
  const management = new FeatureManagement({
    rootDir,
    defaults,
    exclusive: (operation) => operation(),
    activateMemory,
    activateNapCat,
    activeMemory: () => active,
    napCatLifecycle: () => ({
      lifecycle: "stopped",
      connectivity: "disconnected",
    }),
    committed,
    recovered,
  });
  return {
    rootDir,
    management,
    activateMemory,
    activateNapCat,
    committed,
    recovered,
    failNext: () => {
      fail = true;
    },
  };
}

it("cascades raw Memory off and keeps children off when reopened", async () => {
  const f = await fixture();
  let view = await f.management.get();
  await expect(
    f.management.toggle("memory.index", true, view.revision),
  ).rejects.toMatchObject({ code: "memory_writeback_required" });
  view = await f.management.toggle("memory.writeback", true, view.revision);
  view = await f.management.toggle("memory.knowledge", true, view.revision);
  view = await f.management.toggle("memory.writeback", false, view.revision);
  expect(
    view.features
      .filter((item) => item.id.startsWith("memory."))
      .every((item) => !item.enabled),
  ).toBe(true);
  view = await f.management.toggle("memory.writeback", true, view.revision);
  expect(
    view.features.find((item) => item.id === "memory.knowledge")?.enabled,
  ).toBe(false);
  expect(f.activateNapCat).not.toHaveBeenCalled();
});

it("rejects stale versions and restores persisted state on activation failure", async () => {
  const f = await fixture();
  const before = await f.management.get();
  await f.management.toggle("memory.writeback", true, before.revision);
  await expect(
    f.management.toggle("memory.writeback", false, before.revision),
  ).rejects.toMatchObject({
    status: 409,
    code: "feature_configuration_changed",
  });
  f.failNext();
  const current = await f.management.get();
  await expect(
    f.management.toggle("memory.writeback", false, current.revision),
  ).rejects.toMatchObject({ code: "feature_activation_failed" });
  const after = await f.management.get();
  expect(
    after.features.find((item) => item.id === "memory.writeback")?.enabled,
  ).toBe(true);
  expect(after.revision).toBe(current.revision);
  expect(f.committed).toHaveBeenCalledTimes(1);
  expect(f.recovered).toHaveBeenCalledOnce();
});
