/**
 * 功能概述：第一方模板的 Node 加载入口，优先读取显式声明的 local 覆盖。
 * 主要职责：loadFirstPartyPromptTemplates 返回消息组、授权消息、Planner、人物事实和表达学习模板并预检整组。
 * 代码库关系：资源存储与编译器共用 prompt-declarations；composition 注入运行模块。
 * 输入输出与副作用：只读未渲染模板，保留有效空白；缺失 local 才回退，非法内容直接拒绝。
 */
import type { MessagePromptTemplates } from "../first-party/message-composer/message-prompt.js";
import {
  expressionModulePromptTemplates,
  expressionTemplateDeclarations,
  authorizedMessageTemplateDeclarations,
  messageModulePromptTemplates,
  messageTemplateDeclarations,
  identityAliasesTemplateDeclaration,
  identityNameTemplateDeclaration,
  identityPersonaTemplateDeclaration,
  plannerTemplateDeclaration,
  plannerBootstrapPolicyDeclaration,
  plannerPlatformPolicyDeclarations,
  personFactTemplateDeclaration,
} from "../prompt-declarations.js";
import {
  readPromptResources,
  validatePromptResources,
} from "./prompt-template-store.js";
export * from "./prompt-template-store.js";
export type { MessagePromptTemplates } from "../first-party/message-composer/message-prompt.js";
export interface FirstPartyPromptTemplates {
  readonly identityName: string;
  readonly identityAliases: readonly string[];
  readonly identityPersona: string;
  readonly expression: { readonly learn: string; readonly select: string };
  readonly authorizedMessage: {
    readonly automatic: string;
    readonly admin: string;
  };
  readonly messageComposer: MessagePromptTemplates;
  readonly personFact: string;
  readonly planner: string;
  readonly plannerBootstrapPolicy: string;
  readonly plannerPlatformPolicies: Readonly<
    Record<"default" | "qq" | "web", string>
  >;
}
export function loadFirstPartyPromptTemplates(
  options: { readonly root?: URL } = {},
): FirstPartyPromptTemplates {
  const messages = readPromptResources(
    messageModulePromptTemplates,
    options.root,
  );
  const planner = readPromptResources(
    [
      plannerTemplateDeclaration,
      plannerBootstrapPolicyDeclaration,
      ...plannerPlatformPolicyDeclarations,
    ],
    options.root,
  );
  const identity = readPromptResources(
    [
      identityNameTemplateDeclaration,
      identityAliasesTemplateDeclaration,
      identityPersonaTemplateDeclaration,
    ],
    options.root,
  );
  const person = readPromptResources(
    [personFactTemplateDeclaration],
    options.root,
  );
  const expression = readPromptResources(
    expressionModulePromptTemplates,
    options.root,
  );
  for (const [declarations, values] of [
    [expressionModulePromptTemplates, expression],
    [messageModulePromptTemplates, messages],
    [
      [
        plannerTemplateDeclaration,
        plannerBootstrapPolicyDeclaration,
        ...plannerPlatformPolicyDeclarations,
      ],
      planner,
    ],
    [
      [
        identityNameTemplateDeclaration,
        identityAliasesTemplateDeclaration,
        identityPersonaTemplateDeclaration,
      ],
      identity,
    ],
    [[personFactTemplateDeclaration], person],
  ] as const) {
    // 保持启动错误上下文；管理端只公开稳定错误代码。
    for (const value of values)
      if (!value.content.trim())
        throw new Error(`Prompt template is empty: ${value.templateId}`);
    validatePromptResources(declarations, values);
  }
  const identityName = identity[0]!.content.trim();
  const identityAliases = [
    ...new Set(
      identity[1]!.content
        .split(/\r?\n/u)
        .map((alias) => alias.trim())
        .filter(Boolean),
    ),
  ];
  if (!identityName) throw new Error("Agent identity name is empty");
  if (identityAliases.length === 0)
    throw new Error("Agent identity aliases are empty");
  if (identityAliases.includes(identityName))
    throw new Error("Agent identity aliases must differ from the name");
  return {
    identityName,
    identityAliases,
    identityPersona: identity[2]!.content,
    expression: Object.fromEntries(
      expressionTemplateDeclarations.map((d) => [
        d.key,
        expression.find((v) => v.templateId === d.templateId)!.content,
      ]),
    ) as unknown as FirstPartyPromptTemplates["expression"],
    authorizedMessage: Object.fromEntries(
      authorizedMessageTemplateDeclarations.map((d) => [
        d.key,
        messages.find((v) => v.templateId === d.templateId)!.content,
      ]),
    ) as unknown as FirstPartyPromptTemplates["authorizedMessage"],
    messageComposer: Object.fromEntries([
      ...messageTemplateDeclarations.map(
        (d) =>
          [
            d.key,
            messages.find((v) => v.templateId === d.fileStem)!.content,
          ] as const,
      ),
      [
        "behavior",
        messages.find((v) => v.templateId === "message-composer.behavior")!
          .content,
      ],
      [
        "platformStyles",
        {
          default: messages.find(
            (v) => v.templateId === "message-composer.platform-style",
          )!.content,
          qq: messages.find(
            (v) => v.templateId === "message-composer.platform-style-qq",
          )!.content,
          web: messages.find(
            (v) => v.templateId === "message-composer.platform-style-web",
          )!.content,
        },
      ],
    ]) as unknown as MessagePromptTemplates,
    personFact: person[0]!.content,
    planner: planner.find(
      (value) => value.templateId === plannerTemplateDeclaration.templateId,
    )!.content,
    plannerBootstrapPolicy: planner.find(
      (value) =>
        value.templateId === plannerBootstrapPolicyDeclaration.templateId,
    )!.content,
    plannerPlatformPolicies: {
      default: planner.find(
        (value) => value.templateId === "heartflow.platform-policy",
      )!.content,
      qq: planner.find(
        (value) => value.templateId === "heartflow.platform-policy-qq",
      )!.content,
      web: planner.find(
        (value) => value.templateId === "heartflow.platform-policy-web",
      )!.content,
    },
  };
}
