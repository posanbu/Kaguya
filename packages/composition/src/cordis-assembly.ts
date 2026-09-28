import { Context, Service } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
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

/** A single boot snapshot, backed by Cordis loader entries for built-in plugins only. */
export class CordisAssembly {
  readonly #root = new Context();
  readonly #tree: CordisPluginTree;
  #loader!: Loader;
  readonly #resources = new Map<string, unknown>();
  readonly #failedDisposals = new Map<string, unknown>();

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

  async mount<T>(
    name: string,
    dependencies: readonly string[],
    create: () => Promise<T> | T,
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
        const resource = await create();
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
    return this.get<T>(name);
  }

  async mountModules(): Promise<void> {
    for (const entry of this.#tree.plugins) {
      if (!entry.id.startsWith("module.") || entry.disabled) continue;
      if (this.#loader.store[entry.id]) continue;
      const plugin = Object.assign((_ctx: Context) => undefined, {
        inject: ["kaguya.catalog"],
      });
      this.#loader.builtins[entry.name] = plugin;
      const options = {
        id: entry.id,
        name: `cordis:${entry.name}`,
        disabled: false,
      };
      await this.#loader.create(options);
      const fiber = this.#loader.resolve(entry.id).fiber;
      if (!fiber) throw new Error(`Module plugin did not start: ${entry.id}`);
      await fiber.await();
      if (fiber.state !== ACTIVE_FIBER_STATE)
        throw new Error(`Module plugin is not active: ${entry.id}`);
    }
  }

  async unmount(name: string): Promise<void> {
    const id = `service.${name}`;
    const entry = this.#loader.store[id];
    if (!entry) return;
    await entry.fiber?.dispose();
    this.#loader.remove(id);
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
    for (const entry of this.#tree.plugins) {
      if (!entry.id.startsWith("module.") || !this.#loader.store[entry.id])
        continue;
      await this.#loader.store[entry.id]!.fiber?.dispose();
      this.#loader.remove(entry.id);
    }
  }

  async dispose(): Promise<void> {
    await this.#root.fiber.dispose();
    if (this.#failedDisposals.size) {
      const failures = [...this.#failedDisposals.values()];
      this.#failedDisposals.clear();
      throw new AggregateError(failures, "Cordis resource cleanup failed");
    }
  }
}
