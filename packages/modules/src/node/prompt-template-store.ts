/**
 * 功能概述：显式模板资源的本地覆盖存储；default 文件始终只读，所有模块共用显式资源白名单。
 * 主要职责：readPromptResources 读取来源；writePromptOverride/removePromptOverride 只操作白名单 local 文件；
 * validatePromptResources 验证整个模块模板组；initializeLocalPromptTemplates 仅显式创建缺失的 local，错误不包含源码片段。
 * 代码库关系：加载器和管理端共用资源注册表；调用方持有共享配置锁并执行组 revision 比较。
 * 输入输出与副作用：读写未渲染模板，拒绝符号链接及异常文件，限制大小；管理端保存先 fsync 再 rename，显式初始化以独占方式创建。
 */
import {
  constants,
  lstatSync,
  openSync,
  readFileSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ModulePromptTemplateDefinition } from "@kaguya/sdk";
import { compilePromptTemplateSet } from "../prompt-template.js";
import { firstPartyPromptTemplateGroups } from "../prompt-declarations.js";
export const defaultPromptRoot = new URL("../../templates/", import.meta.url);
export const MAX_TEMPLATE_BYTES = 128 * 1024;
const resources = new Map(
  firstPartyPromptTemplateGroups.flatMap((group) =>
    group.map((declaration) => [declaration.templateId, declaration] as const),
  ),
);
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
function resource(id: string) {
  const value = resources.get(id);
  if (!value) throw new Error("Unknown declared Prompt resource");
  return value;
}
function file(root: URL, id: string, suffix: "local" | "default") {
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("Unsafe Prompt root");
  return new URL(`${resource(id).templateId}.${suffix}.hbs`, root);
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
    const fd = openSync(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}
export function readPromptResources(
  declarations: readonly ModulePromptTemplateDefinition[],
  root = defaultPromptRoot,
): PromptResource[] {
  return declarations.map((declaration) => {
    const fallback = read(file(root, declaration.templateId, "default"));
    if (fallback === undefined)
      throw new Error("Missing default Prompt template");
    const local = read(file(root, declaration.templateId, "local"));
    return {
      templateId: declaration.templateId,
      content: local ?? fallback,
      defaultContent: fallback,
      source: local === undefined ? "default" : "local",
    };
  });
}
export function validatePromptResources(
  declarations: readonly ModulePromptTemplateDefinition[],
  values: readonly PromptResource[],
): void {
  try {
    compilePromptTemplateSet(
      declarations.map((d) => ({
        ...d,
        content: values.find((v) => v.templateId === d.templateId)!.content,
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
export async function writePromptOverride(
  id: string,
  content: string,
  root = defaultPromptRoot,
): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_TEMPLATE_BYTES)
    throw new PromptTemplateValidationError("template_too_large");
  const target = file(root, id, "local");
  read(target); // 拒绝覆盖符号链接与异常对象。
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
  id: string,
  root = defaultPromptRoot,
): Promise<void> {
  const target = file(root, id, "local");
  if (read(target) !== undefined) await unlink(target);
}

/** 显式初始化本地副本；先校验完整资源，再以独占创建保护已有个性化内容。 */
export function initializeLocalPromptTemplates(root = defaultPromptRoot): {
  created: string[];
  preserved: string[];
} {
  const groups = firstPartyPromptTemplateGroups.map((declarations) => {
    const values = readPromptResources(declarations, root);
    validatePromptResources(declarations, values);
    validatePromptResources(
      declarations,
      values.map((value) => ({ ...value, content: value.defaultContent })),
    );
    return values;
  });
  const created: string[] = [];
  const preserved: string[] = [];
  for (const value of groups.flat()) {
    const target = file(root, value.templateId, "local");
    try {
      writeFileSync(target, value.defaultContent, { flag: "wx", mode: 0o600 });
      created.push(value.templateId);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      read(target); // 并发创建的对象也必须满足普通文件边界。
      preserved.push(value.templateId);
    }
  }
  return { created, preserved };
}
