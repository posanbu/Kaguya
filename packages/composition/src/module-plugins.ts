/**
 * 功能概述：从 cordis.yml 的模块条目发现独立 npm/file 包，建立冻结的模块目录与实例快照。
 * 主要职责：loadModulePlugins 只导入启用的外部包，验证 SDK 版本、包身份、Kind 所有权、实例定义与
 * settings；预检完成后返回 Catalog、Kind Registry 和模型能力申请，供数据库与 Runtime 共用。
 * 代码库关系：Server 启动与重载调用本入口；内置 Catalog 作为一个声明源，外部包无需改动任何固定列表。
 * 输入输出与副作用：从配置根解析本地已安装代码，不自动联网安装；任何冲突在处理器创建之前报错。
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigError,
  type CordisPluginTree,
  type ModuleInstanceConfig,
} from "@kaguya/config";
import { createRuntimeKindRegistry } from "@kaguya/runtime";
import {
  catalogInformationKinds,
  defineVersionedInformationKind,
  defineModulePlugin,
  mergeInformationModuleCatalogs,
  type InformationModuleCatalog,
  type InformationModulePlugin,
} from "@kaguya/sdk";

export interface ModulePluginSnapshot {
  readonly catalog: InformationModuleCatalog;
  readonly kindRegistry: ReturnType<typeof createRuntimeKindRegistry>;
  readonly configs: readonly ModuleInstanceConfig[];
  readonly plugins: readonly InformationModulePlugin[];
  readonly modelTasks: Readonly<Record<string, "light" | "heavy">>;
}

export async function loadModulePlugins(options: {
  readonly rootDir: string;
  readonly tree: CordisPluginTree;
  readonly catalog: InformationModuleCatalog;
  readonly configs: readonly ModuleInstanceConfig[];
}): Promise<ModulePluginSnapshot> {
  const plugins = new Map<string, InformationModulePlugin>();
  const bySpecifier = new Map<string, InformationModulePlugin>();
  const builtinKinds = new Map(
    createRuntimeKindRegistry(options.catalog)
      .definitions()
      .map((kind) => [kind.kind, kind]),
  );
  const require = createRequire(resolve(options.rootDir, "package.json"));
  for (const entry of options.tree.plugins) {
    if (
      !entry.id.startsWith("module.") ||
      entry.name.startsWith("kaguya/module/") ||
      entry.disabled
    )
      continue;
    let plugin = bySpecifier.get(entry.name);
    if (!plugin) {
      let imported: { default?: unknown };
      try {
        const path = entry.name.startsWith("file:")
          ? resolve(options.rootDir, entry.name.slice(5))
          : require.resolve(entry.name);
        imported = (await import(pathToFileURL(path).href)) as {
          default?: unknown;
        };
      } catch {
        throw pluginError(
          "PLUGIN_LOAD_FAILED",
          entry.id,
          `Cannot load module plugin: ${entry.id}`,
        );
      }
      try {
        const exported = imported.default;
        const declaration = (
          typeof exported === "function"
            ? exported(
                Object.freeze({
                  kind: (name: string) => {
                    const kind = builtinKinds.get(name);
                    if (!kind)
                      throw new Error(`Host Kind is unavailable: ${name}`);
                    return kind;
                  },
                }),
              )
            : exported
        ) as InformationModulePlugin | undefined;
        if (
          !declaration ||
          declaration.apiVersion !== 1 ||
          !declaration.catalog?.definitions
        )
          throw pluginError(
            "PLUGIN_DECLARATION_INVALID",
            entry.id,
            `Invalid module plugin declaration: ${entry.id}`,
          );
        plugin = defineModulePlugin({
          id: declaration.id,
          version: declaration.version,
          modules: declaration.catalog.definitions,
          modelTasks: declaration.modelTasks,
          compatibility: declaration.compatibility,
        });
        if (plugins.has(plugin.id))
          throw pluginError(
            "PLUGIN_IDENTITY_CONFLICT",
            entry.id,
            `Duplicate module plugin identity: ${plugin.id}`,
          );
        for (const kind of [
          ...catalogInformationKinds(plugin.catalog),
          ...plugin.compatibility.map((rule) => rule.from),
        ]) {
          const builtin = builtinKinds.get(kind.kind);
          if (builtin) {
            if (builtin !== kind)
              throw pluginError(
                "PLUGIN_KIND_CONFLICT",
                entry.id,
                `Information kind definition mismatch: ${kind.kind}`,
              );
          } else if (
            !kind.persistence ||
            kind.persistence.owner !== plugin.id
          ) {
            throw pluginError(
              "PLUGIN_KIND_INVALID",
              entry.id,
              `Plugin Kind requires owned version metadata: ${kind.kind}`,
            );
          } else {
            const checked = defineVersionedInformationKind({
              ...kind,
              owner: kind.persistence.owner,
              version: kind.persistence.version,
            });
            if (
              JSON.stringify(checked.persistence) !==
              JSON.stringify(kind.persistence)
            )
              throw pluginError(
                "PLUGIN_KIND_INVALID",
                entry.id,
                `Invalid plugin Kind schema metadata: ${kind.kind}`,
              );
          }
        }
        plugins.set(plugin.id, plugin);
        bySpecifier.set(entry.name, plugin);
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        throw pluginError(
          "PLUGIN_DECLARATION_INVALID",
          entry.id,
          `Invalid module plugin declaration: ${entry.id}`,
        );
      }
    }
    if (
      !plugin.catalog.definitions.some(
        ({ manifest }) => manifest.definitionId === entry.definitionId,
      )
    )
      throw pluginError(
        "PLUGIN_DEFINITION_MISSING",
        entry.id,
        `Plugin does not declare module: ${entry.id} -> ${entry.definitionId}`,
      );
  }
  let catalog: InformationModuleCatalog;
  let kindRegistry: ModulePluginSnapshot["kindRegistry"];
  try {
    catalog = mergeInformationModuleCatalogs(
      options.catalog,
      ...[...plugins.values()].map((plugin) => plugin.catalog),
    );
    kindRegistry = createRuntimeKindRegistry(
      catalog,
      [...plugins.values()].flatMap((plugin) =>
        plugin.compatibility.map((rule) => rule.from),
      ),
    );
  } catch {
    throw pluginError(
      "PLUGIN_CATALOG_CONFLICT",
      "plugins",
      "Conflicting module or Kind declarations in plugin tree",
    );
  }
  const configs = options.configs.map((config) =>
    freezeJson(structuredClone(config)),
  );
  for (const config of configs) {
    if (config.definitionId.startsWith("adapter.")) continue;
    const definition = catalog.definitions.find(
      ({ manifest }) => manifest.definitionId === config.definitionId,
    );
    if (!definition && !config.enabled) continue;
    if (!definition)
      throw pluginError(
        "PLUGIN_DEFINITION_MISSING",
        `module.${config.instanceId}`,
        `Unknown module definition: ${config.definitionId}`,
      );
    if (!definition.manifest.settingsSchema.safeParse(config.settings).success)
      throw pluginError(
        "PLUGIN_SETTINGS_INVALID",
        `module.${config.instanceId}.settings`,
        `Invalid plugin settings: ${config.instanceId}`,
      );
  }
  return Object.freeze({
    catalog,
    kindRegistry,
    configs: Object.freeze(configs),
    plugins: Object.freeze([...plugins.values()]),
    modelTasks: Object.freeze(
      Object.assign(
        {},
        ...[...plugins.values()].map((plugin) => plugin.modelTasks),
      ),
    ),
  });
}

function pluginError(code: string, path: string, message: string): ConfigError {
  return new ConfigError("CONFIG_INVALID_INPUT", message, {
    validationIssues: [
      {
        code,
        path,
        message,
        hint: "Check the installed package and its cordis.yml entry before applying.",
      },
    ],
  });
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
