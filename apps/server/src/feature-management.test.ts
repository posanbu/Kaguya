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
  });
  return {
    rootDir,
    management,
    activateMemory,
    activateNapCat,
    committed,
    failNext: () => {
      fail = true;
    },
  };
}

it("cascades raw Memory off and keeps children off when reopened", async () => {
  const f = await fixture();
  let view = await f.management.get();
  for (const id of [
    "memory.index",
    "memory.cognition",
    "memory.native",
    "memory.mem0",
  ]) {
    await expect(
      f.management.toggle(id, true, view.revision),
    ).rejects.toMatchObject({ code: "feature_not_found" });
  }
  view = await f.management.toggle("memory.raw", true, view.revision);
  view = await f.management.toggle("memory.raw", false, view.revision);
  expect(
    view.features
      .filter((item) => item.id.startsWith("memory."))
      .every((item) => !item.enabled),
  ).toBe(true);
  view = await f.management.toggle("memory.raw", true, view.revision);
  expect(view.features.map((item) => item.id)).toEqual([
    "memory.raw",
    "adapter.napcat",
  ]);
  expect(f.activateNapCat).not.toHaveBeenCalled();
});

it("rejects stale versions and restores persisted state on activation failure", async () => {
  const f = await fixture();
  const before = await f.management.get();
  await f.management.toggle("memory.raw", true, before.revision);
  await expect(
    f.management.toggle("memory.raw", false, before.revision),
  ).rejects.toMatchObject({
    status: 409,
    code: "feature_configuration_changed",
  });
  f.failNext();
  const current = await f.management.get();
  await expect(
    f.management.toggle("memory.raw", false, current.revision),
  ).rejects.toMatchObject({ code: "feature_activation_failed" });
  const after = await f.management.get();
  expect(after.features.find((item) => item.id === "memory.raw")?.enabled).toBe(
    true,
  );
  expect(after.revision).toBe(current.revision);
  expect(f.committed).toHaveBeenCalledTimes(1);
});

it("keeps NapCat settings unchanged after activation failure and allows retry", async () => {
  const f = await fixture();
  const before = await f.management.get();
  const original = await loadModuleInstanceConfigs({
    rootDir: f.rootDir,
    defaults: createFirstPartyModuleConfigDefaults("test"),
    initialize: false,
  });
  const next = {
    enabled: false,
    wsUrl: "ws://127.0.0.1:9",
    selfId: "123",
    accessToken: "fake-napcat-token",
    reconnectMs: 4000,
  };
  f.activateNapCat.mockRejectedValueOnce(new Error("adapter failed"));

  await expect(
    f.management.updateNapCat(next, before.revision),
  ).rejects.toMatchObject({
    status: 503,
    code: "feature_activation_failed",
  });
  expect((await f.management.get()).revision).toBe(before.revision);
  expect(
    await loadModuleInstanceConfigs({
      rootDir: f.rootDir,
      defaults: createFirstPartyModuleConfigDefaults("test"),
      initialize: false,
    }),
  ).toEqual(original);
  expect(f.committed).not.toHaveBeenCalled();

  await expect(
    f.management.updateNapCat(next, before.revision),
  ).resolves.toMatchObject({
    revision: expect.not.stringMatching(before.revision),
  });
  expect(f.activateNapCat).toHaveBeenCalledTimes(2);
  expect(f.committed).toHaveBeenCalledOnce();
  const persisted = await loadModuleInstanceConfigs({
    rootDir: f.rootDir,
    defaults: createFirstPartyModuleConfigDefaults("test"),
    initialize: false,
  });
  const { enabled, ...settings } = next;
  expect(
    persisted.find((config) => config.definitionId === "adapter.napcat"),
  ).toMatchObject({ enabled, settings: expect.objectContaining(settings) });
});
