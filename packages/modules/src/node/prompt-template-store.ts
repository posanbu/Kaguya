/** Module-facing adapter over the deep @kaguya/prompt resource store. */
import type { PromptResourceDefinition } from "@kaguya/prompt";
import {
  MAX_TEMPLATE_BYTES,
  PromptTemplateValidationError,
  initializeLocalPromptTemplates as initialize,
  readPromptResources as readResources,
  removePromptOverride as removeOverride,
  validatePromptResources as validateResources,
  writePromptOverride as writeOverride,
  type PromptResource,
} from "@kaguya/prompt/node";
import type { ModulePromptTemplateDefinition } from "@kaguya/sdk";
import { firstPartyPromptTemplateGroups } from "../prompt-declarations.js";

export {
  MAX_TEMPLATE_BYTES,
  PromptTemplateValidationError,
  type PromptResource,
};
export const defaultPromptRoot = new URL("../../templates/", import.meta.url);

const definitions: readonly PromptResourceDefinition[] =
  firstPartyPromptTemplateGroups.flat().map((definition) => ({
    ...definition,
    content: "",
  }));

function adapt(
  declarations: readonly ModulePromptTemplateDefinition[],
): PromptResourceDefinition[] {
  return declarations.map((declaration) => ({
    ...declaration,
    content: "",
  }));
}

export function readPromptResources(
  declarations: readonly ModulePromptTemplateDefinition[],
  root = defaultPromptRoot,
): PromptResource[] {
  return readResources(adapt(declarations), root);
}

export function validatePromptResources(
  declarations: readonly ModulePromptTemplateDefinition[],
  values: readonly PromptResource[],
): void {
  validateResources(adapt(declarations), values);
}

export function writePromptOverride(
  id: string,
  content: string,
  root = defaultPromptRoot,
): Promise<void> {
  return writeOverride(definitions, id, content, root);
}
export function removePromptOverride(
  id: string,
  root = defaultPromptRoot,
): Promise<void> {
  return removeOverride(definitions, id, root);
}
export function initializeLocalPromptTemplates(root = defaultPromptRoot) {
  return initialize(definitions, root);
}
