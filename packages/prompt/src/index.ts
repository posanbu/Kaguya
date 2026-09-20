import { createHash } from "node:crypto";
import Handlebars from "handlebars";
import type {
  CompiledPrompt,
  PromptTemplate,
  PromptVariable,
} from "@kaguya/schema";

const namePattern = /^[a-z][a-z0-9_-]*$/u;
const helpers = new Set(["each", "if", "unless"]);
const cache = new Map<string, CompiledPromptTemplateSet>();

export type PromptResourceMutability = "editable" | "readonly";
export interface PromptResourceDefinition extends PromptTemplate {
  readonly templateId: string;
  readonly displayName: string;
  readonly description: string;
  readonly allowedVariables: readonly string[];
  readonly allowedPartials: readonly string[];
  readonly composes: readonly string[];
  readonly mutability: PromptResourceMutability;
}
export interface RestrictedPromptTemplate extends PromptTemplate {
  readonly allowedVariables: readonly string[];
  readonly allowedPartials?: readonly string[];
}
export interface CompiledPromptTemplateSet {
  readonly templates: readonly PromptTemplate[];
  usedVariables(name: string): ReadonlySet<string>;
  render(name: string, context: Readonly<Record<string, unknown>>): string;
}

export function digestPromptTemplates(
  templates: readonly PromptTemplate[],
): string {
  return createHash("sha256").update(JSON.stringify(templates)).digest("hex");
}

export function selectPlatformPromptResource<T>(
  resources: Readonly<Record<"default" | "qq" | "web", T>>,
  platform: string,
): T {
  return platform === "qq" || platform === "web"
    ? resources[platform]
    : resources.default;
}

export function compilePromptTemplateSet(
  definitions: readonly RestrictedPromptTemplate[],
  options: { readonly cache?: boolean } = {},
): CompiledPromptTemplateSet {
  if (!definitions.length) throw new Error("Prompt template set is empty");
  const key = JSON.stringify(
    definitions.map((d) => ({
      name: d.name,
      content: d.content,
      allowedVariables: [...d.allowedVariables],
      allowedPartials: [...(d.allowedPartials ?? [])],
    })),
  );
  const hit = options.cache === false ? undefined : cache.get(key);
  if (hit) return hit;
  const engine = Handlebars.create();
  const compiled = new Map<string, HandlebarsTemplateDelegate>();
  const source = new Map<string, PromptTemplate>();
  const variables = new Map<string, ReadonlySet<string>>();
  const edges = new Map<string, ReadonlySet<string>>();
  for (const d of definitions) {
    if (!namePattern.test(d.name) || source.has(d.name))
      throw new Error(`Invalid or duplicate Prompt template: ${d.name}`);
    if (!d.content.trim())
      throw new Error(`Prompt template is empty: ${d.name}`);
    const analysis = analyze(
      engine.parse(d.content),
      new Set(d.allowedVariables),
      new Set(d.allowedPartials ?? []),
      d.name,
    );
    variables.set(d.name, analysis.variables);
    edges.set(d.name, analysis.partials);
    source.set(d.name, Object.freeze({ name: d.name, content: d.content }));
  }
  for (const [owner, partials] of edges)
    for (const partial of partials)
      if (!source.has(partial))
        throw new Error(`Unknown Prompt partial in ${owner}: ${partial}`);
  assertAcyclic(edges);
  for (const { name, content } of source.values())
    engine.registerPartial(name, content);
  for (const { name, content } of source.values())
    compiled.set(
      name,
      engine.compile(content, {
        noEscape: true,
        strict: true,
        knownHelpersOnly: true,
        knownHelpers: { each: true, if: true, unless: true },
      }),
    );
  const result: CompiledPromptTemplateSet = Object.freeze({
    templates: Object.freeze([...source.values()]),
    usedVariables(name: string) {
      const value = variables.get(name);
      if (!value) throw new Error(`Unknown compiled Prompt template: ${name}`);
      return value;
    },
    render(name: string, context: Readonly<Record<string, unknown>>) {
      const template = compiled.get(name);
      if (!template)
        throw new Error(`Unknown compiled Prompt template: ${name}`);
      return template(context, {
        allowCallsToHelperMissing: false,
        allowProtoMethodsByDefault: false,
        allowProtoPropertiesByDefault: false,
      });
    },
  });
  if (options.cache !== false) cache.set(key, result);
  return result;
}

export function createPromptTemplateRenderer(input: {
  readonly kind: CompiledPrompt["kind"];
  readonly templateId: string;
  readonly main: RestrictedPromptTemplate;
}) {
  const templates = compilePromptTemplateSet([input.main]);
  const used = templates.usedVariables(input.main.name);
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
    return {
      kind: input.kind,
      templateId: input.templateId,
      templates: templates.templates.map((template) => ({ ...template })),
      text: templates.render(input.main.name, context),
      variables: provided
        .filter(({ name }) => used.has(name))
        .map((variable) => ({
          name: variable.name,
          content: variable.content,
          informationIds: [...variable.informationIds],
        })),
    };
  };
}

function analyze(
  ast: unknown,
  allowed: ReadonlySet<string>,
  allowedPartials: ReadonlySet<string>,
  owner: string,
) {
  const variables = new Set<string>();
  const partials = new Set<string>();
  const visit = (node: unknown, parent = "") => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent);
      return;
    }
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    const type = value.type;
    if (
      type === "Decorator" ||
      type === "DecoratorBlock" ||
      type === "PartialBlockStatement"
    )
      throw new Error(`Unsupported Handlebars construct in ${owner}`);
    if (type === "PartialStatement") {
      const name = staticPath(value.name);
      if (!name || !allowedPartials.has(name))
        throw new Error(`Unknown or dynamic Prompt partial in ${owner}`);
      partials.add(name);
    }
    if (type === "BlockStatement") {
      const helper = staticPath(value.path);
      if (!helper || !helpers.has(helper))
        throw new Error(`Unsupported Prompt helper in ${owner}: ${helper}`);
    }
    if (type === "SubExpression")
      throw new Error(`Prompt subexpressions are not allowed in ${owner}`);
    if (type === "PathExpression" && parent !== "path" && parent !== "name")
      record(value.original);
    if (type === "MustacheStatement") {
      const path = staticPath(value.path);
      if (
        (Array.isArray(value.params) && value.params.length) ||
        (path && helpers.has(path))
      )
        throw new Error(
          `Prompt helpers are only allowed as blocks in ${owner}`,
        );
      if (path) record(path);
    }
    for (const [key, child] of Object.entries(value))
      if (!["loc", "type", "original"].includes(key)) visit(child, key);
  };
  const record = (path: unknown) => {
    if (typeof path !== "string" || path.startsWith("@") || path.includes(".."))
      throw new Error(`Unsupported Prompt path in ${owner}`);
    const root = path.split(/[./]/u).filter(Boolean)[0];
    if (!root || root === "this" || !allowed.has(root))
      throw new Error(`Unknown Prompt variable in ${owner}: ${path}`);
    variables.add(root);
  };
  visit(ast);
  return { variables, partials };
}
function staticPath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  return node.type === "PathExpression" && typeof node.original === "string"
    ? node.original
    : undefined;
}
function assertAcyclic(graph: ReadonlyMap<string, ReadonlySet<string>>) {
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
