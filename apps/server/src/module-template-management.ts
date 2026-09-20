/**
 * 功能概述：按 Catalog 显式归属管理未渲染 Prompt 模板，默认值只读。
 * 主要职责：读取静态声明与 local 来源；replace/restore 在共享配置锁中校验组 revision，
 * 用候选替换整组编译成功后才写入或删除 local；错误不返回源码或底层文件异常。
 * 代码库关系：依赖 modules 的统一 Node 存储/受限编译器，由 Server 注入 Catalog 与写锁。
 * 输入输出与副作用：HMAC 覆盖默认值及覆盖来源，保存不应用；响应明确要求重启。
 */
import { createHmac, randomBytes } from "node:crypto";
import type { InformationModuleCatalog } from "@kaguya/sdk";
import {
  moduleTemplateReplacementSchema,
  moduleTemplateRestoreSchema,
  type ModuleTemplatesView,
} from "@kaguya/schema";
import {
  MAX_TEMPLATE_BYTES,
  readPromptResources,
  validatePromptResources,
  writePromptOverride,
  removePromptOverride,
  PromptTemplateValidationError,
} from "@kaguya/modules/prompt-templates/node";
export class ModuleTemplateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class ModuleTemplateManagement {
  private readonly key = randomBytes(32);
  constructor(
    private readonly options: {
      catalog: InformationModuleCatalog;
      root?: URL;
      exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    },
  ) {}
  private declarations(id: string) {
    const definition = this.options.catalog.definitions.find(
      (d) => d.manifest.definitionId === id,
    );
    if (!definition) throw new ModuleTemplateError(404, "module_not_found");
    return definition.manifest.promptTemplates ?? [];
  }
  get(id: string): ModuleTemplatesView {
    const declarations = this.declarations(id);
    const values = readPromptResources(declarations, this.options.root);
    return {
      definitionId: id,
      effect: "restart_required",
      revision: createHmac("sha256", this.key)
        .update(JSON.stringify(values))
        .digest("hex"),
      templates: declarations.map((d) => ({
        ...values.find((v) => v.templateId === d.templateId)!,
        templateId: d.templateId,
        mutability: d.mutability,
        name: d.name,
        displayName: d.displayName,
        description: d.description,
        allowedVariables: [...d.allowedVariables],
        allowedPartials: [...d.allowedPartials],
        composes: [...d.composes],
      })),
    };
  }
  async change(
    id: string,
    templateId: string,
    input: unknown,
    restore = false,
  ): Promise<ModuleTemplatesView> {
    return this.options.exclusive(async () => {
      const parsed = (
        restore ? moduleTemplateRestoreSchema : moduleTemplateReplacementSchema
      ).safeParse(input);
      if (!parsed.success)
        throw new ModuleTemplateError(400, "invalid_template_input");
      if (
        !restore &&
        Buffer.byteLength(
          moduleTemplateReplacementSchema.parse(input).content,
          "utf8",
        ) > MAX_TEMPLATE_BYTES
      )
        throw new ModuleTemplateError(400, "template_too_large");
      const declarations = this.declarations(id);
      if (!declarations.some((d) => d.templateId === templateId))
        throw new ModuleTemplateError(404, "template_not_found");
      const current = this.get(id);
      if (current.revision !== parsed.data.revision)
        throw new ModuleTemplateError(409, "templates_changed");
      const values = current.templates.map((t) => ({
        ...t,
        content:
          t.templateId === templateId
            ? restore
              ? t.defaultContent
              : moduleTemplateReplacementSchema.parse(input).content
            : t.content,
      }));
      try {
        validatePromptResources(declarations, values);
      } catch (error) {
        if (error instanceof PromptTemplateValidationError)
          throw new ModuleTemplateError(400, error.code);
        throw error;
      }
      if (restore) await removePromptOverride(templateId, this.options.root);
      else
        await writePromptOverride(
          templateId,
          values.find((t) => t.templateId === templateId)!.content,
          this.options.root,
        );
      return this.get(id);
    });
  }
}
