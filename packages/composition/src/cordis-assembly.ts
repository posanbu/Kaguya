/**
 * 功能概述：用 Cordis 服务依赖树管理宿主资源与真实信息模块 fiber。
 * 主要职责：mount 提供可通过 ctx 读取的稳定服务；moduleLifecycle 将模块的 create/start 与
 * stop/drain/dispose 交给对应 fiber；卸载按依赖逆序执行，失败记录并向调用方传播。
 * 代码库关系：Server 持有 Assembly，Runtime 将 lifecycle 注入 ModuleHost；Kind 在激活前
 * 由插件目录预检，持久事实仍走 InformationCore，Cordis 实时生命周期不替代账本或总线。
 * 输入输出与副作用：装载、撤销和失败回滚均等待完成；不包含空模块占位 fiber。
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import type { ModuleHostLifecycle } from "@kaguya/engine";
import type { CordisPluginTree } from "@kaguya/config";

class ResourceService<T> extends Service {
  constructor(
    ctx: Context,
    name: string,
    readonly value: T,
  ) {
    super(ctx, name);
  }
}

// Cordis publishes FiberState as a const enum, without a runtime export.
const ACTIVE_FIBER_STATE = 2;

/** 固定宿主服务与可替换模块 fiber；声明发现先于任何处理器激活。 */
export class CordisAssembly {
  readonly #root = new Context();
  readonly #tree: CordisPluginTree;
  #loader!: Loader;
  readonly #resources = new Map<string, unknown>();
  readonly #failedDisposals = new Map<string, unknown>();
  readonly #mountOrder = new Set<string>();
  #disposePromise: Promise<void> | undefined;

  private constructor(tree: CordisPluginTree) {
    this.#tree = tree;
  }

  static async create(tree: CordisPluginTree): Promise<CordisAssembly> {
    const assembly = new CordisAssembly(tree);
    await assembly.#root.plugin(Loader);
    assembly.#loader = assembly.#root.loader;
    return assembly;
  }

  get<T>(name: string): T {
    if (!this.#resources.has(name))
      throw new Error(`Cordis service is unavailable: ${name}`);
    return this.#resources.get(name) as T;
  }

  /** 服务插件通过其注入的 Context 获取稳定宿主端口；不会创建第二个服务实例。 */
  static service<T>(ctx: Context, name: string): T {
    const service = ctx.get(`kaguya.${name}`) as ResourceService<T> | undefined;
    if (!service) throw new Error(`Cordis service is unavailable: ${name}`);
    return service.value;
  }

  async mount<T>(
    name: string,
    dependencies: readonly string[],
    create: (ctx: Context) => Promise<T> | T,
    dispose: (resource: T) => Promise<void> | void = () => undefined,
  ): Promise<T> {
    const id = `service.${name}`;
    const entry = this.#tree.plugins.find((plugin) => plugin.id === id);
    if (!entry || entry.disabled)
      throw new Error(`Required Cordis plugin is disabled: ${id}`);
    if (this.#loader.store[id])
      throw new Error(`Cordis plugin already mounted: ${id}`);
    const serviceName = `kaguya.${name}`;
    const plugin = Object.assign(
      async (ctx: Context) => {
        const resource = await create(ctx);
        try {
          new ResourceService(ctx, serviceName, resource);
          this.#resources.set(name, resource);
        } catch (error) {
          await dispose(resource);
          throw error;
        }
        return async () => {
          this.#resources.delete(name);
          try {
            await dispose(resource);
          } catch (error) {
            this.#failedDisposals.set(name, error);
          }
        };
      },
      {
        inject: dependencies.map((dependency) => `kaguya.${dependency}`),
        provide: serviceName,
      },
    );
    this.#loader.builtins[entry.name] = plugin;
    const options = { id, name: `cordis:${entry.name}`, disabled: false };
    try {
      await this.#loader.create(options);
      const fiber = this.#loader.resolve(id).fiber;
      if (!fiber) throw new Error(`Cordis plugin did not start: ${id}`);
      await fiber.await();
      if (fiber.state !== ACTIVE_FIBER_STATE)
        throw new Error(`Cordis plugin is not active: ${id}`);
    } catch (error) {
      await this.cleanupFailedMount(id);
      throw error;
    }
    this.#mountOrder.add(id);
    return this.get<T>(name);
  }

  readonly moduleLifecycle: ModuleHostLifecycle = {
    mount: async (instanceId, dependencies, start, stop) => {
      const id = `module.${instanceId}`;
      if (this.#loader.store[id])
        throw new Error(`Module plugin already mounted: ${id}`);
      const plugin = Object.assign(
        async (ctx: Context) => {
          try {
            await start();
            new ResourceService(ctx, `kaguya.${id}`, { instanceId });
          } catch (error) {
            await stop();
            throw error;
          }
          return async () => {
            try {
              await stop();
            } catch (error) {
              this.#failedDisposals.set(id, error);
            }
          };
        },
        {
          inject: [
            "kaguya.catalog",
            ...dependencies.map((id) => `kaguya.module.${id}`),
          ],
          provide: `kaguya.${id}`,
        },
      );
      this.#loader.builtins[id] = plugin;
      try {
        const entry = { id, name: `cordis:${id}`, disabled: false };
        await this.#loader.create(entry);
        const fiber = this.#loader.resolve(id).fiber;
        if (!fiber) throw new Error(`Module plugin did not start: ${id}`);
        await fiber.await();
        if (fiber.state !== ACTIVE_FIBER_STATE)
          throw new Error(`Module plugin is not active: ${id}`);
        this.#mountOrder.add(id);
      } catch (error) {
        await this.cleanupFailedMount(id);
        throw error;
      }
    },
    unmount: async (instanceId) => {
      const id = `module.${instanceId}`;
      const entry = this.#loader.store[id];
      if (entry) {
        await entry.fiber?.dispose();
        this.#loader.remove(id);
      }
      const error = this.#failedDisposals.get(id);
      this.#mountOrder.delete(id);
      this.#failedDisposals.delete(id);
      if (error !== undefined) throw error;
    },
  };

  async unmount(name: string): Promise<void> {
    const id = `service.${name}`;
    const entry = this.#loader.store[id];
    if (!entry) return;
    await entry.fiber?.dispose();
    this.#loader.remove(id);
    this.#mountOrder.delete(id);
    const failure = this.#failedDisposals.get(name);
    if (failure !== undefined) {
      this.#failedDisposals.delete(name);
      throw failure;
    }
  }

  private async cleanupFailedMount(id: string): Promise<void> {
    const failed = this.#loader.store[id];
    await failed?.fiber?.dispose();
    if (failed) this.#loader.remove(id);
  }

  async unmountModules(): Promise<void> {
    const ids = Object.keys(this.#loader.store)
      .filter((id) => id.startsWith("module."))
      .reverse();
    const failures: unknown[] = [];
    for (const id of ids) {
      try {
        await this.moduleLifecycle.unmount(id.slice("module.".length));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Module subtree cleanup failed");
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      const failures: unknown[] = [];
      // Cordis 会触发依赖撤销，但资源的异步 drain 必须在关闭数据库前真正完成。
      for (const id of [...this.#mountOrder].reverse()) {
        try {
          if (id.startsWith("module."))
            await this.moduleLifecycle.unmount(id.slice(7));
          else await this.unmount(id.slice(8));
        } catch (error) {
          failures.push(error);
        }
      }
      await this.#root.fiber.dispose();
      failures.push(...this.#failedDisposals.values());
      this.#failedDisposals.clear();
      if (failures.length)
        throw new AggregateError(failures, "Cordis resource cleanup failed");
    })();
    return this.#disposePromise;
  }
}
