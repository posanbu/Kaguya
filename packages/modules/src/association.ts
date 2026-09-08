/**
 * 功能概述：把回复触发的联想召回建模为可审计的 Information DAG，避免把未经授权的
 * 检索文本直接拼接进 Prompt。request、query、candidate 和 completed 分别记录输入、
 * 确定性查询、canonical source receipt 与唯一终态。
 * 主要职责：`associationModule` 串接四个 durable handler；`associationIdentitySelector`
 * 从当前回复的 runtime context 找到 identity terminal；`associationCandidateSelector`
 * 从 reply DAG 重载当前 inbound，并调用宿主注入的受控 Memory retrieval strategy；失败时按
 * unavailable/failed 终态 fail closed，不生成游离文本或触发新的 reply。
 * 代码库关系：消费 `replyRequestedInformationKind` 和 `agent.person.context.completed`，
 * 产生 `information-kinds.ts` 中的四类 association kind；Runtime 注入
 * `kaguya.memory.sparse`，LLM reply 模块消费 completed terminal 并再次由 Core
 * 重载原始 inbound。selector 只能访问 Engine 授权的账本读取端口。
 * 输入输出与副作用：输入为回复 source、identity terminal 和 scope；输出为带因果、context、
 * identity、request/candidate/source 引用的持久原子。重复投递使用 registerOnce/commitTerminal
 * 幂等；检索异常只记录脱敏 reason code，candidate payload 不复制 source 正文。
 */
import {
  type DeepReadonly,
  type InformationAtom,
  type InformationId,
  z,
} from "@kaguya/schema";
import { MEMORY_RETRIEVAL_STRATEGY_ID } from "@kaguya/memory";
import {
  defineInformationModule,
  defineModuleDiagnostic,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";

import {
  associationCandidateInformationKind,
  associationCompletedInformationKind,
  associationQueryInformationKind,
  associationQueryInformationPayloadSchema,
  associationRequestedInformationKind,
  associationRequestedInformationPayloadSchema,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  replyRequestedInformationPayloadSchema,
  turnContextCompletedInformationKind,
  type AssociationCompletedInformationPayload,
  type AssociationQueryInformationPayload,
  type AssociationRequestedInformationPayload,
} from "./information-kinds.js";

export const associationRetrievalStartedDiagnostic = defineModuleDiagnostic({
  event: "association.retrieval.started",
  message: "Association retrieval started",
  level: "info",
  payloadSchema: z
    .object({
      method: z.literal("sparse-2gram"),
      limit: z.number().int().positive(),
      queryLength: z.number().int().nonnegative(),
    })
    .strict(),
  project: (payload) => ({ ...payload }),
});

const identityTerminalPayloadSchema = z
  .object({
    status: z.enum([
      "complete",
      "unresolved",
      "ambiguous",
      "degraded",
      "failed",
      "unavailable",
    ]),
    personInformationId: z.string().trim().min(1).optional(),
    scopeInformationId: z.string().trim().min(1).optional(),
  })
  .passthrough();

export const associationIdentitySelector = defineInformationSelector({
  selectorId: "kaguya.association.identity-terminal",
  select: async ({ sourceAtom, ledger }) => {
    const context = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:context",
      direction: "outgoing",
      limit: 1,
    });
    const identity =
      context.length === 0
        ? []
        : await ledger.related({
            from: [context[0]!.informationId],
            relation: "core:context",
            direction: "incoming",
            limit: 100,
          });
    const terminals = identity.filter(
      ({ kind }) => kind === "agent.person.context.completed",
    );
    const turns = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:uses-context",
      direction: "outgoing",
      limit: 10,
    });
    const turn = turns.find(
      ({ kind }) => kind === turnContextCompletedInformationKind.kind,
    );
    return [
      ...(terminals.length === 1 ? [terminals[0]!.informationId] : []),
      ...(turn === undefined ? [] : [turn.informationId]),
    ];
  },
});

export const associationCandidateSelector = defineInformationSelector({
  selectorId: "kaguya.association.memory-candidates",
  select: async ({ sourceAtom, ledger }) => {
    const query = associationQueryInformationPayloadSchema.parse(
      sourceAtom.payload,
    );
    if (query.query === "<empty>") return [];
    const requests = (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 2,
      })
    ).filter(({ kind }) => kind === associationRequestedInformationKind.kind);
    if (
      requests.length !== 1 ||
      requests[0]!.informationId !== query.requestInformationId
    ) {
      throw new Error("Association query must reference one request");
    }
    const replies = (
      await ledger.related({
        from: [requests[0]!.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 2,
      })
    ).filter(({ kind }) => kind === replyRequestedInformationKind.kind);
    if (
      replies.length !== 1 ||
      replies[0]!.informationId !== query.sourceInformationId
    ) {
      throw new Error("Association request must reference one reply");
    }
    const turns = (
      await ledger.related({
        from: [replies[0]!.informationId],
        relation: "core:uses-context",
        direction: "outgoing",
        limit: 2,
      })
    ).filter(({ kind }) => kind === turnContextCompletedInformationKind.kind);
    if (turns.length !== 1) {
      throw new Error("Reply must reference one turn context");
    }
    const inbound = (
      await ledger.related({
        from: [turns[0]!.informationId],
        relation: "core:uses-context",
        direction: "outgoing",
        limit: 1_000,
      })
    ).filter(({ kind }) => kind === inboundTextInformationKind.kind);
    if (inbound.length === 0) {
      throw new Error("Turn context must reference inbound sources");
    }
    const input = {
      query: query.query,
      occurredBefore: query.asOf,
      excludeSourceInformationIds: inbound.map(
        ({ informationId }) => informationId,
      ),
    };
    const memories = await ledger.retrieve({
      strategyId: MEMORY_RETRIEVAL_STRATEGY_ID,
      input,
      limit: query.limit,
    });
    return memories
      .filter(({ kind }) => kind === inboundTextInformationKind.kind)
      .map(({ informationId }) => informationId);
  },
});

export const associationModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "core.association.memory",
    displayName: "Memory association",
    settingsSchema: z.object({}).strict(),
    consumes: [
      replyRequestedInformationKind,
      associationRequestedInformationKind,
      associationQueryInformationKind,
    ],
    produces: [
      associationRequestedInformationKind,
      associationQueryInformationKind,
      associationCandidateInformationKind,
      associationCompletedInformationKind,
    ],
    selectors: [associationIdentitySelector, associationCandidateSelector],
    promptRenderers: [],
    requires: [],
    provides: [],
    diagnostics: [associationRetrievalStartedDiagnostic],
  },
  create: () => ({
    provisions: [],
    describeStartup: () => ({
      summary: "Memory association ready",
      fields: { method: "sparse-2gram", candidateLimit: 8 },
    }),
    subscriptions: [
      onInformation(
        replyRequestedInformationKind,
        { subscriptionId: "kaguya.association.request", delivery: "durable" },
        async (reply, context) => {
          const payload = replyRequestedInformationPayloadSchema.parse(
            reply.payload,
          );
          const identityAtoms = await context.select(
            associationIdentitySelector,
          );
          const identityAtom = identityAtoms.find(
            ({ kind }) => kind === "agent.person.context.completed",
          );
          const turnContext = identityAtoms.find(
            ({ kind }) => kind === turnContextCompletedInformationKind.kind,
          );
          const identity =
            identityAtom === undefined
              ? { status: "unavailable" as const }
              : identityTerminalPayloadSchema.parse(identityAtom.payload);
          await context.registerOnce(
            "kaguya.association.requested.v1",
            reply.informationId,
            associationRequestedInformationKind,
            {
              payload: {
                sourceInformationId: reply.informationId,
                queryText: payload.text,
                asOf:
                  turnContext === undefined
                    ? reply.occurredAt
                    : (turnContext.payload as any).asOf,
                route: "reply",
                method: "sparse-2gram",
                identity: {
                  status: identity.status,
                  ...(identity.personInformationId === undefined
                    ? {}
                    : { personInformationId: identity.personInformationId }),
                  ...(identity.scopeInformationId === undefined
                    ? {}
                    : { scopeInformationId: identity.scopeInformationId }),
                },
                scope: {
                  platform: payload.source.platform,
                  adapterId: payload.source.adapterId,
                  destination: payload.source.destination,
                },
              },
              references:
                identityAtom === undefined
                  ? []
                  : [
                      {
                        relation: "agent:identity-terminal" as const,
                        informationId: identityAtom.informationId,
                      },
                    ],
            },
          );
        },
      ),
      onInformation(
        associationRequestedInformationKind,
        { subscriptionId: "kaguya.association.query", delivery: "durable" },
        async (request, context) => {
          const payload = associationRequestedInformationPayloadSchema.parse(
            request.payload,
          );
          await context.registerOnce(
            "kaguya.association.query.v1",
            request.informationId,
            associationQueryInformationKind,
            {
              payload: {
                requestInformationId: request.informationId,
                sourceInformationId: payload.sourceInformationId,
                queryText: payload.queryText,
                query: deterministicQuery(payload.queryText),
                asOf: payload.asOf,
                route: payload.route,
                method: payload.method,
                identity: payload.identity,
                scope: payload.scope,
                limit: 8,
              },
            },
          );
        },
      ),
      onInformation(
        associationQueryInformationKind,
        { subscriptionId: "kaguya.association.retrieve", delivery: "durable" },
        async (query, context) => {
          const payload = associationQueryInformationPayloadSchema.parse(
            query.payload,
          );
          let memories: readonly DeepReadonly<InformationAtom>[] = [];
          let status: AssociationCompletedInformationPayload["status"] =
            "empty";
          let reasonCodes = ["no-candidate"];
          if (payload.query === "<empty>") {
            status = "policy-filtered";
            reasonCodes = ["empty-query-policy"];
          } else {
            await context.report(associationRetrievalStartedDiagnostic, {
              method: payload.method,
              limit: payload.limit,
              queryLength: Array.from(payload.query).length,
            });
            try {
              memories = await context.select(associationCandidateSelector);
              status = memories.length === 0 ? "empty" : "matched";
              reasonCodes =
                memories.length === 0
                  ? ["no-sparse-match"]
                  : ["sparse-match", "coverage-ranked"];
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              status = message.includes(
                "Unknown information retrieval strategy",
              )
                ? "unavailable"
                : "failed";
              reasonCodes = [
                status === "unavailable"
                  ? "provider-unavailable"
                  : "retrieval-failed",
              ];
            }
          }

          const candidateInformationIds: InformationId[] = [];
          for (const [rank, memory] of memories.entries()) {
            const candidate = await context.registerOnce(
              "kaguya.association.candidate.v1",
              `${query.informationId}:${memory.informationId}`,
              associationCandidateInformationKind,
              {
                payload: {
                  rank,
                  route: "memory" as const,
                  strategy: "sparse-2gram" as const,
                  reasonCodes: ["sparse-match", "coverage-ranked"],
                },
                references: [
                  {
                    relation: "agent:request",
                    informationId: findRequestId(query, payload),
                  },
                  {
                    relation: "agent:canonical-source",
                    informationId: memory.informationId,
                  },
                ],
              },
            );
            candidateInformationIds.push(candidate.informationId);
          }

          await context.commitTerminal(
            "kaguya.association.terminal.v1",
            payload.requestInformationId,
            associationCompletedInformationKind,
            {
              payload: {
                requestInformationId: payload.requestInformationId,
                queryInformationId: query.informationId,
                sourceInformationId: payload.sourceInformationId,
                route: payload.route,
                method: payload.method,
                status,
                candidateCount: candidateInformationIds.length,
                reasonCodes,
              },
              references: [
                {
                  relation: "agent:request",
                  informationId: findRequestId(query, payload),
                },
                ...candidateInformationIds.map((informationId) => ({
                  relation: "agent:candidate" as const,
                  informationId,
                })),
              ],
            },
          );
        },
      ),
    ],
  }),
});

function deterministicQuery(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? "<empty>" : normalized;
}

function findRequestId(
  query: DeepReadonly<InformationAtom>,
  payload: AssociationQueryInformationPayload,
): InformationId {
  const request = query.references.find(
    ({ relation }) => relation === "core:caused-by",
  );
  if (
    request === undefined ||
    request.informationId !== payload.requestInformationId
  ) {
    throw new Error("Association query must directly reference its request");
  }
  return request.informationId;
}
