import { expect, it } from "vitest";
import { defaultCordisTree } from "@kaguya/config";
import { CordisAssembly } from "./cordis-assembly.js";

it("loads built-in services through Cordis and releases resources in dependency order", async () => {
  const events: string[] = [];
  const assembly = await CordisAssembly.create(
    defaultCordisTree([
      {
        instanceId: "heavy.default",
        definitionId: "agent.heavy",
        enabled: true,
      },
    ]),
  );
  try {
    await assembly.mount(
      "configuration",
      [],
      () => ({ value: 1 }),
      () => {
        events.push("configuration");
      },
    );
    await assembly.mount(
      "logging",
      ["configuration"],
      () => ({ value: 2 }),
      () => {
        events.push("logging");
      },
    );
    await assembly.mount(
      "catalog",
      ["logging"],
      () => ({ value: 3 }),
      () => {
        events.push("catalog");
      },
    );
    await assembly.mountModules();
    await assembly.mount(
      "adapter",
      ["catalog"],
      () => ({ value: 4 }),
      () => {
        events.push("adapter");
      },
    );
    await assembly.mount(
      "runtime",
      ["adapter", "catalog"],
      () => ({ value: 5 }),
      () => {
        events.push("runtime");
      },
    );
    expect(assembly.get<{ value: number }>("runtime").value).toBe(5);
  } finally {
    await assembly.dispose();
  }
  expect(events.indexOf("runtime")).toBeLessThan(events.indexOf("adapter"));
  expect(events.indexOf("adapter")).toBeLessThan(events.indexOf("catalog"));
  expect(events.indexOf("catalog")).toBeLessThan(events.indexOf("logging"));
});

it("removes a failed plugin entry so a degraded service can be retried", async () => {
  const assembly = await CordisAssembly.create(defaultCordisTree([]));
  try {
    await assembly.mount("configuration", [], () => ({}));
    await assembly.mount("logging", ["configuration"], () => ({}));
    await assembly.mount("catalog", ["logging"], () => ({}));
    await expect(
      assembly.mount("database", ["catalog"], () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      assembly.mount("database", ["catalog"], () => ({ ready: true })),
    ).resolves.toEqual({ ready: true });
  } finally {
    await assembly.dispose();
  }
});
