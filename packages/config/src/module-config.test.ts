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
    instanceId: "reply.default",
    definitionId: "demo.reply.llm",
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
      "reply.default",
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(rootDir, "modules/reply.default/config.json"),
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
        "reply.default",
      );
    },
  );

  it.each([
    ["wrong version", { ...defaults[0], version: 2 }],
    [
      "missing settings",
      {
        version: 1,
        instanceId: "reply.default",
        definitionId: "demo.reply.llm",
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
    const path = join(rootDir, "modules/reply.default/config.json");
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
