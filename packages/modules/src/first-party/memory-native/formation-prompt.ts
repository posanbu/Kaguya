/** 运行时与离线评测共用形成 Prompt 编译，保留冻结输入、策略和变量来源。 */
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { nativeMemoryTemplateDeclaration } from "../../prompt-declarations.js";
import type { FormationInput } from "./formation.js";

export function createFormationPromptRenderer(template: string) {
  const render = createPromptTemplateRenderer({
    kind: "memory",
    templateId: "memory.native.form.v1",
    main: { ...nativeMemoryTemplateDeclaration, content: template },
  });
  return (p: FormationInput, informationIds: readonly string[]) =>
    render([
      {
        name: "context",
        content: JSON.stringify({
          ...p,
          ...(p.formationPolicy
            ? {
                formationRules: {
                  policy: p.formationPolicy,
                  instructions:
                    "批次仅为读取窗口。延续同一经历时使用已有节点ID作为key。证据不足时保持不变，不把旁观者内容归给被提问者。封口、重开、更正用experienceOperation且inputIds和outputIds为同一已有ID。合并/拆分用旧ID作为inputIds、新key作为outputIds，nodes同时包含归档输入及active输出。输出明确分配原输入全部来源，不编造归属。每批至多一次经历操作；其他节点可普通增补。空结果或完全无变化确认本批读取。",
                },
              }
            : {}),
        }),
        informationIds: [...informationIds],
      },
    ]);
}
