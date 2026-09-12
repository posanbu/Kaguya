/**
 * 功能概述：将 raw writeback 转为受控外部认知任务，维护证据快照而不实现演化算法。
 * 身份未解析或 ephemeral 范围只保留 raw Memory，不进入长期认知；
 * memoryCognitionModule 冻结同账号/聊天范围内最多 32 条已入库来源，worker 只从 Memory 重载，
 * 经版本化 provider 产生事实，再登记 core.memory.text 和唯一 terminal；未完成文本不进入 Prompt。
 * cognitionEvidenceSelector 重载直接来源；createCognitionMemorySelector 按 provider/revision/asOf
 * 选择最新完整快照并核对直接证据，返回可由 Core 再次加载的 Memory atom ID。
 * provider 超时/暂时错误交给 Reliable Runner，source/schema 失败关闭；后台链不触发在线回合。
 */
import {
  awaitWithSignal,
  cognitionIdentitySchema,
  memoryCognitionCapability,
  memoryDocumentReaderCapability,
  validateCognitionResult,
  freezeCognitionInput,
  type CognitionIdentity,
} from "@kaguya/memory";
import { z, type DeepReadonly, type InformationAtom } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationSelector,
} from "@kaguya/sdk";
import { onInformation } from "@kaguya/sdk";
import {
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  turnCandidateInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";
import { memoryWritebackCompletedInformationKind } from "../memory-writeback/index.js";
const commonReferences = {
  "core:caused-by": { required: true, multiple: false },
  "core:context": {
    required: true,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
  "agent:evidence": {
    required: true,
    multiple: true,
    targetKinds: [inboundTextInformationKind.kind],
  },
} as const;
export const memoryCognitionRequestedInformationKind = defineInformationKind({
  kind: "agent.memory.cognition.requested",
  displayName: "Memory cognition request",
  description:
    "Frozen bounded source window for an external cognition provider.",
  payloadSchema: z
    .object({
      identity: cognitionIdentitySchema,
      scopeKey: z.string().min(1),
      asOf: z.iso.datetime({ offset: true }),
      sourceInformationIds: z.array(z.string().min(1)).min(1).max(32),
    })
    .strict(),
  references: commonReferences,
  log: { enabled: false },
});
export const memoryCognitionCompletedInformationKind = defineInformationKind({
  kind: "agent.memory.cognition.completed",
  displayName: "Memory cognition terminal",
  description: "Completed, empty or superseded evidence-backed snapshot.",
  payloadSchema: z
    .object({
      identity: cognitionIdentitySchema,
      scopeKey: z.string().min(1),
      asOf: z.iso.datetime({ offset: true }),
      status: z.enum(["completed", "empty", "superseded", "invalid"]),
      memoryInformationId: z.string().min(1).nullable(),
    })
    .strict(),
  references: {
    ...commonReferences,
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [memoryCognitionRequestedInformationKind.kind],
    },
    "agent:memory": {
      required: false,
      multiple: false,
      targetKinds: [coreMemoryTextInformationKind.kind],
    },
  },
  log: { enabled: false },
});
export function cognitionScopeKey(source: {
  platform: string;
  adapterId: string;
  senderId: string;
  destination: unknown;
}): string {
  return JSON.stringify([
    source.platform,
    source.adapterId,
    source.senderId,
    source.destination,
  ]);
}
const windowSelector = defineInformationSelector({
  selectorId: "kaguya.memory.cognition.window",
  select: async ({ sourceAtom, ledger }) => {
    const writebacks = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:status-of",
      direction: "outgoing",
      limit: 1,
    });
    if (writebacks.length !== 1) return [];
    const identities = await ledger.related({
      from: [writebacks[0]!.informationId],
      relation: "core:caused-by",
      direction: "outgoing",
      limit: 1,
    });
    const identity = identities[0];
    if (
      identity?.kind !== personContextCompletedInformationKind.kind ||
      identity.payload.scopeMode !== "canonical" ||
      identity.payload.status !== "complete" ||
      !identity.payload.personInformationId
    )
      return [];
    const sources = await ledger.related({
      from: [writebacks[0]!.informationId],
      relation: "agent:source",
      direction: "outgoing",
      limit: 1,
    });
    const source = sources[0];
    if (!source || source.kind !== inboundTextInformationKind.kind) return [];
    const { source: address } = inboundTextInformationKind.payloadSchema.parse(
      source.payload,
    );
    const history = await ledger.find({
      kinds: [inboundTextInformationKind.kind],
      payloadContains: {
        source: {
          platform: address.platform,
          adapterId: address.adapterId,
          senderId: address.senderId,
          destination: address.destination,
        },
      },
      occurredBefore: source.occurredAt,
      order: "desc",
      limit: 32,
    });
    return [
      source,
      ...history.filter((atom) => atom.informationId !== source.informationId),
    ]
      .slice(0, 32)
      .sort(compareEvidence)
      .map((atom) => atom.informationId);
  },
});
export const cognitionEvidenceSelector = defineInformationSelector({
  selectorId: "kaguya.memory.cognition.evidence",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "agent:evidence",
        direction: "outgoing",
        limit: 32,
      })
    ).map((atom) => atom.informationId),
});
export const memoryCognitionModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.memory.cognition",
    displayName: "External Memory cognition",
    summary:
      "Produces evidence-backed snapshots through a replaceable provider.",
    description:
      "Freezes persisted raw sources, validates provider results and publishes a completed snapshot independently of online replies.",
    settingsSchema: z.object({}).strict(),
    consumes: [
      memoryWritebackCompletedInformationKind,
      memoryCognitionRequestedInformationKind,
    ],
    produces: [
      memoryCognitionRequestedInformationKind,
      memoryCognitionCompletedInformationKind,
      coreMemoryTextInformationKind,
    ],
    selectors: [windowSelector, cognitionEvidenceSelector],
    promptRenderers: [],
    requires: [memoryCognitionCapability, memoryDocumentReaderCapability],
    provides: [],
  },
  create: (_config, lifecycle) => {
    const provider = lifecycle.use(memoryCognitionCapability),
      reader = lifecycle.use(memoryDocumentReaderCapability);
    return {
      provisions: [],
      subscriptions: [
        onInformation(
          memoryWritebackCompletedInformationKind,
          {
            subscriptionId: "kaguya.memory.cognition.request.v1",
            delivery: "durable",
          },
          async (completed, context) => {
            const atoms = await context.select(windowSelector);
            if (!atoms.length) return;
            const documents = [];
            for (const atom of atoms) {
              const doc = await reader.getBySource(atom.informationId);
              if (doc) documents.push(doc);
            }
            if (!documents.length)
              throw new Error("Missing persisted cognition source");
            const last = documents.at(-1)!;
            const sourceInformationIds = documents.map(
              (doc) => doc.sourceInformationId,
            );
            await context.registerOnce(
              "kaguya.memory.cognition.request.v1",
              JSON.stringify([
                provider.identity.providerId,
                provider.identity.revision,
                completed.informationId,
              ]),
              memoryCognitionRequestedInformationKind,
              {
                payload: {
                  identity: provider.identity,
                  scopeKey: cognitionScopeKey({
                    ...last.address,
                    senderId: last.address.accountId,
                  }),
                  asOf: last.occurredAt,
                  sourceInformationIds,
                },
                references: sourceInformationIds.map((informationId) => ({
                  relation: "agent:evidence",
                  informationId,
                })),
              },
            );
          },
        ),
        onInformation(
          memoryCognitionRequestedInformationKind,
          {
            subscriptionId: "kaguya.memory.cognition.execute.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const payload =
              memoryCognitionRequestedInformationKind.payloadSchema.parse(
                request.payload,
              );
            const evidence = await context.select(cognitionEvidenceSelector);
            const evidenceIds = new Set(
              evidence.map((atom) => atom.informationId),
            );
            let status: "completed" | "empty" | "superseded" | "invalid" =
              "superseded";
            let memoryInformationId: string | null = null;
            if (
              payload.identity.providerId === provider.identity.providerId &&
              payload.identity.revision === provider.identity.revision
            ) {
              const documents = [];
              for (const id of payload.sourceInformationIds) {
                const doc = await reader.getBySource(id);
                if (!doc || !evidenceIds.has(id))
                  throw new Error("Missing cognition evidence");
                documents.push(doc);
              }
              const input = freezeCognitionInput({
                operationKey: request.informationId,
                documents,
                sourceInformationIds: payload.sourceInformationIds,
              });
              const signal = AbortSignal.any([
                context.signal,
                AbortSignal.timeout(30_000),
              ]);
              const result = await awaitWithSignal(
                provider.evolve(input, signal),
                signal,
              );
              try {
                const parsed = validateCognitionResult(result, input);
                status = parsed.facts.length ? "completed" : "empty";
                if (parsed.facts.length) {
                  const memory = await context.registerOnce(
                    "kaguya.memory.cognition.text.v1",
                    request.informationId,
                    coreMemoryTextInformationKind,
                    {
                      payload: {
                        text: parsed.facts
                          .map(
                            (fact) =>
                              `${fact.text}\n[evidence: ${fact.sourceInformationIds.join(", ")}]`,
                          )
                          .join("\n"),
                      },
                      references: payload.sourceInformationIds.map(
                        (informationId) => ({
                          relation: "core:uses-context",
                          informationId,
                        }),
                      ),
                    },
                  );
                  memoryInformationId = memory.informationId;
                }
              } catch (error) {
                if (
                  error instanceof z.ZodError ||
                  (error instanceof Error &&
                    [
                      "Invalid cognition evidence",
                      "Invalid cognition source order",
                      "Mixed cognition scope",
                    ].includes(error.message))
                )
                  status = "invalid";
                else throw error;
              }
            }
            await context.commitTerminal(
              "kaguya.memory.cognition.terminal.v1",
              request.informationId,
              memoryCognitionCompletedInformationKind,
              {
                payload: {
                  identity: payload.identity,
                  scopeKey: payload.scopeKey,
                  asOf: payload.asOf,
                  status,
                  memoryInformationId,
                },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: request.informationId,
                  },
                  ...payload.sourceInformationIds.map((informationId) => ({
                    relation: "agent:evidence",
                    informationId,
                  })),
                  ...(memoryInformationId
                    ? [
                        {
                          relation: "agent:memory",
                          informationId: memoryInformationId,
                        },
                      ]
                    : []),
                ],
              },
            );
          },
        ),
      ],
    };
  },
});
export function createCognitionMemorySelector(identity: CognitionIdentity) {
  return defineInformationSelector({
    selectorId: "kaguya.memory.cognition.completed-snapshot",
    select: async ({ sourceAtom, ledger }) => {
      let candidates = [sourceAtom];
      if (sourceAtom.kind === personContextCompletedInformationKind.kind) {
        const inbound = (
          await ledger.related({
            from: [sourceAtom.informationId],
            relation: "core:status-of",
            direction: "outgoing",
            limit: 1,
          })
        )[0];
        candidates = inbound
          ? [
              ...(await ledger.find({
                kinds: [turnCandidateInformationKind.kind],
                payloadContains: {
                  sourceInformationIds: [inbound.informationId],
                },
                limit: 1000,
              })),
            ]
          : [];
      }
      const selected = [];
      for (const candidate of candidates) {
        if (candidate.kind !== turnCandidateInformationKind.kind) continue;
        const inbounds = (
          await ledger.related({
            from: [candidate.informationId],
            relation: "core:uses-context",
            direction: "outgoing",
            limit: 1000,
          })
        ).filter((atom) => atom.kind === inboundTextInformationKind.kind);
        for (const inbound of inbounds) {
          const source = inboundTextInformationKind.payloadSchema.parse(
            inbound.payload,
          ).source;
          const snapshots = await ledger.find({
            kinds: [memoryCognitionCompletedInformationKind.kind],
            payloadContains: {
              identity: { ...identity },
              scopeKey: cognitionScopeKey(source),
            },
            occurredBefore: String(candidate.payload.asOf),
            order: "desc",
            limit: 100,
          });
          const valid = snapshots
            .map((atom) => ({
              atom,
              payload:
                memoryCognitionCompletedInformationKind.payloadSchema.parse(
                  atom.payload,
                ),
            }))
            .filter(
              ({ payload }) =>
                ["completed", "empty"].includes(payload.status) &&
                Date.parse(payload.asOf) <=
                  Date.parse(String(candidate.payload.asOf)),
            )
            .sort(
              (a, b) =>
                Date.parse(b.payload.asOf) - Date.parse(a.payload.asOf) ||
                (a.atom.informationId < b.atom.informationId ? -1 : 1),
            );
          const snapshot = valid[0];
          if (!snapshot?.payload.memoryInformationId) continue;
          const evidence = await ledger.related({
            from: [snapshot.atom.informationId],
            relation: "agent:evidence",
            direction: "outgoing",
            limit: 32,
          });
          if (
            !evidence.length ||
            evidence.some(
              (atom) =>
                atom.kind !== inboundTextInformationKind.kind ||
                cognitionScopeKey(
                  inboundTextInformationKind.payloadSchema.parse(atom.payload)
                    .source,
                ) !== cognitionScopeKey(source),
            )
          )
            continue;
          const memories = await ledger.related({
            from: [snapshot.atom.informationId],
            relation: "agent:memory",
            direction: "outgoing",
            limit: 1,
          });
          const memory = memories[0];
          const evidenceIds = new Set(
            evidence.map((atom) => atom.informationId),
          );
          const direct =
            memory?.references.filter(
              (ref) => ref.relation === "core:uses-context",
            ) ?? [];
          if (
            memory?.kind === coreMemoryTextInformationKind.kind &&
            memory.informationId === snapshot.payload.memoryInformationId &&
            direct.length === evidenceIds.size &&
            direct.every((ref) => evidenceIds.has(ref.informationId))
          )
            selected.push(memory.informationId);
        }
      }
      return [...new Set(selected)];
    },
  });
}
function compareEvidence(
  a: DeepReadonly<InformationAtom>,
  b: DeepReadonly<InformationAtom>,
): number {
  return (
    Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
    (a.informationId < b.informationId
      ? -1
      : a.informationId > b.informationId
        ? 1
        : 0)
  );
}
