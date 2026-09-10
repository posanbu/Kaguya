/**
 * 受限 Handlebars Prompt 模板运行时。模板在 composition 阶段编译一次，运行时仅渲染；
 * 只开放静态 partial 与 each/if/unless，动态数据不做 HTML 转义。
 */
import Handlebars from "handlebars";
import type {
  CompiledPrompt,
  PromptTemplate,
  PromptVariable,
} from "@kaguya/schema";

const templateNamePattern = /^[a-z][a-z0-9_-]*$/u;
const allowedHelpers = new Set(["each", "if", "unless"]);
const compiledTemplateCache = new Map<string, CompiledPromptTemplateSet>();

export interface RestrictedPromptTemplate extends PromptTemplate {
  readonly allowedVariables: readonly string[];
  readonly allowedPartials?: readonly string[];
}

export interface CompiledPromptTemplateSet {
  readonly templates: readonly PromptTemplate[];
  usedVariables(name: string): ReadonlySet<string>;
  render(name: string, context: Readonly<Record<string, unknown>>): string;
}

export function compilePromptTemplateSet(
  definitions: readonly RestrictedPromptTemplate[],
): CompiledPromptTemplateSet {
  if (definitions.length === 0) throw new Error("Prompt template set is empty");
  const cacheKey = JSON.stringify(
    definitions.map((definition) => ({
      name: definition.name,
      content: definition.content,
      allowedVariables: [...definition.allowedVariables],
      allowedPartials: [...(definition.allowedPartials ?? [])],
    })),
  );
  const cached = compiledTemplateCache.get(cacheKey);
  if (cached) return cached;
  const engine = Handlebars.create();
  const templates = new Map<string, HandlebarsTemplateDelegate>();
  const source = new Map<string, PromptTemplate>();
  const variables = new Map<string, ReadonlySet<string>>();
  const partialEdges = new Map<string, ReadonlySet<string>>();

  for (const definition of definitions) {
    if (
      !templateNamePattern.test(definition.name) ||
      source.has(definition.name)
    )
      throw new Error(
        `Invalid or duplicate Prompt template: ${definition.name}`,
      );
    if (definition.content.length === 0)
      throw new Error(`Prompt template is empty: ${definition.name}`);
    const analysis = analyzeTemplate(
      engine.parse(definition.content),
      new Set(definition.allowedVariables),
      new Set(definition.allowedPartials ?? []),
      definition.name,
    );
    variables.set(definition.name, analysis.variables);
    partialEdges.set(definition.name, analysis.partials);
    source.set(
      definition.name,
      Object.freeze({
        name: definition.name,
        content: definition.content,
      }),
    );
  }

  for (const [name, edges] of partialEdges) {
    for (const partial of edges) {
      if (!source.has(partial))
        throw new Error(`Unknown Prompt partial in ${name}: ${partial}`);
    }
  }
  assertAcyclicPartials(partialEdges);

  for (const { name, content } of source.values())
    engine.registerPartial(name, content);
  for (const { name, content } of source.values()) {
    templates.set(
      name,
      engine.compile(content, {
        noEscape: true,
        strict: true,
        knownHelpersOnly: true,
        knownHelpers: { each: true, if: true, unless: true },
      }),
    );
  }

  const compiled: CompiledPromptTemplateSet = Object.freeze({
    templates: Object.freeze([...source.values()]),
    usedVariables(name: string) {
      const result = variables.get(name);
      if (!result) throw new Error(`Unknown compiled Prompt template: ${name}`);
      return result;
    },
    render(name: string, context: Readonly<Record<string, unknown>>) {
      const template = templates.get(name);
      if (!template)
        throw new Error(`Unknown compiled Prompt template: ${name}`);
      return template(context, {
        allowCallsToHelperMissing: false,
        allowProtoMethodsByDefault: false,
        allowProtoPropertiesByDefault: false,
      });
    },
  });
  compiledTemplateCache.set(cacheKey, compiled);
  return compiled;
}

export function createPromptTemplateRenderer(input: {
  readonly kind: CompiledPrompt["kind"];
  readonly templateId: string;
  readonly main: RestrictedPromptTemplate;
}) {
  const compiled = compilePromptTemplateSet([input.main]);
  const used = compiled.usedVariables(input.main.name);
  return (provided: readonly PromptVariable[]): CompiledPrompt => {
    const byName = new Map<string, PromptVariable>();
    for (const variable of provided) {
      if (byName.has(variable.name))
        throw new Error(`Duplicate Prompt variable: ${variable.name}`);
      byName.set(variable.name, variable);
    }
    const context: Record<string, string> = {};
    for (const name of input.main.allowedVariables) {
      const variable = byName.get(name);
      if (!variable) throw new Error(`Missing Prompt variable: ${name}`);
      context[name] = variable.content;
    }
    const variables = provided
      .filter(({ name }) => used.has(name))
      .map((variable) => ({
        name: variable.name,
        content: variable.content,
        informationIds: [...variable.informationIds],
      }));
    return {
      kind: input.kind,
      templateId: input.templateId,
      templates: compiled.templates.map((template) => ({ ...template })),
      text: compiled.render(input.main.name, context),
      variables,
    };
  };
}

type Analysis = {
  readonly variables: ReadonlySet<string>;
  readonly partials: ReadonlySet<string>;
};

function analyzeTemplate(
  ast: unknown,
  allowedVariables: ReadonlySet<string>,
  allowedPartials: ReadonlySet<string>,
  templateName: string,
): Analysis {
  const variables = new Set<string>();
  const partials = new Set<string>();
  const visit = (node: unknown, parentKey = "") => {
    if (Array.isArray(node)) {
      for (const value of node) visit(value, parentKey);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const value = node as Record<string, unknown>;
    const type = value.type;
    if (
      type === "Decorator" ||
      type === "DecoratorBlock" ||
      type === "PartialBlockStatement"
    )
      throw new Error(`Unsupported Handlebars construct in ${templateName}`);
    if (type === "PartialStatement") {
      const name = staticPath(value.name);
      if (!name || !allowedPartials.has(name))
        throw new Error(`Unknown or dynamic Prompt partial in ${templateName}`);
      partials.add(name);
    }
    if (type === "BlockStatement") {
      const helper = staticPath(value.path);
      if (!helper || !allowedHelpers.has(helper))
        throw new Error(
          `Unsupported Prompt helper in ${templateName}: ${helper}`,
        );
    }
    if (type === "SubExpression")
      throw new Error(
        `Prompt subexpressions are not allowed in ${templateName}`,
      );
    if (
      type === "PathExpression" &&
      parentKey !== "path" &&
      parentKey !== "name"
    )
      recordVariable(value.original, allowedVariables, variables, templateName);
    if (type === "MustacheStatement") {
      const path = staticPath(value.path);
      const params = Array.isArray(value.params) ? value.params : [];
      if (params.length > 0 || (path && allowedHelpers.has(path)))
        throw new Error(
          `Prompt helpers are only allowed as blocks in ${templateName}`,
        );
      if (path) recordVariable(path, allowedVariables, variables, templateName);
    }
    for (const [key, child] of Object.entries(value)) {
      if (["loc", "type", "original"].includes(key)) continue;
      visit(child, key);
    }
  };
  visit(ast);
  return { variables, partials };
}

function recordVariable(
  path: unknown,
  allowed: ReadonlySet<string>,
  used: Set<string>,
  templateName: string,
): void {
  if (typeof path !== "string" || path.startsWith("@") || path.includes(".."))
    throw new Error(`Unsupported Prompt path in ${templateName}`);
  const root = path.split(/[./]/u).filter(Boolean)[0];
  if (!root || root === "this" || !allowed.has(root))
    throw new Error(`Unknown Prompt variable in ${templateName}: ${path}`);
  used.add(root);
}

function staticPath(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const node = value as Record<string, unknown>;
  return node.type === "PathExpression" && typeof node.original === "string"
    ? node.original
    : undefined;
}

function assertAcyclicPartials(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name))
      throw new Error(`Recursive Prompt partial: ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of graph.get(name) ?? []) visit(child);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
}
