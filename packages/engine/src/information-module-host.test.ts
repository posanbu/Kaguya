import {
  freezeInformationAtom,
  informationIdSchema,
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  type JsonObject,
  z,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  onInformation,
  onTargetedInformation,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import { InformationCore, InformationKindRegistry } from "./index.js";
import { InformationModuleHost } from "./information-module-host.js";

class MemoryLedger {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();

  async synchronizeKinds(): Promise<void> {}

  async append(atom: DeepReadonly<InformationAtom>): Promise<void> {
    if (this.atoms.has(atom.informationId)) throw new Error("collision");
    for (const reference of atom.references) {
      if (!this.atoms.has(reference.informationId)) throw new Error("missing reference");
    }
    this.atoms.set(atom.informationId, freezeInformationAtom(atom as InformationAtom));
  }

  async get(id: InformationId) {
    return this.atoms.get(id);
  }

  async getMany(ids: readonly InformationId[]) {
    return ids.flatMap((id) => {
      const atom = this.atoms.get(id);
      return atom === undefined ? [] : [atom];
    });
  }

  async query() {
    return [] as readonly DeepReadonly<InformationAtom>[];
  }
}

const contextKind = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({ requestId: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const inboundKind = defineInformationKind({
  kind: "acme.message.inbound",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:context": { required: true, multiple: false, targetKinds: [contextKind.kind] },
  },
  log: { enabled: false },
});

const outputKind = defineInformationKind({
  kind: "acme.message.output",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false, targetKinds: [inboundKind.kind] },
    "core:context": { required: true, multiple: false, targetKinds: [contextKind.kind] },
  },
  log: { enabled: false },
});

function createCore(extra: readonly any[] = []) {
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(contextKind);
  registry.register(inboundKind);
  registry.register(outputKind);
  for (const definition of extra) registry.register(definition);
  const store = new MemoryLedger();
  let sequence = 0;
  const core = new InformationCore({
    registry,
    store,
    nextInformationId: () => `atom-${++sequence}`,
  });
  return { core, store };
}

async function appendContext(core: InformationCore) {
  return core.append(contextKind, {
    kind: contextKind.kind,
    occurredAt: "2026-09-03T00:00:00.000Z",
    source: "core:test",
    payload: { requestId: "req-1" },
    references: [],
  });
}

describe("InformationModuleHost", () => {
  it("appends derived atoms with causal and context references", async () => {
    const { core, store } = createCore();
    await core.start();
    const context = await appendContext(core);
    const observed: InformationAtom[] = [];
    const module = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.echo",
        displayName: "Echo",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundKind, outputKind],
      },
      create: () => ({
        subscriptions: [
          onInformation(inboundKind, async (atom, handlerContext) => {
            observed.push(await handlerContext.append(outputKind, { payload: { text: atom.payload.text } }) as unknown as InformationAtom);
          }),
        ],
      }),
    });
    const host = new InformationModuleHost({ core });
    host.register(module);
    await host.start([{ instanceId: "echo-1", definitionId: module.manifest.definitionId, settings: {} }]);
    const inbound = await core.append(inboundKind, {
      kind: inboundKind.kind,
      occurredAt: "2026-09-03T00:00:00.000Z",
      source: "adapter:test",
      payload: { text: "hello" },
      references: [{ relation: "core:context", informationId: context.informationId }],
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.references).toEqual([
      { relation: "core:caused-by", informationId: inbound.informationId },
      { relation: "core:context", informationId: context.informationId },
    ]);
    expect(await store.get(observed[0]!.informationId)).toBeDefined();
    await host.stop();
  });

  it("runs same-kind consumers independently and concurrently", async () => {
    const { core } = createCore();
    await core.start();
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const make = (id: string) => defineInformationModule({
      manifest: { apiVersion: 1, definitionId: id, displayName: id, settingsSchema: z.object({}).strict(), informationKinds: [inboundKind] },
      create: () => ({ subscriptions: [onInformation(inboundKind, async () => { entered.push(id); await gate; })] }),
    });
    const first = make("acme.first");
    const second = make("acme.second");
    const host = new InformationModuleHost({ core });
    host.register(first);
    host.register(second);
    await host.start([
      { instanceId: "first", definitionId: first.manifest.definitionId, settings: {} },
      { instanceId: "second", definitionId: second.manifest.definitionId, settings: {} },
    ]);
    const context = await appendContext(core);
    const pending = core.append(inboundKind, { kind: inboundKind.kind, occurredAt: "2026-09-03T00:00:00.000Z", source: "adapter:test", payload: { text: "x" }, references: [{ relation: "core:context", informationId: context.informationId }] });
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    release();
    await pending;
    await host.stop();
  });

  it("rejects mixed targeted and broadcast subscriptions", async () => {
    const targetedKind = defineInformationKind({
      kind: "acme.targeted.input",
      payloadSchema: z.object({ targetInstanceId: z.string(), text: z.string() }).strict(),
      references: {},
      log: { enabled: false },
    });
    const { core } = createCore([targetedKind]);
    await core.start();
    const broadcast = defineInformationModule({
      manifest: { apiVersion: 1, definitionId: "acme.broadcast", displayName: "broadcast", settingsSchema: z.object({}).strict(), informationKinds: [targetedKind] },
      create: () => ({ subscriptions: [onInformation(targetedKind, () => undefined)] }),
    });
    const targeted = defineInformationModule({
      manifest: { apiVersion: 1, definitionId: "acme.targeted", displayName: "targeted", settingsSchema: z.object({}).strict(), informationKinds: [targetedKind] },
      create: () => ({ subscriptions: [onTargetedInformation(targetedKind, () => undefined)] }),
    });
    const host = new InformationModuleHost({ core });
    host.register(broadcast);
    host.register(targeted);
    await expect(host.start([
      { instanceId: "broadcast", definitionId: broadcast.manifest.definitionId, settings: {} },
      { instanceId: "targeted", definitionId: targeted.manifest.definitionId, settings: {} },
    ])).rejects.toThrow("cannot mix targeted and broadcast");
  });
});
