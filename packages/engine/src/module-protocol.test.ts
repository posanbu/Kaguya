/**
 * 功能概述：用合成 provider/consumer 验证模块协议的预检、能力权限和生命周期。
 * 主要职责：证明 create 前全量失败、拓扑顺序不受 Catalog 顺序影响、回滚完整且 inspection 不含设置。
 * 代码库关系：直接覆盖 ModuleHost 与 SDK Catalog；无业务模块或数据库依赖。
 * 输入输出与副作用：测试记录内存生命周期轨迹；用 fake timers 验证挂起 stop/dispose 的超时聚合，
 * 并确保 create 抛出后 prepared signal 取消、迟到 hook rejection 已被消费，不访问外部服务。
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationModuleCatalog,
  defineModuleCapability,
  defineInformationKind,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import { ModuleHost } from "./module-host.js";
import { InformationCore } from "./information-core.js";
const cap = defineModuleCapability<{ read(): string }>("test:reader", 1);
const core = {
  startReliableDelivery: async () => {},
  stopReliableDelivery: async () => {},
  registry: { get: () => undefined },
} as unknown as InformationCore;
const definition = (id: string, override: Record<string, unknown> = {}) =>
  defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: id,
      displayName: id,
      settingsSchema: z.object({ nested: z.object({ secret: z.string() }) }),
      consumes: [],
      produces: [],
      selectors: [],
      promptRenderers: [],
      requires: [],
      provides: [],
      ...((override.manifest as object) ?? {}),
    },
    create: (override.create ??
      (() => ({ subscriptions: [], provisions: [] }))) as any,
  });
const activation = (id: string) => ({
  instanceId: id,
  definitionId: id,
  settings: { nested: { secret: "SECRET_DO_NOT_INSPECT" } },
});
describe("module protocol", () => {
  it("validates all settings and capabilities before any create", async () => {
    const create = vi.fn(() => ({ subscriptions: [], provisions: [] }));
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(
        definition("test.a", { create }),
        definition("test.b", { manifest: { requires: [cap] } }),
      ),
    });
    await expect(
      host.start([activation("test.a"), activation("test.b")]),
    ).rejects.toThrow(/capability/);
    expect(create).not.toHaveBeenCalled();
  });
  it("freezes settings, orders dependencies, bounds use and reverses cleanup", async () => {
    const events: string[] = [];
    const provider = definition("test.z", {
      manifest: { provides: [cap] },
      create: () => {
        events.push("create provider");
        return {
          subscriptions: [],
          provisions: [{ capability: cap, value: { read: () => "ok" } }],
          start: () => events.push("start provider"),
          stop: () => events.push("stop provider"),
          dispose: () => events.push("dispose provider"),
        };
      },
    });
    const consumer = definition("test.a", {
      manifest: { requires: [cap] },
      create: ({ settings }: any, context: any) => {
        expect(Object.isFrozen(settings.nested)).toBe(true);
        expect(context.use(cap).read()).toBe("ok");
        expect(() =>
          context.use(defineModuleCapability("test:other", 1)),
        ).toThrow(/declared/);
        events.push("create consumer");
        return {
          subscriptions: [],
          provisions: [],
          start: () => events.push("start consumer"),
          stop: () => events.push("stop consumer"),
          dispose: () => events.push("dispose consumer"),
        };
      },
    });
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(consumer, provider),
    });
    await host.start([activation("test.a"), activation("test.z")]);
    expect(JSON.stringify(host.inspect())).not.toContain(
      "SECRET_DO_NOT_INSPECT",
    );
    await host.stop();
    expect(events).toEqual([
      "create provider",
      "start provider",
      "create consumer",
      "start consumer",
      "stop consumer",
      "stop provider",
      "dispose consumer",
      "dispose provider",
    ]);
  });
  it("rolls back a start failure and aggregates every cleanup failure", async () => {
    const events: string[] = [];
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(
        definition("test.a", {
          create: () => ({
            subscriptions: [],
            provisions: [],
            start: () => {
              throw Error("start");
            },
            stop: () => {
              events.push("stop");
              throw Error("stop");
            },
            dispose: () => {
              events.push("dispose");
              throw Error("dispose");
            },
          }),
        }),
      ),
    });
    await expect(host.start([activation("test.a")])).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(events).toEqual(["stop", "dispose"]);
  });
  it("rejects invalid settings, dependency cycles, versions and duplicate providers before create", async () => {
    const create = vi.fn(() => ({ subscriptions: [], provisions: [] }));
    const a = definition("test.a", { create });
    await expect(
      new ModuleHost({
        core,
        catalog: defineInformationModuleCatalog(a),
      }).start([
        { ...activation("test.a"), settings: { nested: { secret: 3 } } },
      ]),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    const other = defineModuleCapability("test:other", 1);
    const cycles = defineInformationModuleCatalog(
      definition("test.a", {
        create,
        manifest: { requires: [cap], provides: [other] },
      }),
      definition("test.b", {
        create,
        manifest: { requires: [other], provides: [cap] },
      }),
    );
    await expect(
      new ModuleHost({ core, catalog: cycles }).start([
        activation("test.a"),
        activation("test.b"),
      ]),
    ).rejects.toThrow(/cycle/);
    await expect(
      new ModuleHost({
        core,
        catalog: defineInformationModuleCatalog(
          definition("test.a", { create, manifest: { requires: [cap] } }),
        ),
        capabilities: [
          { capability: defineModuleCapability("test:reader", 2), value: {} },
        ],
      }).start([activation("test.a")]),
    ).rejects.toThrow(/version/);
    await expect(
      new ModuleHost({
        core,
        catalog: defineInformationModuleCatalog(
          definition("test.a", { create, manifest: { provides: [cap] } }),
        ),
        capabilities: [{ capability: cap, value: { read: () => "host" } }],
      }).start([activation("test.a")]),
    ).rejects.toThrow(/Duplicate/);
    expect(create).not.toHaveBeenCalled();
  });
  it("disables catalog providers and permits an explicit host replacement", async () => {
    const create = vi.fn(() => ({ subscriptions: [], provisions: [] }));
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(
        definition("test.provider", { create, manifest: { provides: [cap] } }),
        definition("test.consumer", { manifest: { requires: [cap] } }),
      ),
      capabilities: [{ capability: cap, value: { read: () => "replacement" } }],
    });
    await host.start([
      { ...activation("test.provider"), enabled: false, settings: undefined },
      activation("test.consumer"),
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(
      host.inspect().find((d) => d.definitionId === "test.consumer")
        ?.bindings[0]?.capabilities,
    ).toEqual([{ capabilityId: cap.id, provider: "@host" }]);
    await host.stop();
  });
  it("validates kind and Selector identity before create", async () => {
    const create = vi.fn(() => ({ subscriptions: [], provisions: [] }));
    const kind = defineInformationKind({
      kind: "test.input",
      payloadSchema: z.object({}).strict(),
      references: {},
      log: { enabled: false },
    });
    await expect(
      new ModuleHost({
        core,
        catalog: defineInformationModuleCatalog(
          definition("test.a", { create, manifest: { consumes: [kind] } }),
        ),
      }).start([activation("test.a")]),
    ).rejects.toThrow(/kind definition mismatch/);
    const one = defineInformationSelector({
        selectorId: "test.select",
        select: () => [],
      }),
      two = defineInformationSelector({
        selectorId: "test.select",
        select: () => [],
      });
    await expect(
      new ModuleHost({
        core,
        catalog: defineInformationModuleCatalog(
          definition("test.a", { create, manifest: { selectors: [one] } }),
          definition("test.b", { create, manifest: { selectors: [two] } }),
        ),
      }).start([activation("test.a")]),
    ).rejects.toThrow(/Conflicting selectors/);
    expect(create).not.toHaveBeenCalled();
  });
  it("requires exact provisions and disposes the invalid acquired instance", async () => {
    const dispose = vi.fn();
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(
        definition("test.a", {
          manifest: { provides: [cap] },
          create: () => ({ subscriptions: [], provisions: [], dispose }),
        }),
      ),
    });
    await expect(host.start([activation("test.a")])).rejects.toThrow(
      /provision mismatch/,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("aborts and bounds live drain, then refuses late writes", async () => {
    const kind = defineInformationKind({
      kind: "test.input",
      payloadSchema: z.object({}).strict(),
      references: {},
      log: { enabled: false },
    });
    let consume: ((atom: any) => Promise<unknown>) | undefined,
      context: any,
      release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const dispose = vi.fn(),
      register = vi.fn();
    const localCore = {
      ...core,
      registry: { get: () => kind },
      register,
      on: (_kind: any, _identity: any, handle: any) => {
        consume = handle;
        return () => {
          consume = undefined;
        };
      },
    } as unknown as InformationCore;
    const host = new ModuleHost({
      core: localCore,
      drainTimeoutMs: 5,
      catalog: defineInformationModuleCatalog(
        definition("test.a", {
          manifest: { consumes: [kind], produces: [kind] },
          create: () => ({
            provisions: [],
            subscriptions: [
              onInformation(
                kind,
                { subscriptionId: "test.live", delivery: "live" },
                async (_atom, ctx) => {
                  context = ctx;
                  await pending;
                },
              ),
            ],
            dispose,
          }),
        }),
      ),
    });
    await host.start([activation("test.a")]);
    const work = consume!({
      informationId: "test-atom",
      kind: kind.kind,
      references: [],
    });
    await Promise.resolve();
    await host.stop();
    expect(context.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(consume).toBeUndefined();
    await expect(context.register(kind, { payload: {} })).rejects.toThrow(
      /stopped|aborted/,
    );
    expect(register).not.toHaveBeenCalled();
    release();
    await work;
  });
  it("aborts the prepared activation when create throws before returning an instance", async () => {
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    const host = new ModuleHost({
      core,
      catalog: defineInformationModuleCatalog(
        definition("test.create-failure", {
          create: (_options: unknown, context: { signal: AbortSignal }) => {
            signal = context.signal;
            signal.addEventListener("abort", aborted);
            throw new Error("create failed after acquiring a resource");
          },
        }),
      ),
    });
    await expect(
      host.start([activation("test.create-failure")]),
    ).rejects.toThrow("create failed");
    expect(signal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("bounds hung stop and dispose hooks while completing reverse dependency cleanup", async () => {
    const events: string[] = [];
    let releaseStop!: () => void;
    let rejectDispose!: (error: Error) => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const disposeGate = new Promise<void>((_resolve, reject) => {
      rejectDispose = reject;
    });
    const provider = definition("test.provider", {
      manifest: { provides: [cap] },
      create: () => ({
        subscriptions: [],
        provisions: [{ capability: cap, value: { read: () => "ready" } }],
        stop: () => {
          events.push("stop provider");
        },
        dispose: () => {
          events.push("dispose provider");
        },
      }),
    });
    const consumer = definition("test.consumer", {
      manifest: { requires: [cap] },
      create: () => ({
        subscriptions: [],
        provisions: [],
        stop: () => {
          events.push("stop consumer");
          return stopGate;
        },
        dispose: () => {
          events.push("dispose consumer");
          return disposeGate;
        },
      }),
    });
    const host = new ModuleHost({
      core,
      drainTimeoutMs: 10,
      catalog: defineInformationModuleCatalog(consumer, provider),
    });
    await host.start([
      activation("test.consumer"),
      activation("test.provider"),
    ]);
    vi.useFakeTimers();
    let settled = false;
    let failure: unknown;
    const stopping = host.stop().then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(settled).toBe(true);
      expect(events).toEqual([
        "stop consumer",
        "stop provider",
        "dispose consumer",
        "dispose provider",
      ]);
      expect(failure).toMatchObject({
        name: "AggregateError",
        errors: [
          {
            name: "ModuleLifecycleTimeoutError",
            instanceId: "test.consumer",
            hook: "stop",
            timeoutMs: 10,
          },
          {
            name: "ModuleLifecycleTimeoutError",
            instanceId: "test.consumer",
            hook: "dispose",
            timeoutMs: 10,
          },
        ],
      });
    } finally {
      // 超时后的原 Promise 仍可能完成或失败；宿主必须已经消费其 rejection。
      releaseStop();
      rejectDispose(new Error("late dispose failure"));
      await stopping;
      vi.useRealTimers();
    }
  });
});
