import {
  compilePromptTemplateSet,
  type PromptResourceDefinition,
} from "@kaguya/prompt";
import type { CompiledPrompt } from "@kaguya/schema";

export const structuredOutputJsonPromptDeclaration: PromptResourceDefinition = {
  templateId: "structured-output-json",
  name: "structured-output-json",
  displayName: "JSON 结构化输出协议",
  description: "要求模型严格输出符合任务 JSON Schema 的 JSON 值。",
  content: "",
  allowedVariables: ["json_schema"],
  allowedPartials: [],
  composes: [],
  mutability: "readonly",
};

export type StructuredOutputPromptRenderer = (
  prompt: CompiledPrompt,
  jsonSchema: unknown,
) => CompiledPrompt;

export function createStructuredOutputPromptRenderer(
  content: string,
): StructuredOutputPromptRenderer {
  const definition = { ...structuredOutputJsonPromptDeclaration, content };
  const compiled = compilePromptTemplateSet([definition]);
  return (prompt, jsonSchema) => {
    const encoded = JSON.stringify(jsonSchema);
    const existingTemplate = prompt.templates.find(
      ({ name }) => name === definition.name,
    );
    if (existingTemplate) {
      const existingVariable = prompt.variables.find(
        ({ name }) => name === "json_schema",
      );
      if (
        existingTemplate.content !== content ||
        existingVariable?.content !== encoded
      )
        throw new Error(
          "Persisted structured output Prompt does not match the task schema",
        );
      return prompt;
    }
    return {
      ...prompt,
      text: `${prompt.text}\n\n${compiled.render(definition.name, { json_schema: encoded })}`,
      templates: [...prompt.templates, ...compiled.templates],
      variables: [
        ...prompt.variables,
        { name: "json_schema", content: encoded, informationIds: [] },
      ],
    };
  };
}
