/**
 * 功能概述：消息编写模块的受控账本选择器及 Prompt 预览入口，不参与 Heartflow 的发言决策。
 * 主要职责：turnMessageContextSelector 核对 intent→turn 引用并保留全部冻结输入；仅辅助历史受预算限制，
 * 已投递 assistant 才可进入历史，每条输入通过同目标成功回执链或入站 ID 查询引用上下文。associationMessageContextSelector 校验关联终态因果。
 * 代码库关系：index.ts 声明选择器与渲染器，message-prompt 使用冻结快照编译；Engine 按返回 ID 重载事实。
 * 输入输出与副作用：只读 ledger、返回去重 ID；缺少 turn、输入或记忆授权时抛错，不回退到复制的末条正文。
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
  messageIntentRequestedInformationKind,
  messageIntentRequestedInformationPayloadSchema,
} from "../information-kinds.js";
import {
  compileMessagePrompt,
  fitHistoryBudget,
  frozenTurnInputs,
  renderHistoryAtom,
  type AgentIdentity,
  type MessagePromptTemplates,
} from "./message-prompt.js";

import {
  beforeQuoteCutoff,
  resolveMessageQuote,
  sameMessageTarget,
} from "./message-quote.js";

export const currentAcceptedMessageSelector = defineInformationSelector({
  selectorId: "agent.message.current-intent",
  select: ({ sourceAtom }) => [sourceAtom.informationId],
});

export const turnMessageContextSelector = defineInformationSelector({
  selectorId: "agent.message.frozen-turn-context",
  select: async ({ sourceAtom, ledger }) => {
    const intent = messageIntentRequestedInformationPayloadSchema.parse(
      sourceAtom.payload,
    );
    const turns = (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:uses-context",
        direction: "outgoing",
        limit: 1000,
      })
    ).filter((atom) => atom.kind === "agent.turn.context.completed");
    if (
      turns.length !== 1 ||
      turns[0]!.informationId !== intent.turn.contextInformationId
    )
      throw new Error("Message intent must reference its frozen turn context");
    const turn = turns[0]!;
    const inputs = frozenTurnInputs([turn], intent);
    const context = await ledger.related({
      from: [turn.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 1000,
    });
    const byId = new Map(context.map((atom) => [atom.informationId, atom]));
    for (const input of inputs) {
      if (
        byId.get(input.informationId)?.kind !== inboundTextInformationKind.kind
      )
        throw new Error(
          `Missing frozen turn input reference: ${input.informationId}`,
        );
    }
    // 意图列出的记忆必须由冻结上下文授权，不从当前会话临时推测。
    for (const id of intent.memoryInformationIds) {
      if (!byId.has(id))
        throw new Error(`Missing frozen memory reference: ${id}`);
    }
    const inputIds = new Set(inputs.map((atom) => atom.informationId));
    const memoryIds = new Set(intent.memoryInformationIds);
    const recent = await ledger.find({
      kinds: [
        inboundTextInformationKind.kind,
        assistantTextInformationKind.kind,
      ],
      occurredBefore: String(turn.payload.asOf),
      payloadContains: { source: intent.target },
      order: "desc",
      limit: 120,
    });
    const visible = (
      await Promise.all(
        recent.map(async (atom) =>
          atom.kind !== assistantTextInformationKind.kind ||
          (await assistantWasDelivered(atom, ledger, String(turn.payload.asOf)))
            ? atom
            : undefined,
        ),
      )
    ).filter(
      (atom): atom is DeepReadonly<InformationAtom> => atom !== undefined,
    );
    const quotes: DeepReadonly<InformationAtom>[] = [];
    for (const input of inputs) {
      const quoteId = inboundTextInformationKind.payloadSchema.parse(
        input.payload,
      ).source.replyTo?.platformMessageId;
      if (quoteId === undefined) continue;
      const [inbound, receipts] = await Promise.all([
        ledger.find({
          kinds: [inboundTextInformationKind.kind],
          occurredBefore: new Date(
            Date.parse(String(turn.payload.asOf)) + 1,
          ).toISOString(),
          payloadContains: {
            source: { ...intent.target, platformMessageId: quoteId },
          },
          order: "desc",
          limit: 2,
        }),
        ledger.find({
          kinds: ["core.delivery.delivered"],
          occurredBefore: new Date(
            Date.parse(String(turn.payload.asOf)) + 1,
          ).toISOString(),
          payloadContains: {
            platform: intent.target.platform,
            adapterId: intent.target.adapterId,
            target: intent.target.destination,
            ok: true,
            platformMessageId: quoteId,
          },
          order: "desc",
          limit: 2,
        }),
      ]);
      // 保留有界冲突证据，避免 compiler 仅看到历史预算留下的一条候选而重新猜测。
      const conflictEvidence = [
        ...new Map(
          [...inputs, ...inbound, ...receipts]
            .filter(
              (atom) =>
                beforeQuoteCutoff(atom, String(turn.payload.asOf)) &&
                (atom.kind === inboundTextInformationKind.kind
                  ? sameMessageTarget(atom.payload.source, intent.target) &&
                    inboundTextInformationKind.payloadSchema.safeParse(
                      atom.payload,
                    ).data?.source.platformMessageId === quoteId
                  : atom.kind === "core.delivery.delivered" &&
                    atom.payload.ok === true &&
                    atom.payload.platformMessageId === quoteId &&
                    sameMessageTarget(
                      { ...atom.payload, destination: atom.payload.target },
                      intent.target,
                    )),
            )
            .map((atom) => [atom.informationId, atom]),
        ).values(),
      ];
      if (conflictEvidence.length > 1) {
        quotes.push(...conflictEvidence);
        continue;
      }
      if (inbound.length >= 2 || receipts.length >= 2) continue;
      const candidates = [...inputs, ...inbound, ...receipts];
      for (const receipt of receipts) {
        if (
          receipt.kind !== "core.delivery.delivered" ||
          receipt.payload.ok !== true ||
          !sameMessageTarget(
            { ...receipt.payload, destination: receipt.payload.target },
            intent.target,
          ) ||
          !beforeQuoteCutoff(receipt, String(turn.payload.asOf))
        )
          continue;
        const requests = await ledger.related({
          from: [receipt.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 2,
        });
        if (requests.length !== 1) continue;
        const request = requests[0]!;
        candidates.push(request);
        if (
          request.kind !== "core.delivery.requested" ||
          !sameMessageTarget(request.payload, intent.target) ||
          !beforeQuoteCutoff(request, String(turn.payload.asOf))
        )
          continue;
        const assistants = await ledger.related({
          from: [request.informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 2,
        });
        if (assistants.length === 1) candidates.push(assistants[0]!);
      }
      const quote = resolveMessageQuote(
        candidates,
        quoteId,
        intent.target,
        String(turn.payload.asOf),
      );
      if (quote) quotes.push(...quote.provenance);
    }
    const history = fitHistoryBudget(
      visible.filter(
        (atom) =>
          !inputIds.has(atom.informationId) &&
          !memoryIds.has(atom.informationId),
      ),
    );
    return [
      ...new Set([
        sourceAtom.informationId,
        turn.informationId,
        ...inputs.map((atom) => atom.informationId),
        ...intent.memoryInformationIds,
        ...history.map((atom) => atom.informationId),
        ...quotes.map((atom) => atom.informationId),
      ]),
    ];
  },
});

export const associationMessageContextSelector = defineInformationSelector({
  selectorId: "kaguya.message.association-context",
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
    const intents = await related(
      ledger,
      request[0]!.informationId,
      "core:caused-by",
      "outgoing",
      messageIntentRequestedInformationKind.kind,
    );
    if (
      intents.length !== 1 ||
      intents[0]!.informationId !== completed.sourceInformationId
    ) {
      throw new Error(
        "Association terminal source message intent is inconsistent",
      );
    }
    if (completed.status !== "matched") {
      return turnMessageContextSelector.select({
        sourceAtom: intents[0]!,
        ledger,
      });
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
    return [
      ...new Set([
        ...memories,
        ...(await turnMessageContextSelector.select({
          sourceAtom: intents[0]!,
          ledger,
        })),
      ]),
    ];
  },
});

export const messagePromptRenderer: InformationPromptRendererDefinition =
  Object.freeze({
    rendererId: "kaguya.message.text",
    displayName: "Message intent",
    description:
      "Renders the current message intent metadata as prompt context.",
    kinds: [messageIntentRequestedInformationKind],
    render: (atom: DeepReadonly<InformationAtom>) =>
      JSON.stringify(
        messageIntentRequestedInformationPayloadSchema.parse(atom.payload),
      ),
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
      const payload = inboundTextInformationKind.payloadSchema.parse(
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

export function compileMessagePromptFromInformation(
  templates: MessagePromptTemplates,
  identity: AgentIdentity,
  atoms: readonly DeepReadonly<InformationAtom>[],
  sourceInformationId: InformationId,
): CompiledPrompt {
  return compileMessagePrompt(templates, identity, atoms, sourceInformationId);
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

async function assistantWasDelivered(
  atom: DeepReadonly<InformationAtom>,
  ledger: InformationSelectorContext["ledger"],
  asOf: string,
): Promise<boolean> {
  const requests = (
    await ledger.related({
      from: [atom.informationId],
      relation: "core:caused-by",
      direction: "incoming",
      limit: 20,
    })
  ).filter(
    (request) =>
      request.kind === "core.delivery.requested" &&
      beforeQuoteCutoff(request, asOf) &&
      sameMessageTarget(
        request.payload,
        assistantTextInformationKind.payloadSchema.parse(atom.payload).source,
      ),
  );
  if (requests.length === 0) return false;
  const terminals = await ledger.related({
    from: requests.map(({ informationId }) => informationId),
    relation: "core:status-of",
    direction: "incoming",
    limit: 20,
  });
  return terminals.some(
    (receipt) =>
      receipt.kind === "core.delivery.delivered" &&
      receipt.payload.ok === true &&
      beforeQuoteCutoff(receipt, asOf) &&
      sameMessageTarget(
        { ...receipt.payload, destination: receipt.payload.target },
        assistantTextInformationKind.payloadSchema.parse(atom.payload).source,
      ),
  );
}
