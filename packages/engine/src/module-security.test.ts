/**
 * 功能概述：验证 Catalog 能力权限不可被原始清单突变绕过，以及启动取消与 provider 身份边界。
 * 主要职责：复现 raw definition 改 requires、名为 host 的实例依赖、create 等待 abort 三个跨层问题。
 * 代码库关系：使用真实 SDK 与 Host，Core 仅替代无订阅所需启动端口，不访问存储。
 * 输入输出与副作用：测试只记录生命周期并使用可控门闩；每个启动资源均通过 stop 清理。
 */
import { expect, it, vi } from "vitest";
import { z } from "@kaguya/schema";
import {
  defineInformationModuleCatalog,
  defineModuleCapability,
  defineInformationKind,
  onInformation,
  type InformationModuleDefinition,
} from "@kaguya/sdk";
import { ModuleHost } from "./module-host.js";
import type { InformationCore } from "./information-core.js";
const capability = defineModuleCapability<{ secret: string }>("test:secret", 1);
const core = {
  registry: { get: () => undefined },
  startReliableDelivery: async () => {},
  stopReliableDelivery: async () => {},
} as unknown as InformationCore;
const definition = (
  id: string,
): {
  manifest: InformationModuleDefinition["manifest"];
  create: InformationModuleDefinition["create"];
} => ({
  manifest: {
    protocolVersion: 2,
    summary: "Test information module.",
    moduleVersion: "1.0.0",
    definitionId: id,
    displayName: id,
    description: `${id} information module`,
    settingsSchema: z.object({}).strict(),
    consumes: [],
    produces: [],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [],
  },
  create: () => ({ subscriptions: [], provisions: [] }),
});
const activation = (id: string) => ({
  instanceId: id,
  definitionId: id,
  settings: {},
});
it("does not grant a capability appended to the original manifest after catalog creation", async () => {
  const raw = definition("test.module");
  let accessed = false;
  raw.create = (_options, context) => {
    try {
      (raw.manifest.requires as any[]).push(capability);
    } catch {}
    try {
      context.use(capability);
      accessed = true;
    } catch {}
    return { subscriptions: [], provisions: [] };
  };
  const host = new ModuleHost({
    core,
    catalog: defineInformationModuleCatalog(raw),
    capabilities: [{ capability, value: { secret: "hidden" } }],
  });
  await host.start([activation("test.module")]);
  await host.stop();
  expect(accessed).toBe(false);
});
it("orders a provider named host as a module rather than a host capability", async () => {
  const provider = definition("host");
  provider.manifest = { ...provider.manifest, provides: [capability] };
  provider.create = () => ({
    subscriptions: [],
    provisions: [{ capability, value: { secret: "ok" } }],
  });
  const consumer = definition("a.consumer");
  consumer.manifest = { ...consumer.manifest, requires: [capability] };
  consumer.create = (_options, context) => {
    expect(context.use(capability).secret).toBe("ok");
    return { subscriptions: [], provisions: [] };
  };
  const host = new ModuleHost({
    core,
    catalog: defineInformationModuleCatalog(consumer, provider),
  });
  await host.start([activation("a.consumer"), activation("host")]);
  await host.stop();
});
it("aborts an in-progress create before waiting for startup to settle", async () => {
  const module = definition("test.pending");
  let entered = false;
  let disposed = false;
  let signal!: AbortSignal;
  let release!: () => void;
  module.create = async (_options, context) => {
    signal = context.signal;
    entered = true;
    await new Promise<void>((resolve) => {
      release = resolve;
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return {
      subscriptions: [],
      provisions: [],
      dispose: () => {
        disposed = true;
      },
    };
  };
  const host = new ModuleHost({
    core,
    catalog: defineInformationModuleCatalog(module),
  });
  const start = host.start([activation("test.pending")]);
  const observed = start.catch(() => undefined);
  await vi.waitFor(() => expect(entered).toBe(true));
  const stop = host.stop();
  try {
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 200 });
  } finally {
    release();
    await observed;
    await stop;
  }
  expect(disposed).toBe(true);
});

it("rejects mutable non-JSON settings before create", async () => {
  const raw = definition("test.settings");
  const create = vi.fn(() => ({ subscriptions: [], provisions: [] }));
  raw.manifest = {
    ...raw.manifest,
    settingsSchema: z.map(z.string(), z.string()),
  };
  raw.create = create;
  const host = new ModuleHost({
    core,
    catalog: defineInformationModuleCatalog(raw),
  });
  await expect(
    host.start([
      { ...activation("test.settings"), settings: new Map([["key", "value"]]) },
    ]),
  ).rejects.toThrow(/settings/i);
  expect(create).not.toHaveBeenCalled();
});

it("does not install subscriptions appended after instance validation", async () => {
  const allowed = defineInformationKind({
    kind: "test.allowed",
    displayName: "Test Allowed",
    description: "Information carried by the test.allowed kind.",
    payloadSchema: z.object({}).strict(),
    references: {},
    log: { enabled: false },
  });
  const other = defineInformationKind({
    kind: "test.other",
    displayName: "Test Other",
    description: "Information carried by the test.other kind.",
    payloadSchema: z.object({}).strict(),
    references: {},
    log: { enabled: false },
  });
  const installed: string[] = [];
  const subscribedCore = {
    ...core,
    registry: {
      get: (kind: string) => (kind === allowed.kind ? allowed : other),
    },
    on: (definition: any) => {
      installed.push(definition.kind);
      return () => {};
    },
  } as unknown as InformationCore;
  const raw = definition("test.mutation");
  raw.manifest = { ...raw.manifest, consumes: [allowed] };
  raw.create = () => {
    const subscriptions: any[] = [];
    return {
      subscriptions,
      provisions: [],
      start: () => {
        subscriptions.push(
          onInformation(
            other,
            { subscriptionId: "test.unexpected", delivery: "live" },
            () => {},
          ),
        );
      },
    };
  };
  const host = new ModuleHost({
    core: subscribedCore,
    catalog: defineInformationModuleCatalog(raw),
  });
  await host.start([activation("test.mutation")]);
  await host.stop();
  expect(installed).toEqual([]);
});

it("rejects a malformed kind schema while building the catalog", () => {
  const raw = definition("test.invalidkind");
  raw.manifest = {
    ...raw.manifest,
    consumes: [
      {
        kind: "test.broken",
        displayName: "Broken kind",
        description: "A deliberately malformed schema fixture.",
      } as any,
    ],
  };
  expect(() => defineInformationModuleCatalog(raw)).toThrow(/schema/i);
});
