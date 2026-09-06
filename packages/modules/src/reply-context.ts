/**
 * 功能概述：声明 reply 模块的显式上下文选择，并把已选择账本原子编译为 Prompt。
 * 主要职责：`currentAcceptedMessageSelector` 保留仅选择当前消息的基础策略；
 * `associationReplyContextSelector` 从 association terminal 沿受控引用找到当前 reply 和
 * canonical Memory source；replyPromptRenderer 与 memoryPromptRenderer 提供可声明的渲染身份，
 * 原子到 Prompt 保留选择顺序和 provenance，不渲染 candidate receipt。
 * 代码库关系：`llm-reply.ts` 使用这里的 Selector；Engine 负责校验并重新加载结果，
 * PromptCompiler 负责产生可持久化 provenance。
 * 输入输出与副作用：默认选择是纯函数且不调用 reader；不保存会话键或跨请求状态。
 */
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
  InformationId,
  PromptFragment,
  PromptFragmentSource,
} from "@kaguya/schema";
import {
  defineInformationSelector,
  type InformationSelectorContext,
  type InformationPromptRendererDefinition,
} from "@kaguya/sdk";
import { PromptCompiler } from "@kaguya/prompt";

import {
  coreMemoryTextInformationKind,
  associationCandidateInformationKind,
  associationCompletedInformationKind,
  associationQueryInformationKind,
  associationRequestedInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
} from "./information-kinds.js";

export const currentAcceptedMessageSelector = defineInformationSelector({
  selectorId: "core.reply.current-accepted-message",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});

export const associationReplyContextSelector = defineInformationSelector({
  selectorId: "kaguya.reply.association-context",
  select: async ({ sourceAtom, ledger }) => {
    const completed = associationCompletedInformationKind.payloadSchema.parse(
      sourceAtom.payload,
    );
    const request = await related(
      ledger,
      sourceAtom.informationId,
      "agent:request",
      "outgoing",
      associationRequestedInformationKind.kind,
    );
    const query = await related(
      ledger,
      sourceAtom.informationId,
      "core:caused-by",
      "outgoing",
      associationQueryInformationKind.kind,
    );
    if (
      request.length !== 1 ||
      query.length !== 1 ||
      request[0]!.informationId !== completed.requestInformationId ||
      query[0]!.informationId !== completed.queryInformationId
    ) {
      throw new Error("Association terminal references are inconsistent");
    }
    const replies = await related(
      ledger,
      request[0]!.informationId,
      "core:caused-by",
      "outgoing",
      replyRequestedInformationKind.kind,
    );
    if (
      replies.length !== 1 ||
      replies[0]!.informationId !== completed.sourceInformationId
    ) {
      throw new Error("Association terminal source reply is inconsistent");
    }
    if (completed.status !== "matched") {
      return [replies[0]!.informationId];
    }

    const candidates = (await ledger.related({
      from: [query[0]!.informationId],
      relation: "core:caused-by",
      direction: "incoming",
      limit: 100,
    }))
      .filter(({ kind }) => kind === associationCandidateInformationKind.kind)
      .sort((left, right) => candidateRank(left) - candidateRank(right));
    const memories: InformationId[] = [];
    for (const candidate of candidates) {
      const sources = await ledger.related({
        from: [candidate.informationId],
        relation: "agent:canonical-source",
        direction: "outgoing",
        limit: 1,
      });
      if (
        sources.length !== 1 ||
        sources[0]!.kind !== coreMemoryTextInformationKind.kind
      ) {
        throw new Error("Association candidate must reference one Memory source");
      }
      memories.push(sources[0]!.informationId);
    }
    return [...memories, replies[0]!.informationId];
  },
});

export const replyPromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.reply.text",
    kinds: [replyRequestedInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) =>
      replyRequestedInformationPayloadSchema.parse(atom.payload).text,
  });
export const memoryPromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.memory.text",
    kinds: [coreMemoryTextInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) =>
      coreMemoryTextInformationKind.payloadSchema.parse(atom.payload).text,
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
      return fragment(
        atom.informationId,
        "history",
        replyPromptRenderer.render(atom),
      );
    }
    if (atom.kind === coreMemoryTextInformationKind.kind) {
      return fragment(
        atom.informationId,
        "memory",
        memoryPromptRenderer.render(atom),
      );
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

async function related(
  context: InformationSelectorContext["ledger"],
  from: InformationId,
  relation: string,
  direction: "outgoing" | "incoming",
  kind: string,
): Promise<readonly DeepReadonly<InformationAtom>[]> {
  return (await context.related({
    from: [from],
    relation,
    direction,
    limit: 10,
  })).filter((atom) => atom.kind === kind);
}

function candidateRank(atom: DeepReadonly<InformationAtom>): number {
  const payload = associationCandidateInformationKind.payloadSchema.parse(
    atom.payload,
  );
  return payload.rank;
}
