/** Node-only loader for tracked first-party Prompt templates and ignored local overrides. */
import { readFileSync } from "node:fs";
import type { ReplyPromptTemplates } from "../first-party/llm-reply/reply-prompt.js";
import { createReplyPromptCompiler } from "../first-party/llm-reply/reply-prompt.js";
import { createPromptTemplateRenderer } from "../prompt-template.js";

export type { ReplyPromptTemplates } from "../first-party/llm-reply/reply-prompt.js";

export interface FirstPartyPromptTemplates {
  readonly llmReply: ReplyPromptTemplates;
  readonly personFact: string;
}

export function loadFirstPartyPromptTemplates(
  options: {
    readonly root?: URL;
  } = {},
): FirstPartyPromptTemplates {
  const root = options.root ?? new URL("../../templates/", import.meta.url);
  const templates = {
    llmReply: {
      main: load(root, "llm-reply"),
      history: load(root, "llm-reply.history"),
      historyInbound: load(root, "llm-reply.history-inbound"),
      historyAssistant: load(root, "llm-reply.history-assistant"),
      memory: load(root, "llm-reply.memory"),
      memoryItem: load(root, "llm-reply.memory-item"),
      quoted: load(root, "llm-reply.quoted"),
      target: load(root, "llm-reply.target"),
    },
    personFact: load(root, "person-fact"),
  };
  validate(templates);
  return templates;
}

function validate(templates: FirstPartyPromptTemplates): void {
  createReplyPromptCompiler(templates.llmReply, {
    name: "Template validation",
    aliases: ["template-validation"],
    persona: "Template validation",
  });
  createPromptTemplateRenderer({
    kind: "memory",
    templateId: "kaguya.person-fact.v1",
    main: {
      name: "person-fact",
      content: templates.personFact,
      allowedVariables: ["person_id", "name", "candidate"],
    },
  });
}

function load(root: URL, name: string): string {
  const local = new URL(`${name}.local.hbs`, root);
  const fallback = new URL(`${name}.default.hbs`, root);
  let value: string;
  try {
    value = readFileSync(local, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    value = readFileSync(fallback, "utf8");
  }
  if (value.length === 0) throw new Error(`Prompt template is empty: ${name}`);
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
