/**
 * 功能概述：声明 reply 模块的显式上下文选择，并把已选择账本原子编译为 Prompt。
 * 主要职责：`turnReplyContextSelector` 从 reply 沿受控引用找到冻结 turn 与它列出的 Memory；
 * `associationReplyContextSelector` 保留可选的 association 审计读取策略；渲染器提供 manifest 身份，
 * Prompt 组装器区分同会话历史、已投递 assistant、Memory、引用与目标消息并保留 provenance。
 * 代码库关系：`llm-reply.ts` 使用这里的 Selector；Engine 负责校验并重新加载结果，
 * 模块模板负责产生可持久化的 variable provenance。
 * 输入输出与副作用：选择器只读账本，不保存会话键或跨请求状态；编译本身是纯函数。
 */
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
  InformationId,
} from "@kaguya/schema";
import {
  defineInformationSelector,
  type InformationSelectorContext,
  type InformationPromptRendererDefinition,
} from "@kaguya/sdk";

import {
  coreMemoryTextInformationKind,
  assistantTextInformationKind,
  associationCandidateInformationKind,
  associationCompletedInformationKind,
  associationQueryInformationKind,
  associationRequestedInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
} from "../information-kinds.js";
import {
  compileReplyPrompt,
  fitHistoryBudget,
  fitMemoryBudget,
  renderHistoryAtom,
  type AgentIdentity,
  type ReplyPromptTemplates,
} from "./reply-prompt.js";

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
    const turn = turns[0]!;
    const payload = turn.payload as any;
    const memoryIds = new Set<string>(
      Array.isArray(payload.memory) ? payload.memory : [],
    );
    const context = await ledger.related({
      from: [turn.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 1_000,
    });
    const contextById = new Map(
      context.map((atom) => [atom.informationId, atom] as const),
    );
    const inputIds = Array.isArray(payload.inputs)
      ? payload.inputs.map((input: any) => input.informationId as string)
      : [];
    const targetInputId = inputIds.at(-1);
    const immediate = inputIds
      .slice(0, -1)
      .map((id: string) => contextById.get(id))
      .filter(
        (
          atom: DeepReadonly<InformationAtom> | undefined,
        ): atom is DeepReadonly<InformationAtom> =>
          atom?.kind === inboundTextInformationKind.kind,
      );
    const replyPayload = replyRequestedInformationPayloadSchema.parse(
      sourceAtom.payload,
    );
    const recent = await ledger.find({
      kinds: [
        inboundTextInformationKind.kind,
        assistantTextInformationKind.kind,
      ],
      occurredBefore: sourceAtom.occurredAt,
      payloadContains: {
        source: {
          platform: replyPayload.source.platform,
          adapterId: replyPayload.source.adapterId,
          destination: replyPayload.source.destination,
        },
      },
      order: "desc",
      limit: 120,
    });
    const visibleRecent = (
      await Promise.all(
        recent.map(async (atom) =>
          atom.kind !== assistantTextInformationKind.kind ||
          (await assistantWasDelivered(atom, ledger))
            ? atom
            : undefined,
        ),
      )
    ).filter(
      (atom): atom is DeepReadonly<InformationAtom> => atom !== undefined,
    );
    const quotedId = replyPayload.source.replyTo?.platformMessageId;
    let quoted =
      quotedId === undefined
        ? undefined
        : visibleRecent.find(
            (atom) => platformMessageIdentifier(atom) === quotedId,
          );
    if (quotedId !== undefined && quoted === undefined) {
      const candidates = await ledger.find({
        kinds: [
          inboundTextInformationKind.kind,
          assistantTextInformationKind.kind,
        ],
        payloadContains: {
          source: {
            platform: replyPayload.source.platform,
            adapterId: replyPayload.source.adapterId,
            destination: replyPayload.source.destination,
            platformMessageId: quotedId,
          },
        },
        order: "desc",
        limit: 10,
      });
      const candidate = candidates.find(
        (atom) => platformMessageIdentifier(atom) === quotedId,
      );
      if (
        candidate !== undefined &&
        (candidate.kind !== assistantTextInformationKind.kind ||
          (await assistantWasDelivered(candidate, ledger)))
      )
        quoted = candidate;
    }
    const history = fitHistoryBudget(
      uniqueAtoms([...visibleRecent, ...immediate]).filter(
        ({ informationId }) =>
          informationId !== targetInputId &&
          informationId !== quoted?.informationId &&
          !memoryIds.has(informationId),
      ),
    );
    const memories = fitMemoryBudget(
      context.filter(({ informationId }) => memoryIds.has(informationId)),
    );
    return [
      ...history.map(({ informationId }) => informationId),
      ...memories.map(({ informationId }) => informationId),
      ...(quoted === undefined ? [] : [quoted.informationId]),
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
    displayName: "Reply text",
    description: "Renders the current reply request as prompt context.",
    kinds: [replyRequestedInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) =>
      replyRequestedInformationPayloadSchema.parse(atom.payload).text,
  });
export const memoryPromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.memory.text",
    displayName: "Memory text",
    description: "Renders selected memory text as Prompt context.",
    kinds: [coreMemoryTextInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) =>
      coreMemoryTextInformationKind.payloadSchema.parse(atom.payload).text,
  });

export const inboundMemoryPromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.memory.inbound-text",
    displayName: "Historical inbound text",
    description:
      "Renders a selected historical inbound message as prompt context.",
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

export const assistantHistoryPromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.history.assistant-text",
    displayName: "Historical assistant text",
    description: "Renders a successfully delivered assistant message.",
    kinds: [assistantTextInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) =>
      renderHistoryAtom(atom, {
        name: "Assistant",
        aliases: [],
        persona: "Prompt renderer preview",
      }),
  });

export function compileReplyPromptFromInformation(
  templates: ReplyPromptTemplates,
  identity: AgentIdentity,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  return compileReplyPrompt(templates, identity, atoms, sourceInformationId);
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

function uniqueAtoms(
  atoms: readonly DeepReadonly<InformationAtom>[],
): readonly DeepReadonly<InformationAtom>[] {
  return [...new Map(atoms.map((atom) => [atom.informationId, atom])).values()];
}

async function assistantWasDelivered(
  atom: DeepReadonly<InformationAtom>,
  ledger: InformationSelectorContext["ledger"],
): Promise<boolean> {
  const requests = (
    await ledger.related({
      from: [atom.informationId],
      relation: "core:caused-by",
      direction: "incoming",
      limit: 20,
    })
  ).filter(({ kind }) => kind === "core.delivery.requested");
  if (requests.length === 0) return false;
  const terminals = await ledger.related({
    from: requests.map(({ informationId }) => informationId),
    relation: "core:status-of",
    direction: "incoming",
    limit: 20,
  });
  return terminals.some(({ kind }) => kind === "core.delivery.delivered");
}

function platformMessageIdentifier(
  atom: DeepReadonly<InformationAtom>,
): string | undefined {
  return (atom.payload as { source?: { platformMessageId?: string } }).source
    ?.platformMessageId;
}
