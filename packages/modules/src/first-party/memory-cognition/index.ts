/**
 * 功能概述：将 raw writeback 转为受控外部认知任务，维护证据快照而不实现演化算法。
 * 身份未解析或 ephemeral 范围只保留 raw Memory，不触发长期认知；
 * memoryCognitionModule 冻结同聊天范围内最多 32 条已入库来源，群聊保留多参与者，私聊维持账号隔离；
 * worker 从 Memory 重载并比对来源正文、地址、事件截止点和请求时刻，
 * 再从同一批不可变入站原文补回 replyTo；只解析窗口内唯一目标，缺失或歧义保留 null，
 * 不改写 raw 文档、不为回复关系扩大冻结窗口。provider 输入的回复关系随副本一起深冻结。
 * 经版本化 provider 产生事实，再登记 memory.text 和唯一 terminal；未完成文本不进入 Prompt。
 * cognitionEvidenceSelector 重载直接来源；createCognitionMemorySelector 按 provider/revision/asOf
 * 选择最新完整快照并核对直接证据，返回可由 Core 再次加载的 Memory atom ID。
 * knowledge 开启时通过命名 guard 核验整个证据闭包，任一来源撤回或 guard 不可用都拒绝该快照。
 * provider 超时/暂时错误交给 Reliable Runner，source/schema 失败关闭；后台链不触发在线回合。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import {
  awaitWithSignal,
  MEMORY_COGNITION_EVIDENCE_GUARD_STRATEGY_ID,
  cognitionIdentitySchema,
  memoryCognitionCapability,
  memoryDocumentReaderCapability,
  validateCognitionResult,
  freezeCognitionInput,
  resolveCognitionReplyTarget,
  type CognitionIdentity,
  type MemoryDocument,
} from "@kaguya/memory";
import {
  z,
  type DeepReadonly,
  type InformationAtom,
  type PlatformDestination,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationSelector,
} from "@kaguya/sdk";
import { onInformation } from "@kaguya/sdk";
import {
  coreMemoryTextInformationKind,
  attentionArousalCompletedInformationKind,
  inboundTextInformationKind,
  turnCandidateInformationKind,
  turnClaimedInformationKind,
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
  kind: "memory.cognition.requested",
  displayName: "记忆认知请求",
  description:
    "认知处理前冻结有限来源窗口和提供方身份；外部认知能力据此生成可核对证据的快照。",
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
  kind: "memory.cognition.completed",
  displayName: "记忆认知结果",
  description:
    "认知结果通过证据检查后登记完成、空结果或被替代状态；后续可沿来源引用审计快照，不将无证据输出写为原始记忆。",
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
  destination: PlatformDestination;
}): string {
  return JSON.stringify([
    "scene.v2",
    source.platform,
    source.adapterId,
    source.destination.kind === "group" ? null : source.senderId,
    source.destination,
  ]);
}
const windowSelector = defineInformationSelector({
  selectorId: "memory.cognition.window",
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
          ...(address.destination.kind === "group"
            ? {}
            : { senderId: address.senderId }),
          destination: address.destination,
        },
      },
      occurredBefore: source.occurredAt,
      order: "desc",
      limit: 32,
    });
    const scopeKey = cognitionScopeKey(address);
    const seen = new Set<string>();
    return [source, ...history]
      .filter((atom) => {
        if (
          seen.has(atom.informationId) ||
          atom.kind !== inboundTextInformationKind.kind ||
          Date.parse(atom.occurredAt) > Date.parse(source.occurredAt)
        )
          return false;
        const parsed = inboundTextInformationKind.payloadSchema.safeParse(
          atom.payload,
        );
        if (
          !parsed.success ||
          cognitionScopeKey(parsed.data.source) !== scopeKey
        )
          return false;
        seen.add(atom.informationId);
        return true;
      })
      .slice(0, 32)
      .sort(compareEvidence)
      .map((atom) => atom.informationId);
  },
});
export const cognitionEvidenceSelector = defineInformationSelector({
  selectorId: "memory.cognition.evidence",
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
    definitionId: "memory.cognition",
    tags: ["memory"],
    inspection: firstPartyInspection["memory.cognition"],
    displayName: "记忆认知快照",
    summary: "通过可替换的认知提供方生成有来源证据的快照。",
    description:
      "原始记忆写回后冻结已持久化原文的有限窗口，提交认知请求并验证提供方结果，输出完成、空结果或被替代的快照；与在线回复独立，不改写原始记忆。",
    settingsSchema: z
      .object({
        revision: z.string().min(1).optional().meta({
          title: "版本",
          description: "Mem0 配置版本。",
          public: true,
        }),
        baseUrl: z.url().optional().meta({
          title: "服务地址",
          description: "Mem0 REST API 地址。",
          public: true,
        }),
        apiKey: z.string().min(1).optional().meta({
          title: "API Key",
          description: "Mem0 API 凭据；留空则保留原值。",
          public: true,
          secret: true,
        }),
      })
      .strict(),
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
            subscriptionId: "memory.cognition.request.v1",
            delivery: "durable",
          },
          async (completed, context) => {
            const atoms = await context.select(windowSelector);
            if (!atoms.length) return;
            const documents: MemoryDocument[] = [];
            for (const atom of atoms) {
              const doc = await reader.getBySource(atom.informationId);
              if (doc) {
                if (!matchesDocumentEvidence(doc, atom))
                  throw new Error("Invalid persisted cognition source");
                documents.push(doc);
              }
            }
            if (!documents.length)
              throw new Error("Missing persisted cognition source");
            const last = documents.at(-1)!;
            const sourceInformationIds = documents.map(
              (doc) => doc.sourceInformationId,
            );
            await context.registerOnce(
              "memory.cognition.request.v1",
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
            subscriptionId: "memory.cognition.execute.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const payload =
              memoryCognitionRequestedInformationKind.payloadSchema.parse(
                request.payload,
              );
            const evidence = await context.select(cognitionEvidenceSelector);
            const evidenceById = new Map(
              evidence.map((atom) => [atom.informationId, atom]),
            );
            let status: "completed" | "empty" | "superseded" | "invalid" =
              "superseded";
            let memoryInformationId: string | null = null;
            if (
              payload.identity.providerId === provider.identity.providerId &&
              payload.identity.revision === provider.identity.revision
            ) {
              try {
                const documents: MemoryDocument[] = [];
                for (const id of payload.sourceInformationIds) {
                  const doc = await reader.getBySource(id);
                  const atom = evidenceById.get(id);
                  if (
                    !doc ||
                    !atom ||
                    !matchesDocumentEvidence(doc, atom) ||
                    Date.parse(doc.occurredAt) > Date.parse(payload.asOf) ||
                    Date.parse(doc.createdAt) >
                      Date.parse(request.occurredAt) ||
                    !matchesRequestedScope(doc, payload.scopeKey)
                  )
                    throw new Error("Invalid cognition evidence");
                  documents.push(doc);
                }
                const input = freezeCognitionInput({
                  operationKey: request.informationId,
                  documents: documents.map((document) => {
                    // reader 的契约只提供 raw 字段；新增回复元数据只能取自已验证的账本。
                    const rawDocument: MemoryDocument = {
                      memoryId: document.memoryId,
                      sourceInformationId: document.sourceInformationId,
                      sourceKind: document.sourceKind,
                      content: document.content,
                      occurredAt: document.occurredAt,
                      createdAt: document.createdAt,
                      address: document.address,
                    };
                    const { source } =
                      inboundTextInformationKind.payloadSchema.parse(
                        evidenceById.get(document.sourceInformationId)!.payload,
                      );
                    if (!source.replyTo) return rawDocument;
                    return {
                      ...rawDocument,
                      replyTo: {
                        platformMessageId: source.replyTo.platformMessageId,
                        ...(source.replyTo.senderId === undefined
                          ? {}
                          : { senderId: source.replyTo.senderId }),
                        sourceInformationId: resolveCognitionReplyTarget(
                          documents,
                          document.sourceInformationId,
                          source.replyTo,
                        ),
                      },
                    };
                  }),
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
                const parsed = validateCognitionResult(result, input);
                status = parsed.facts.length ? "completed" : "empty";
                if (parsed.facts.length) {
                  const memory = await context.registerOnce(
                    "memory.cognition.text.v1",
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
              "memory.cognition.terminal.v1",
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
export function createCognitionMemorySelector(
  identity: CognitionIdentity,
  options: { readonly requireEvidenceGuard?: boolean } = {},
) {
  return defineInformationSelector({
    selectorId: "memory.cognition.completed-snapshot",
    select: async ({ sourceAtom, ledger }) => {
      let candidates: readonly DeepReadonly<InformationAtom>[] = [];
      if (sourceAtom.kind === turnCandidateInformationKind.kind) {
        const decisions = await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "incoming",
          limit: 10,
        });
        if (
          decisions.some(
            (atom) =>
              atom.kind === attentionArousalCompletedInformationKind.kind &&
              atom.payload.outcome === "observe",
          )
        )
          candidates = [sourceAtom];
      } else if (
        sourceAtom.kind === attentionArousalCompletedInformationKind.kind &&
        sourceAtom.payload.outcome === "observe"
      ) {
        candidates = (
          await ledger.related({
            from: [sourceAtom.informationId],
            relation: "core:status-of",
            direction: "outgoing",
            limit: 1,
          })
        ).filter((atom) => atom.kind === turnCandidateInformationKind.kind);
      } else if (
        sourceAtom.kind === personContextCompletedInformationKind.kind
      ) {
        const inbound = (
          await ledger.related({
            from: [sourceAtom.informationId],
            relation: "core:status-of",
            direction: "outgoing",
            limit: 1,
          })
        )[0];
        if (inbound) {
          const claims = (
            await ledger.related({
              from: [inbound.informationId],
              relation: "core:uses-context",
              direction: "incoming",
              limit: 1000,
            })
          ).filter((atom) => atom.kind === turnClaimedInformationKind.kind);
          candidates = (
            await Promise.all(
              claims.map((claim) =>
                ledger.related({
                  from: [claim.informationId],
                  relation: "agent:turn-candidate",
                  direction: "outgoing",
                  limit: 1,
                }),
              ),
            )
          ).flat();
        }
      }
      const selected = [];
      for (const candidate of candidates) {
        if (candidate.kind !== turnCandidateInformationKind.kind) continue;
        const payload = candidate.payload as any;
        const inbounds = await ledger.find({
          kinds: [inboundTextInformationKind.kind],
          scopeKey: payload.scopeKey,
          registrationOrder: true,
          ...(payload.unreadAfterInformationId
            ? { afterInformationId: payload.unreadAfterInformationId }
            : {}),
          throughInformationId: payload.unreadThroughInformationId,
          payloadContains: {
            source: {
              platform: payload.platform,
              adapterId: payload.adapterId,
              destination: payload.destination,
            },
          },
          order: "asc",
          limit: 1000,
        });
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
                Date.parse(atom.occurredAt) >
                  Date.parse(snapshot.payload.asOf) ||
                cognitionScopeKey(
                  inboundTextInformationKind.payloadSchema.parse(atom.payload)
                    .source,
                ) !== cognitionScopeKey(source),
            )
          )
            continue;
          const evidenceIds = new Set(
            evidence.map((atom) => atom.informationId),
          );
          if (options.requireEvidenceGuard) {
            try {
              const available = await ledger.retrieve({
                strategyId: MEMORY_COGNITION_EVIDENCE_GUARD_STRATEGY_ID,
                input: { sourceInformationIds: [...evidenceIds] },
                limit: evidenceIds.size,
              });
              const availableIds = new Set(
                available.map((atom) => atom.informationId),
              );
              if (
                availableIds.size !== evidenceIds.size ||
                [...evidenceIds].some((id) => !availableIds.has(id))
              )
                continue;
            } catch {
              // 开启态不可因策略缺失、账本或仓储故障退回未检查的旧快照。
              continue;
            }
          }
          const memories = await ledger.related({
            from: [snapshot.atom.informationId],
            relation: "agent:memory",
            direction: "outgoing",
            limit: 1,
          });
          const memory = memories[0];
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
/** 将持久化正文与不可变账本原文逐字段核对，避免 reader 返回被替换或错配的来源。 */
function matchesDocumentEvidence(
  document: MemoryDocument,
  atom: DeepReadonly<InformationAtom>,
): boolean {
  if (atom.kind !== inboundTextInformationKind.kind) return false;
  const parsed = inboundTextInformationKind.payloadSchema.safeParse(
    atom.payload,
  );
  if (!parsed.success) return false;
  const { source, text } = parsed.data;
  return (
    document.sourceInformationId === atom.informationId &&
    document.sourceKind === atom.kind &&
    document.content === text &&
    Date.parse(document.occurredAt) === Date.parse(atom.occurredAt) &&
    document.address.platform === source.platform &&
    document.address.adapterId === source.adapterId &&
    document.address.accountId === source.senderId &&
    document.address.platformMessageId === source.platformMessageId &&
    JSON.stringify(document.address.destination) ===
      JSON.stringify(source.destination)
  );
}
/** 新请求使用场景键；旧的单发送者 pending 请求仍按原账号键恢复，不扩大其证据范围。 */
function matchesRequestedScope(
  document: MemoryDocument,
  scopeKey: string,
): boolean {
  const source = { ...document.address, senderId: document.address.accountId };
  return (
    cognitionScopeKey(source) === scopeKey ||
    JSON.stringify([
      source.platform,
      source.adapterId,
      source.senderId,
      source.destination,
    ]) === scopeKey
  );
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
