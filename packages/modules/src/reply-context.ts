/**
 * 功能概述：声明 reply 模块的默认显式上下文选择，并把已选择账本原子编译为 Prompt。
 * 主要职责：默认 Selector 只返回当前已接受消息的 informationId，不读取 payload、不查询
 * 历史；原子到 Prompt 仅显式渲染 reply 与 Memory kind，并保留选择顺序和 provenance。
 * 代码库关系：`llm-reply.ts` 使用这里的 Selector；Engine 负责校验并重新加载结果，
 * PromptCompiler 负责产生可持久化 provenance。
 * 输入输出与副作用：默认选择是纯函数且不调用 reader；不保存 Session、contextKey 或
 * 跨请求状态。
 */
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
  InformationId,
  PromptFragment,
  PromptFragmentSource,
} from "@kaguya/schema";
import { defineInformationSelector } from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";

import {
  coreMemoryTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
} from "./information-kinds.js";

export const currentAcceptedMessageSelector = defineInformationSelector({
  selectorId: "core.reply.current-accepted-message",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});

export function compileReplyPromptFromInformation(
  compiler: PromptCompiler,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  if (
    !atoms.some(({ informationId }) => informationId === sourceInformationId)
  ) {
    throw new Error("Reply selection must include the current input");
  }
  const fragments = atoms.map((atom): PromptFragment => {
    if (atom.kind === replyRequestedInformationKind.kind) {
      const payload = replyRequestedInformationPayloadSchema.parse(
        atom.payload,
      );
      return fragment(atom.informationId, "history", payload.text);
    }
    if (atom.kind === coreMemoryTextInformationKind.kind) {
      const payload = coreMemoryTextInformationKind.payloadSchema.parse(
        atom.payload,
      );
      return fragment(atom.informationId, "memory", payload.text);
    }
    throw new Error(`Unsupported reply context information kind: ${atom.kind}`);
  });
  return compiler.compile("reply", fragments);
}

function fragment(
  informationId: InformationId,
  source: PromptFragmentSource,
  content: string,
): PromptFragment {
  return {
    id: informationId,
    informationId,
    source,
    priority: 20,
    content,
    metadata: {},
  };
}
