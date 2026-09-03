/**
 * 功能概述：本文件在真实 `InformationCore` 和内存账本上验证信息模块宿主的订阅、
 * 派生 atom 注册与故障归属行为。
 * 主要职责：验证模块 context.register 注入模块 source、因果与 context 引用；
 * 验证保留引用和未声明输出被拒绝、输入快照深冻结、同 kind 多实例均被广播，以及
 * handler 故障由 Core 记录为带模块消费者身份的 `consumer.failed`。
 * 代码库关系：覆盖最终 `module-host.ts` 对 SDK `onInformation` 和 Core
 * `on`/`register` 的适配；MemoryLedger 模拟 Core 所要求的 append-only 存储边界。
 * 输入输出与副作用：测试只写入进程内账本，注册的 atom 必须先满足引用存在性；每个
 * 宿主在断言后停止，以撤销 Core 订阅并释放模块实例。
 */
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
  type InformationModuleSubscription,
} from "@kaguya/sdk";
import { describe, expect, it, vi } from "vitest";

import { InformationCore, InformationKindRegistry } from "./index.js";
import { ModuleHost, ModuleKindNotDeclaredError } from "./module-host.js";

class MemoryLedger {
  readonly atoms = new Map<string, DeepReadonly<InformationAtom>>();

  async synchronizeKinds(): Promise<void> {}

  async append(atom: DeepReadonly<InformationAtom>): Promise<void> {
    if (this.atoms.has(atom.informationId)) throw new Error("collision");
    for (const reference of atom.references) {
      if (!this.atoms.has(reference.informationId))
        throw new Error("missing reference");
    }
    this.atoms.set(
      atom.informationId,
      freezeInformationAtom(atom as InformationAtom),
    );
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
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [contextKind.kind],
    },
  },
  log: { enabled: false },
});

const outputKind = defineInformationKind({
  kind: "acme.message.output",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [inboundKind.kind],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [contextKind.kind],
    },
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
  return core.register(contextKind, {
    occurredAt: "2026-09-03T00:00:00.000Z",
    source: "core:test",
    payload: { requestId: "req-1" },
    references: [],
  });
}

function registration(
  payload: { readonly text: string },
  context: DeepReadonly<InformationAtom>,
) {
  return {
    occurredAt: "2026-09-03T00:00:00.000Z",
    source: "adapter:test",
    payload,
    references: [
      { relation: "core:context", informationId: context.informationId },
    ],
  } as const;
}

async function startHost(
  module: ReturnType<typeof defineInformationModule>,
  core: InformationCore,
  instanceId = "echo.default",
): Promise<ModuleHost> {
  const host = new ModuleHost({ core });
  host.register(module);
  await host.start([
    { instanceId, definitionId: module.manifest.definitionId, settings: {} },
  ]);
  return host;
}

describe("ModuleHost", () => {
  it("registers a derived atom with module identity and causal references", async () => {
    const { core, store } = createCore();
    await core.start();
    const context = await appendContext(core);
    const derived: DeepReadonly<InformationAtom>[] = [];
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
            derived.push(
              await handlerContext.register(outputKind, {
                payload: { text: atom.payload.text },
              }),
            );
          }),
        ],
      }),
    });
    const host = await startHost(module, core);
    const inbound = await core.register(
      inboundKind,
      registration({ text: "moon" }, context),
    );

    expect(derived[0]?.source).toBe("module:echo.default");
    expect(derived[0]?.references).toContainEqual({
      relation: "core:caused-by",
      informationId: inbound.informationId,
    });
    expect(
      derived[0]?.references.filter(
        (reference) => reference.relation === "core:context",
      ),
    ).toEqual([
      { relation: "core:context", informationId: context.informationId },
    ]);
    expect(await store.get(derived[0]!.informationId)).toBeDefined();
    await host.stop();
  });

  it("rejects each caller-supplied reserved reference", async () => {
    const { core } = createCore();
    await core.start();
    const context = await appendContext(core);
    const rejections: unknown[] = [];
    const module = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.reserved",
        displayName: "Reserved",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundKind, outputKind],
      },
      create: () => ({
        subscriptions: [
          onInformation(inboundKind, async (_atom, handlerContext) => {
            for (const relation of [
              "core:caused-by",
              "core:context",
            ] as const) {
              try {
                await handlerContext.register(outputKind, {
                  payload: { text: "blocked" },
                  references: [
                    { relation, informationId: context.informationId },
                  ],
                });
              } catch (error) {
                rejections.push(error);
              }
            }
          }),
        ],
      }),
    });
    const host = await startHost(module, core);

    await core.register(inboundKind, registration({ text: "moon" }, context));
    expect(rejections).toHaveLength(2);
    expect(rejections).toEqual([
      expect.objectContaining({
        message: "Information module cannot override core causal references",
      }),
      expect.objectContaining({
        message: "Information module cannot override core causal references",
      }),
    ]);
    await host.stop();
  });

  it("rejects a structural subscription with a different manifest definition", async () => {
    const { core } = createCore();
    await core.start();
    const module = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.mismatch",
        displayName: "Mismatch",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundKind, outputKind],
      },
      create: () => ({
        subscriptions: [
          {
            kind: inboundKind.kind,
            definition: outputKind,
            handle: () => undefined,
          } as unknown as InformationModuleSubscription,
        ],
      }),
    });
    const host = new ModuleHost({ core });
    host.register(module);

    await expect(
      host.start([
        {
          instanceId: "mismatch.default",
          definitionId: module.manifest.definitionId,
          settings: {},
        },
      ]),
    ).rejects.toThrow(
      `Information subscription definition mismatch: ${inboundKind.kind}`,
    );
  });

  it("rejects outputs absent from the module manifest", async () => {
    const undeclaredKind = defineInformationKind({
      kind: "acme.message.undeclared",
      payloadSchema: z.object({ text: z.string() }).strict(),
      references: {},
      log: { enabled: false },
    });
    const { core } = createCore([undeclaredKind]);
    await core.start();
    const context = await appendContext(core);
    let rejection: unknown;
    const module = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.undeclared",
        displayName: "Undeclared",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundKind],
      },
      create: () => ({
        subscriptions: [
          onInformation(inboundKind, async (_atom, handlerContext) => {
            try {
              await handlerContext.register(undeclaredKind, {
                payload: { text: "blocked" },
              });
            } catch (error) {
              rejection = error;
            }
          }),
        ],
      }),
    });
    const host = await startHost(module, core);

    await core.register(inboundKind, registration({ text: "moon" }, context));
    expect(rejection).toBeInstanceOf(ModuleKindNotDeclaredError);
    await host.stop();
  });

  it("passes a deeply frozen input atom to each handler", async () => {
    const { core } = createCore();
    await core.start();
    const context = await appendContext(core);
    let atom: DeepReadonly<InformationAtom> | undefined;
    const module = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.frozen",
        displayName: "Frozen",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundKind],
      },
      create: () => ({
        subscriptions: [
          onInformation(inboundKind, (input) => {
            atom = input;
          }),
        ],
      }),
    });
    const host = await startHost(module, core);

    await core.register(inboundKind, registration({ text: "moon" }, context));

    expect(Object.isFrozen(atom)).toBe(true);
    expect(Object.isFrozen(atom?.payload)).toBe(true);
    expect(Object.isFrozen(atom?.references)).toBe(true);
    expect(Object.isFrozen(atom?.references[0])).toBe(true);
    await host.stop();
  });

  it("runs same-kind consumers independently and concurrently", async () => {
    const { core } = createCore();
    await core.start();
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const make = (id: string) =>
      defineInformationModule({
        manifest: {
          apiVersion: 1,
          definitionId: id,
          displayName: id,
          settingsSchema: z.object({}).strict(),
          informationKinds: [inboundKind],
        },
        create: () => ({
          subscriptions: [
            onInformation(inboundKind, async () => {
              entered.push(id);
              await gate;
            }),
          ],
        }),
      });
    const first = make("acme.first");
    const second = make("acme.second");
    const host = new ModuleHost({ core });
    host.register(first);
    host.register(second);
    await host.start([
      {
        instanceId: "first",
        definitionId: first.manifest.definitionId,
        settings: {},
      },
      {
        instanceId: "second",
        definitionId: second.manifest.definitionId,
        settings: {},
      },
    ]);
    const context = await appendContext(core);
    const pending = core.register(
      inboundKind,
      registration({ text: "x" }, context),
    );
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    release();
    await pending;
    await host.stop();
  });

  it("records handler failures with module consumer identity", async () => {
    const { core, store } = createCore();
    await core.start();
    const context = await appendContext(core);
    const module = defineInformationModule({
      manifest: {
        apiVersion: 1,
        definitionId: "acme.failure",
        displayName: "Failure",
        settingsSchema: z.object({}).strict(),
        informationKinds: [inboundKind],
      },
      create: () => ({
        subscriptions: [
          onInformation(inboundKind, () => {
            throw new Error("expected failure");
          }),
        ],
      }),
    });
    const host = await startHost(module, core, "failure.default");

    await core.register(inboundKind, registration({ text: "moon" }, context));

    const failure = [...store.atoms.values()].find(
      (atom) => atom.kind === "consumer.failed",
    );
    expect(failure?.payload).toMatchObject({
      consumer: {
        consumerId: "module:failure.default",
        definitionId: "acme.failure",
        instanceId: "failure.default",
      },
    });
    await host.stop();
  });
});
