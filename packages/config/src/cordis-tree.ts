import { join } from "node:path";

import { isAlias, parseDocument, stringify, visit } from "yaml";
import { z } from "zod";

import { ConfigError } from "./errors.js";
import {
  assertPathInside,
  readSensitiveText,
  writeSensitiveText,
} from "./secure-files.js";

export const CORDIS_SERVICE_NAMES = [
  "configuration",
  "logging",
  "catalog",
  "database",
  "adapter",
  "runtime",
  "http",
  "web-ui",
] as const;

const entrySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  disabled: z.boolean(),
});
const treeSchema = z.strictObject({ plugins: z.array(entrySchema) });

export type CordisPluginEntry = z.infer<typeof entrySchema>;
export interface CordisPluginTree {
  readonly plugins: readonly CordisPluginEntry[];
}
export interface CordisModuleIdentity {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly enabled: boolean;
}

export function defaultCordisTree(
  modules: readonly CordisModuleIdentity[],
): CordisPluginTree {
  return freezeTree({
    plugins: [
      ...CORDIS_SERVICE_NAMES.map((service) => ({
        id: `service.${service}`,
        name: `kaguya/${service}`,
        disabled: false,
      })),
      ...modules.map((module) => ({
        id: `module.${module.instanceId}`,
        name: `kaguya/module/${module.definitionId}`,
        disabled: !module.enabled,
      })),
    ],
  });
}

export function validateCordisTree(
  value: unknown,
  modules: readonly CordisModuleIdentity[],
): CordisPluginTree {
  const parsed = treeSchema.safeParse(value);
  if (!parsed.success) throw invalidTree();
  const expected = defaultCordisTree(modules).plugins;
  const known = new Map(expected.map((entry) => [entry.id, entry.name]));
  const seen = new Set<string>();
  for (const entry of parsed.data.plugins) {
    if (seen.has(entry.id) || known.get(entry.id) !== entry.name)
      throw invalidTree();
    if (entry.id.startsWith("service.") && entry.disabled) throw invalidTree();
    seen.add(entry.id);
  }
  if (seen.size !== known.size) throw invalidTree();
  return freezeTree(parsed.data);
}

export async function loadCordisTree(options: {
  readonly rootDir: string;
  readonly modules: readonly CordisModuleIdentity[];
  readonly initialize?: boolean;
}): Promise<CordisPluginTree> {
  const path = treePath(options.rootDir);
  try {
    const document = parseDocument(await readSensitiveText(path), {
      uniqueKeys: true,
      schema: "core",
    });
    if (document.errors.length || document.warnings.length) throw invalidTree();
    let hasAlias = false;
    visit(document, (_key, node) => {
      if (isAlias(node)) hasAlias = true;
    });
    if (hasAlias) throw invalidTree();
    return validateCordisTree(
      document.toJS({ maxAliasCount: 0 }),
      options.modules,
    );
  } catch (error) {
    if (isMissing(error)) {
      if (options.initialize === false) throw invalidTree();
      const tree = defaultCordisTree(options.modules);
      await writeCordisTree(options.rootDir, tree, options.modules);
      return tree;
    }
    if (error instanceof ConfigError) throw error;
    throw invalidTree();
  }
}

export async function writeCordisTree(
  rootDir: string,
  tree: CordisPluginTree,
  modules: readonly CordisModuleIdentity[],
): Promise<void> {
  const valid = validateCordisTree(tree, modules);
  await writeSensitiveText(treePath(rootDir), stringify(valid));
}

export async function writeCordisModuleEnabled(
  rootDir: string,
  modules: readonly CordisModuleIdentity[],
  instanceId: string,
  enabled: boolean,
): Promise<void> {
  const current = await loadCordisTree({ rootDir, modules, initialize: false });
  const id = `module.${instanceId}`;
  if (!current.plugins.some((entry) => entry.id === id)) throw invalidTree();
  const next = {
    plugins: current.plugins.map((entry) =>
      entry.id === id ? { ...entry, disabled: !enabled } : entry,
    ),
  };
  await writeCordisTree(rootDir, next, modules);
}

export function moduleEnabled(
  tree: CordisPluginTree,
  instanceId: string,
): boolean {
  const entry = tree.plugins.find((item) => item.id === `module.${instanceId}`);
  if (!entry) throw invalidTree();
  return !entry.disabled;
}

function treePath(rootDir: string): string {
  const path = join(rootDir, "cordis.yml");
  assertPathInside(rootDir, path);
  return path;
}

function freezeTree(tree: CordisPluginTree): CordisPluginTree {
  return Object.freeze({
    plugins: Object.freeze(
      tree.plugins.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function invalidTree(): ConfigError {
  return new ConfigError(
    "CONFIG_CORRUPT_STORE",
    "Cordis plugin tree failed validation",
  );
}

function isMissing(error: unknown): boolean {
  if (error instanceof ConfigError && error.cause)
    return isMissing(error.cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
