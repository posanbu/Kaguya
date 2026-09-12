/**
 * 功能概述：负责第一方消息编写和人物事实模板的 Node 文件加载与验证（或其回归测试）。
 * 主要职责：loadFirstPartyPromptTemplates 返回 messageComposer/personFact；优先 local 覆盖并保留空白，
 * 缺失 local 才回退 default，空模板、读取错误和模板编译错误直接失败。
 * 代码库关系：message-prompt 提供编译校验，templates/message-composer.* 提供各层布局；Runtime 消费结果。
 * 输入输出与副作用：只读模板文件；测试使用临时目录验证覆盖策略并在结束后清理。
 */
import { readFileSync } from "node:fs";
import type { MessagePromptTemplates } from "../first-party/message-composer/message-prompt.js";
import { createMessagePromptCompiler } from "../first-party/message-composer/message-prompt.js";
import { createPromptTemplateRenderer } from "../prompt-template.js";

export type { MessagePromptTemplates } from "../first-party/message-composer/message-prompt.js";

export interface FirstPartyPromptTemplates {
  readonly messageComposer: MessagePromptTemplates;
  readonly personFact: string;
}

export function loadFirstPartyPromptTemplates(
  options: {
    readonly root?: URL;
  } = {},
): FirstPartyPromptTemplates {
  const root = options.root ?? new URL("../../templates/", import.meta.url);
  const templates = {
    messageComposer: {
      main: load(root, "message-composer"),
      history: load(root, "message-composer.history"),
      historyInbound: load(root, "message-composer.history-inbound"),
      historyAssistant: load(root, "message-composer.history-assistant"),
      memory: load(root, "message-composer.memory"),
      memoryItem: load(root, "message-composer.memory-item"),
      quoted: load(root, "message-composer.quoted"),
      turn: load(root, "message-composer.turn"),
    },
    personFact: load(root, "person-fact"),
  };
  validate(templates);
  return templates;
}

function validate(templates: FirstPartyPromptTemplates): void {
  createMessagePromptCompiler(templates.messageComposer, {
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
