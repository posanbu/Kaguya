/**
 * 功能概述：声明 reply 模块的显式上下文选择，并把已选择账本原子编译为 Prompt。
 * 主要职责：`turnReplyContextSelector` 从 reply 沿受控引用找到冻结 turn 与它列出的 Memory；
 * `associationReplyContextSelector` 保留可选的 association 审计读取策略；replyPromptRenderer 与 memoryPromptRenderer 提供可声明的渲染身份，
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
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
} from "./information-kinds.js";

export const currentAcceptedMessageSelector = defineInformationSelector({
  selectorId: "core.reply.current-accepted-message",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});

export const turnReplyContextSelector = defineInformationSelector({
  selectorId: "agent.reply.frozen-turn-context",
  select: async ({ sourceAtom, ledger }) => {
    const turns = (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:uses-context",
        direction: "outgoing",
        limit: 10,
      })
    ).filter(({ kind }) => kind === "agent.turn.context.completed");
    if (turns.length !== 1) return [sourceAtom.informationId];
    const payload = turns[0]!.payload as any;
    const memoryIds = new Set<string>(
      Array.isArray(payload.memory) ? payload.memory : [],
    );
    if (memoryIds.size === 0) return [sourceAtom.informationId];
    const context = await ledger.related({
      from: [turns[0]!.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 1_000,
    });
    return [
      ...context
        .filter(({ informationId }) => memoryIds.has(informationId))
        .map(({ informationId }) => informationId),
      sourceAtom.informationId,
    ];
  },
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

    const candidates = (
      await ledger.related({
        from: [query[0]!.informationId],
        relation: "core:caused-by",
        direction: "incoming",
        limit: 100,
      })
    )
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
        (sources[0]!.kind !== coreMemoryTextInformationKind.kind &&
          sources[0]!.kind !== inboundTextInformationKind.kind)
      ) {
        throw new Error(
          "Association candidate must reference one Memory source",
        );
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

export const inboundMemoryPromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.memory.inbound-text",
    kinds: [inboundTextInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) => {
      const payload = replyRequestedInformationPayloadSchema.parse(
        atom.payload,
      );
      const destination = payload.source.destination;
      const scope =
        destination.kind === "group"
          ? `group:${destination.groupId}`
          : destination.kind === "private"
            ? `private:${destination.userId}`
            : "web";
      return `[${atom.occurredAt}] [${payload.source.platform}/${payload.source.adapterId}] [${scope}] [account:${payload.source.senderId}]\n${payload.text}`;
    },
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
  let remainingMemoryCharacters = 4_000;
  const fragments = atoms.flatMap((atom): PromptFragment[] => {
    if (atom.kind === replyRequestedInformationKind.kind) {
      return [
        fragment(
          atom.informationId,
          "history",
          replyPromptRenderer.render(atom),
          20,
        ),
      ];
    }
    if (
      atom.kind === coreMemoryTextInformationKind.kind ||
      atom.kind === inboundTextInformationKind.kind
    ) {
      if (remainingMemoryCharacters === 0) return [];
      const rendered =
        atom.kind === coreMemoryTextInformationKind.kind
          ? memoryPromptRenderer.render(atom)
          : inboundMemoryPromptRenderer.render(atom);
      const content = takeCodePoints(rendered, remainingMemoryCharacters);
      remainingMemoryCharacters -= Array.from(content).length;
      return [fragment(atom.informationId, "memory", content, 10)];
    }
    throw new Error(`Unsupported reply context information kind: ${atom.kind}`);
  });
  return compiler.compile("reply", fragments);
}

function fragment(
  informationId: InformationId,
  source: PromptFragmentSource,
  content: string,
  priority: number,
): PromptFragment {
  return {
    id: informationId,
    informationId,
    source,
    priority,
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
  return (
    await context.related({
      from: [from],
      relation,
      direction,
      limit: 10,
    })
  ).filter((atom) => atom.kind === kind);
}

function candidateRank(atom: DeepReadonly<InformationAtom>): number {
  const payload = associationCandidateInformationKind.payloadSchema.parse(
    atom.payload,
  );
  return payload.rank;
}

function takeCodePoints(value: string, maximum: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximum) return value;
  if (maximum <= 1) return codePoints.slice(0, maximum).join("");
  return `${codePoints.slice(0, maximum - 1).join("")}…`;
}
