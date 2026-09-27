/**
 * 功能概述：将授权消息的默认或本地模板编译为供 Runtime 注入的纯渲染函数。
 * 主要职责：createAuthorizedMessagePromptRenderer 在构造时分别编译自动授权与管理员授权文本；
 * 返回函数只接受已冻结的 instruction/background 变量，保留原有模板标识、变量顺序及 Information 来源。
 * 代码库关系：composition 传入 Node 加载器选出的正文，MessageTargetService 负责授权后调用；本文件不读取磁盘或决定权限。
 * 输入输出与副作用：输入未渲染模板，返回 CompiledPrompt；非法模板立即抛错，动态数据不被二次渲染。
 */
import type { PromptVariable } from "@kaguya/schema";
import { authorizedMessageTemplateDeclarations } from "../../prompt-declarations.js";
import { createPromptTemplateRenderer } from "../../prompt-template.js";

export function createAuthorizedMessagePromptRenderer(templates: {
  readonly automatic: string;
  readonly admin: string;
}) {
  const renderers = authorizedMessageTemplateDeclarations.map((declaration) =>
    createPromptTemplateRenderer({
      kind: "message",
      templateId: "authorized-message-v1",
      main: {
        ...declaration,
        name: "message",
        content: templates[declaration.key],
      },
    }),
  );
  return (input: {
    readonly automatic: boolean;
    readonly instruction: PromptVariable;
    readonly background?: PromptVariable;
  }) => {
    const renderer = renderers[input.automatic ? 0 : 1]!;
    return renderer([
      ...(input.automatic
        ? [
            input.background ?? {
              name: "background",
              content: "",
              informationIds: [],
            },
          ]
        : []),
      input.instruction,
    ]);
  };
}
