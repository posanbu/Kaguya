/**
 * 功能概述：把已冻结的表达选择接到 Composer，不在 Composer 内训练或选择表达。
 * dispatchSelector 只追溯原获胜意图；withExpressionContext 复用原消息 Selector，并追加选择事实及其直接来源。
 * expressionPrompt 通过 Composer 构造时注入的受限 renderer 渲染独立的 expression_habits 变量，并追加模板实际使用的变量与源码。
 * provenance 指向选择结果和验证批次，不改变目标、事实或动作；没有表达选择时返回原 Prompt，不执行 I/O。
 */
import {
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
  type PromptVariable,
} from "@kaguya/schema";
import {
  defineInformationSelector,
  type InformationSelectorDefinition,
} from "@kaguya/sdk";
import { messageIntentRequestedInformationKind } from "../information-kinds.js";
import { expressionSelected } from "./facts.js";
export const expressionDispatchSelector = defineInformationSelector({
  selectorId: "memory.expression.composer.dispatch",
  select: async ({ sourceAtom, ledger }) => {
    const selected = expressionSelected.payloadSchema.parse(sourceAtom.payload);
    const refs = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 1000,
    });
    const intent = refs.find(
      (a) =>
        a.kind === messageIntentRequestedInformationKind.kind &&
        a.informationId === selected.intentInformationId,
    );
    if (!intent) throw new Error("Expression selection lost winning intent");
    return [sourceAtom.informationId, ...refs.map((a) => a.informationId)];
  },
});
export function withExpressionContext(base: InformationSelectorDefinition) {
  return defineInformationSelector({
    selectorId: "memory.expression.composer.context",
    select: async (context) => {
      const ids = await expressionDispatchSelector.select(context);
      const atoms = await context.ledger.find({
        informationIds: [...ids],
        limit: 1000,
      });
      const intent = atoms.find(
        (a) =>
          a.kind === messageIntentRequestedInformationKind.kind &&
          a.informationId === context.sourceAtom.payload.intentInformationId,
      )!;
      return [
        ...new Set([
          ...ids,
          ...(await base.select({ ...context, sourceAtom: intent })),
        ]),
      ];
    },
  });
}
export function expressionPrompt(
  prompt: CompiledPrompt,
  atoms: readonly DeepReadonly<InformationAtom>[],
  intentId: string,
  renderHabits: (variables: readonly PromptVariable[]) => CompiledPrompt,
): CompiledPrompt {
  const selection = atoms.find(
    (a) =>
      a.kind === expressionSelected.kind &&
      a.payload.intentInformationId === intentId,
  );
  if (!selection) return prompt;
  const payload = expressionSelected.payloadSchema.parse(selection.payload);
  const content = JSON.stringify(
    payload.habits.map(({ situation, style }) => ({ situation, style })),
  );
  const suffix = renderHabits([
    {
      name: "expression_habits",
      content,
      informationIds: [
        selection.informationId,
        ...selection.references
          .filter((r) => r.relation === "core:uses-context")
          .map((r) => r.informationId),
      ],
    },
  ]);
  return {
    ...prompt,
    text: prompt.text + suffix.text,
    templates: [...prompt.templates, ...suffix.templates],
    variables: [...prompt.variables, ...suffix.variables],
  };
}
