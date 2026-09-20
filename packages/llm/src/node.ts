import {
  readPromptResources,
  validatePromptResources,
} from "@kaguya/prompt/node";
import {
  createStructuredOutputPromptRenderer,
  structuredOutputJsonPromptDeclaration,
} from "./protocol-prompt.js";

export const defaultLlmPromptRoot = new URL("../templates/", import.meta.url);
export function loadStructuredOutputPromptRenderer(
  root = defaultLlmPromptRoot,
) {
  const declarations = [structuredOutputJsonPromptDeclaration];
  const resources = readPromptResources(declarations, root);
  validatePromptResources(declarations, resources);
  return createStructuredOutputPromptRenderer(resources[0]!.content);
}
