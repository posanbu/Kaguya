/** Raw Memory writes original inbound text independently of the online chat modules. */
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import { KaguyaRuntime } from "@kaguya/runtime";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(enabled = true) {
  const database = await createTestingDatabase();
  cleanup.push(() => database.close());
  const configs = createFirstPartyModuleConfigDefaults("test")
    .filter((config) =>
      ["memory.identity", "memory.raw"].includes(config.definitionId),
    )
    .map((config) => ({
      ...config,
      enabled: config.definitionId === "memory.identity" || enabled,
    }));
  const runtime = new KaguyaRuntime({
    database,
    ...createMessageComposition(undefined, {
      moduleConfigs: configs,
      memoryEnabled: enabled,
    }),
  });
  cleanup.push(() => runtime.close());
  await runtime.start();
  const submit = (text: string, platformMessageId: string) =>
    runtime.submit({
      adapterId: "test",
      platform: "qq",
      platformMessageId,
      occurredAt: new Date().toISOString(),
      text,
      mentions: [],
      raw: {},
      sender: { userId: "user" },
      target: { kind: "group", groupId: "group" },
    });
  const wait = (kind: string, count = 1) =>
    vi.waitFor(
      async () => {
        const atoms = await database.information.find({
          kinds: [kind],
          limit: 100,
        });
        expect(atoms).toHaveLength(count);
        return atoms;
      },
      { timeout: 4000 },
    );
  return { database, runtime, submit, wait, configs };
}

describe("raw Memory background loop", () => {
  it("writes original messages without online modules or old Memory workers", async () => {
    const f = await fixture();
    await f.submit("喜欢月亮", "first");
    await f.wait("memory.raw.completed");
    const documents = await f.database.memory.listDocuments({ limit: 10 });
    expect(documents.map((document) => document.content)).toEqual(["喜欢月亮"]);
    for (const kind of [
      "memory.association.requested",
      "memory.index.requested",
      "memory.cognition.requested",
    ]) {
      expect(
        await f.database.information.find({ kinds: [kind], limit: 10 }),
      ).toEqual([]);
    }
  });

  it("switches raw writes without removing stored messages", async () => {
    const f = await fixture();
    await f.submit("first", "first");
    await f.wait("memory.raw.completed");
    const switchRaw = async (enabled: boolean) => {
      const composition = createMessageComposition(undefined, {
        moduleConfigs: f.configs.map((config) => ({
          ...config,
          enabled: config.definitionId === "memory.identity" || enabled,
        })),
        memoryEnabled: enabled,
      });
      await f.runtime.replaceMemoryFeatures({
        memory: composition.memory,
        activations: composition.activations,
        capabilities: composition.capabilities,
      });
    };
    await switchRaw(false);
    await f.submit("second", "second");
    await f.wait("memory.identity.person.context.completed", 2);
    expect(await f.database.memory.listDocuments({ limit: 10 })).toHaveLength(
      1,
    );
    await switchRaw(true);
    await f.submit("third", "third");
    await f.wait("memory.raw.completed", 2);
    expect(
      (await f.database.memory.listDocuments({ limit: 10 }))
        .map((document) => document.content)
        .sort(),
    ).toEqual(["first", "third"]);
  });

  it("does not write when raw Memory is disabled", async () => {
    const f = await fixture(false);
    await f.submit("private", "first");
    await f.wait("memory.identity.person.context.completed");
    expect(await f.database.memory.listDocuments({ limit: 10 })).toEqual([]);
  });
});
