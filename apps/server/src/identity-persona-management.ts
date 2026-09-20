import { createHmac, randomBytes } from "node:crypto";
import {
  identityAliasesTemplateDeclaration,
  identityNameTemplateDeclaration,
  identityPersonaTemplateDeclaration,
} from "@kaguya/modules";
import {
  MAX_TEMPLATE_BYTES,
  PromptTemplateValidationError,
  readPromptResources,
  removePromptOverride,
  validatePromptResources,
  writePromptOverride,
} from "@kaguya/modules/prompt-templates/node";
import {
  moduleTemplateReplacementSchema,
  moduleTemplateRestoreSchema,
} from "@kaguya/schema";
import { ModuleTemplateError } from "./module-template-management.js";

export class IdentityPersonaManagement {
  private readonly key = randomBytes(32);
  constructor(
    private readonly options: {
      root?: URL;
      exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    },
  ) {}
  get(kind: IdentityResourceKind = "persona") {
    const declaration = identityResourceDeclarations[kind];
    const value = readPromptResources([declaration], this.options.root)[0]!;
    return {
      ...value,
      templateId: declaration.templateId,
      displayName: declaration.displayName,
      description: declaration.description,
      allowedVariables: [...declaration.allowedVariables],
      effect: "restart_required" as const,
      revision: createHmac("sha256", this.key)
        .update(JSON.stringify(value))
        .digest("hex"),
    };
  }
  async change(
    input: unknown,
    restore = false,
    kind: IdentityResourceKind = "persona",
  ) {
    return this.options.exclusive(async () => {
      const declaration = identityResourceDeclarations[kind];
      const parsed = (
        restore ? moduleTemplateRestoreSchema : moduleTemplateReplacementSchema
      ).safeParse(input);
      if (!parsed.success)
        throw new ModuleTemplateError(400, "invalid_template_input");
      const current = this.get(kind);
      if (current.revision !== parsed.data.revision)
        throw new ModuleTemplateError(409, "templates_changed");
      const content = restore
        ? current.defaultContent
        : moduleTemplateReplacementSchema.parse(input).content;
      if (Buffer.byteLength(content, "utf8") > MAX_TEMPLATE_BYTES)
        throw new ModuleTemplateError(400, "template_too_large");
      try {
        validatePromptResources([declaration], [{ ...current, content }]);
        this.validateIdentity(kind, content);
      } catch (error) {
        if (error instanceof PromptTemplateValidationError)
          throw new ModuleTemplateError(400, error.code);
        throw error;
      }
      if (restore)
        await removePromptOverride(declaration.templateId, this.options.root);
      else
        await writePromptOverride(
          declaration.templateId,
          content,
          this.options.root,
        );
      return this.get(kind);
    });
  }

  private validateIdentity(kind: IdentityResourceKind, content: string) {
    const value = (target: IdentityResourceKind) =>
      target === kind ? content : this.get(target).content;
    const name = value("name").trim();
    const aliases = [
      ...new Set(
        value("aliases")
          .split(/\r?\n/u)
          .map((alias) => alias.trim())
          .filter(Boolean),
      ),
    ];
    if (!name || aliases.length === 0 || aliases.includes(name))
      throw new ModuleTemplateError(400, "invalid_identity_resource");
  }
}

export type IdentityResourceKind = "name" | "aliases" | "persona";

const identityResourceDeclarations = {
  name: identityNameTemplateDeclaration,
  aliases: identityAliasesTemplateDeclaration,
  persona: identityPersonaTemplateDeclaration,
} as const;
