/**
 * QQ 表情 learn/select 模板纳入同一 default/local 读取和校验流程。
 * 功能概述：第一方模板的 Node 加载入口，优先读取显式声明的 local 覆盖。
 * 主要职责：loadFirstPartyPromptTemplates 返回消息组、授权消息、Light、人物事实和表达学习模板并预检整组。
 * 代码库关系：资源存储与编译器共用 prompt-declarations；composition 注入运行模块。
 * 输入输出与副作用：只读未渲染模板，保留有效空白；缺失 local 才回退，非法内容直接拒绝。
 */
import type { HeavyPromptTemplates } from "../first-party/heavy/message-prompt.js";
import {
  qqExpressionModulePromptTemplates,
  qqExpressionTemplateDeclarations,
  expressionModulePromptTemplates,
  expressionTemplateDeclarations,
  authorizedMessageTemplateDeclarations,
  heavyModulePromptTemplates,
  messageTemplateDeclarations,
  identityAliasesTemplateDeclaration,
  identityNameTemplateDeclaration,
  identityPersonaTemplateDeclaration,
  lightTemplateDeclaration,
  lightBootstrapPolicyDeclaration,
  lightPlatformPolicyDeclarations,
  personFactTemplateDeclaration,
} from "../prompt-declarations.js";
import {
  readPromptResources,
  validatePromptResources,
} from "./prompt-template-store.js";
export * from "./prompt-template-store.js";
export type { HeavyPromptTemplates } from "../first-party/heavy/message-prompt.js";
export interface FirstPartyPromptTemplates {
  readonly identityName: string;
  readonly identityAliases: readonly string[];
  readonly identityPersona: string;
  readonly qqExpression: { readonly learn: string; readonly select: string };
  readonly expression: { readonly learn: string; readonly select: string };
  readonly authorizedMessage: {
    readonly automatic: string;
    readonly admin: string;
  };
  readonly heavy: HeavyPromptTemplates;
  readonly personFact: string;
  readonly light: string;
  readonly lightBootstrapPolicy: string;
  readonly lightPlatformPolicies: Readonly<
    Record<"default" | "qq" | "web", string>
  >;
}
export function loadFirstPartyPromptTemplates(
  options: { readonly root?: URL } = {},
): FirstPartyPromptTemplates {
  const messages = readPromptResources(
    heavyModulePromptTemplates,
    options.root,
  );
  const lightResources = readPromptResources(
    [
      lightTemplateDeclaration,
      lightBootstrapPolicyDeclaration,
      ...lightPlatformPolicyDeclarations,
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
  const qqExpression = readPromptResources(
    qqExpressionModulePromptTemplates,
    options.root,
  );
  const expression = readPromptResources(
    expressionModulePromptTemplates,
    options.root,
  );
  for (const [declarations, values] of [
    [qqExpressionModulePromptTemplates, qqExpression],
    [expressionModulePromptTemplates, expression],
    [heavyModulePromptTemplates, messages],
    [
      [
        lightTemplateDeclaration,
        lightBootstrapPolicyDeclaration,
        ...lightPlatformPolicyDeclarations,
      ],
      lightResources,
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
    qqExpression: Object.fromEntries(
      qqExpressionTemplateDeclarations.map((d) => [
        d.key,
        qqExpression.find((v) => v.templateId === d.templateId)!.content,
      ]),
    ) as unknown as FirstPartyPromptTemplates["qqExpression"],
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
    heavy: Object.fromEntries([
      ...messageTemplateDeclarations.map(
        (d) =>
          [
            d.key,
            messages.find((v) => v.templateId === d.fileStem)!.content,
          ] as const,
      ),
      [
        "behavior",
        messages.find((v) => v.templateId === "heavy.behavior")!
          .content,
      ],
      [
        "platformStyles",
        {
          default: messages.find(
            (v) => v.templateId === "heavy.platform-style",
          )!.content,
          qq: messages.find(
            (v) => v.templateId === "heavy.platform-style-qq",
          )!.content,
          web: messages.find(
            (v) => v.templateId === "heavy.platform-style-web",
          )!.content,
        },
      ],
    ]) as unknown as HeavyPromptTemplates,
    personFact: person[0]!.content,
    light: lightResources.find(
      (value) => value.templateId === lightTemplateDeclaration.templateId,
    )!.content,
    lightBootstrapPolicy: lightResources.find(
      (value) =>
        value.templateId === lightBootstrapPolicyDeclaration.templateId,
    )!.content,
    lightPlatformPolicies: {
      default: lightResources.find(
        (value) => value.templateId === "light.platform-policy",
      )!.content,
      qq: lightResources.find(
        (value) => value.templateId === "light.platform-policy-qq",
      )!.content,
      web: lightResources.find(
        (value) => value.templateId === "light.platform-policy-web",
      )!.content,
    },
  };
}
