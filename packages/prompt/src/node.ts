import {
  constants,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  compilePromptTemplateSet,
  type PromptResourceDefinition,
} from "./index.js";

export const MAX_TEMPLATE_BYTES = 128 * 1024;
export class PromptTemplateValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface PromptResource {
  readonly templateId: string;
  readonly content: string;
  readonly defaultContent: string;
  readonly source: "default" | "local";
}

function definitionMap(definitions: readonly PromptResourceDefinition[]) {
  return new Map(
    definitions.map((definition) => [definition.templateId, definition]),
  );
}
function pathFor(
  root: URL,
  definition: PromptResourceDefinition,
  suffix: "local" | "default",
) {
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("Unsafe Prompt root");
  return new URL(`${definition.templateId}.${suffix}.hbs`, root);
}
function read(path: URL): string | undefined {
  try {
    const stats = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > MAX_TEMPLATE_BYTES
    )
      throw new Error("Unsafe Prompt file");
    const descriptor = openSync(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      return readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

export function readPromptResources(
  definitions: readonly PromptResourceDefinition[],
  root: URL,
): PromptResource[] {
  return definitions.map((definition) => {
    const fallback = read(pathFor(root, definition, "default"));
    if (fallback === undefined)
      throw new Error(
        `Missing default Prompt template: ${definition.templateId}`,
      );
    const local =
      definition.mutability === "editable"
        ? read(pathFor(root, definition, "local"))
        : undefined;
    if (
      definition.mutability === "readonly" &&
      read(pathFor(root, definition, "local")) !== undefined
    )
      throw new Error(
        `Readonly Prompt template has local override: ${definition.templateId}`,
      );
    return {
      templateId: definition.templateId,
      content: local ?? fallback,
      defaultContent: fallback,
      source: local === undefined ? "default" : "local",
    };
  });
}

export function validatePromptResources(
  definitions: readonly PromptResourceDefinition[],
  values: readonly PromptResource[],
): void {
  try {
    compilePromptTemplateSet(
      definitions.map((definition) => ({
        ...definition,
        content: values.find(
          (value) => value.templateId === definition.templateId,
        )!.content,
      })),
      { cache: false },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = message.includes("empty")
      ? "empty_template"
      : message.includes("Recursive")
        ? "recursive_partial"
        : message.includes("variable") || message.includes("path")
          ? "unknown_variable"
          : message.includes("partial")
            ? "invalid_partial"
            : message.includes("helper") ||
                message.includes("subexpression") ||
                message.includes("construct")
              ? "unsupported_helper"
              : "invalid_syntax";
    throw new PromptTemplateValidationError(code);
  }
}

export function validatePromptResourceInventory(
  definitions: readonly PromptResourceDefinition[],
  root: URL,
): void {
  const known = new Set(
    definitions.flatMap((definition) => [
      `${definition.templateId}.default.hbs`,
      ...(definition.mutability === "editable"
        ? [`${definition.templateId}.local.hbs`]
        : []),
    ]),
  );
  for (const name of readdirSync(root)) {
    if (
      (name.endsWith(".default.hbs") || name.endsWith(".local.hbs")) &&
      !known.has(name)
    )
      throw new Error(`Orphan Prompt resource: ${name}`);
  }
  const values = readPromptResources(definitions, root);
  validatePromptResources(definitions, values);
  validatePromptResources(
    definitions,
    values.map((value) => ({ ...value, content: value.defaultContent })),
  );
}

export async function writePromptOverride(
  definitions: readonly PromptResourceDefinition[],
  id: string,
  content: string,
  root: URL,
): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_TEMPLATE_BYTES)
    throw new PromptTemplateValidationError("template_too_large");
  const definition = definitionMap(definitions).get(id);
  if (!definition) throw new Error("Unknown declared Prompt resource");
  if (definition.mutability !== "editable")
    throw new PromptTemplateValidationError("readonly_template");
  const target = pathFor(root, definition, "local");
  read(target);
  const temporary = `${fileURLToPath(target)}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removePromptOverride(
  definitions: readonly PromptResourceDefinition[],
  id: string,
  root: URL,
): Promise<void> {
  const definition = definitionMap(definitions).get(id);
  if (!definition) throw new Error("Unknown declared Prompt resource");
  if (definition.mutability !== "editable")
    throw new PromptTemplateValidationError("readonly_template");
  const target = pathFor(root, definition, "local");
  if (read(target) !== undefined) await unlink(target);
}

export function initializeLocalPromptTemplates(
  definitions: readonly PromptResourceDefinition[],
  root: URL,
) {
  const values = readPromptResources(definitions, root);
  validatePromptResources(definitions, values);
  const created: string[] = [],
    preserved: string[] = [];
  for (const value of values) {
    const definition = definitionMap(definitions).get(value.templateId)!;
    if (definition.mutability !== "editable") continue;
    const target = pathFor(root, definition, "local");
    try {
      writeFileSync(target, value.defaultContent, { flag: "wx", mode: 0o600 });
      created.push(value.templateId);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      read(target);
      preserved.push(value.templateId);
    }
  }
  return { created, preserved };
}
