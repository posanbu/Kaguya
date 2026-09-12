/**
 * 功能概述：把新增消息和历史回填转换为可靠、有界的 embedding 任务。
 * memoryIndexModule 启动时通过窄 bootstrap capability 登记回填根；每页只读取最多 50 个文档，
 * 先登记逐文档 request 与下一页 continuation，再提交本页终态，崩溃后用唯一槽位恢复。
 * worker 仅从 MemoryDocumentReader 读取持久化正文，验证冻结模型身份后调用 embedding/vector capability；
 * 模型切换保留旧任务为 superseded，新的 revision 独立回填；不产生任何在线回合信号。
 */
import {
  awaitWithSignal,
  embeddingCapability,
  embeddingIdentityKey,
  embeddingIdentitySchema,
  memoryDocumentReaderCapability,
  memoryVectorCapability,
  validateEmbedding,
  type EmbeddingIdentity,
} from "@kaguya/memory";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationSelector,
  defineModuleCapability,
  onInformation,
} from "@kaguya/sdk";
import {
  memoryWritebackCompletedInformationKind,
  memoryWritebackRequestedInformationKind,
} from "../memory-writeback/index.js";
import { inboundTextInformationKind } from "../information-kinds.js";
const inherited = {
  "core:caused-by": { required: false, multiple: false },
  "core:context": {
    required: false,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
} as const;
export const memoryIndexRequestedInformationKind = defineInformationKind({
  kind: "agent.memory.index.requested",
  displayName: "Memory vector request",
  description:
    "Idempotent vector projection for one persisted document and model revision.",
  payloadSchema: z
    .object({
      sourceInformationId: z.string().min(1),
      identity: embeddingIdentitySchema,
    })
    .strict(),
  references: inherited,
  log: { enabled: false },
});
export const memoryBackfillRequestedInformationKind = defineInformationKind({
  kind: "agent.memory.index.backfill.requested",
  displayName: "Memory backfill page",
  description: "Bounded resumable keyset page for a frozen embedding identity.",
  payloadSchema: z
    .object({
      identity: embeddingIdentitySchema,
      afterMemoryId: z.string().min(1).nullable(),
      batchSize: z.number().int().min(1).max(50),
    })
    .strict(),
  references: inherited,
  log: { enabled: false },
});
export const memoryIndexCompletedInformationKind = defineInformationKind({
  kind: "agent.memory.index.completed",
  displayName: "Memory vector terminal",
  description: "Unique indexing or backfill page result.",
  payloadSchema: z
    .object({ status: z.enum(["completed", "missing", "superseded"]) })
    .strict(),
  references: {
    ...inherited,
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [
        memoryIndexRequestedInformationKind.kind,
        memoryBackfillRequestedInformationKind.kind,
      ],
    },
  },
  log: { enabled: false },
});
export const memoryIndexBootstrapCapability = defineModuleCapability<{
  requestBackfill(identity: EmbeddingIdentity): Promise<void>;
}>("kaguya:memory.index-bootstrap", 1);
const sourceSelector = defineInformationSelector({
  selectorId: "kaguya.memory.index.source",
  select: async ({ sourceAtom, ledger }) => {
    const requests = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:status-of",
      direction: "outgoing",
      limit: 1,
    });
    const request = requests.find(
      (atom) => atom.kind === memoryWritebackRequestedInformationKind.kind,
    );
    if (!request) return [];
    return (
      await ledger.related({
        from: [request.informationId],
        relation: "agent:source",
        direction: "outgoing",
        limit: 1,
      })
    )
      .filter((atom) => atom.kind === inboundTextInformationKind.kind)
      .map((atom) => atom.informationId);
  },
});
export const memoryIndexModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.memory.index",
    displayName: "Memory vector projection",
    summary: "Builds recoverable vectors without modifying raw Memory.",
    description:
      "Consumes raw writeback and bounded backfill pages; isolates model revisions and never wakes the online agent.",
    settingsSchema: z.object({}).strict(),
    consumes: [
      memoryWritebackCompletedInformationKind,
      memoryIndexRequestedInformationKind,
      memoryBackfillRequestedInformationKind,
    ],
    produces: [
      memoryIndexRequestedInformationKind,
      memoryBackfillRequestedInformationKind,
      memoryIndexCompletedInformationKind,
    ],
    selectors: [sourceSelector],
    promptRenderers: [],
    requires: [
      embeddingCapability,
      memoryDocumentReaderCapability,
      memoryVectorCapability,
      memoryIndexBootstrapCapability,
    ],
    provides: [],
  },
  create: (_config, lifecycle) => {
    const provider = lifecycle.use(embeddingCapability),
      documents = lifecycle.use(memoryDocumentReaderCapability),
      index = lifecycle.use(memoryVectorCapability),
      bootstrap = lifecycle.use(memoryIndexBootstrapCapability);
    return {
      provisions: [],
      start: () => bootstrap.requestBackfill(provider.identity),
      subscriptions: [
        onInformation(
          memoryWritebackCompletedInformationKind,
          { subscriptionId: "kaguya.memory.index.new.v1", delivery: "durable" },
          async (_completed, context) => {
            const sources = await context.select(sourceSelector);
            if (sources.length !== 1)
              throw new Error("Invalid writeback source");
            const sourceInformationId = sources[0]!.informationId;
            await context.registerOnce(
              "kaguya.memory.index.document.v1",
              JSON.stringify([
                embeddingIdentityKey(provider.identity),
                sourceInformationId,
              ]),
              memoryIndexRequestedInformationKind,
              { payload: { sourceInformationId, identity: provider.identity } },
            );
          },
        ),
        onInformation(
          memoryBackfillRequestedInformationKind,
          {
            subscriptionId: "kaguya.memory.index.backfill.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const payload =
              memoryBackfillRequestedInformationKind.payloadSchema.parse(
                request.payload,
              );
            const matches =
              embeddingIdentityKey(payload.identity) ===
              embeddingIdentityKey(provider.identity);
            if (matches) {
              const page = await documents.listDocuments({
                ...(payload.afterMemoryId
                  ? { afterMemoryId: payload.afterMemoryId }
                  : {}),
                limit: payload.batchSize,
              });
              for (const document of page)
                await context.registerOnce(
                  "kaguya.memory.index.document.v1",
                  JSON.stringify([
                    embeddingIdentityKey(payload.identity),
                    document.sourceInformationId,
                  ]),
                  memoryIndexRequestedInformationKind,
                  {
                    payload: {
                      sourceInformationId: document.sourceInformationId,
                      identity: payload.identity,
                    },
                  },
                );
              if (page.length === payload.batchSize)
                await context.registerOnce(
                  "kaguya.memory.index.page.v1",
                  JSON.stringify([
                    embeddingIdentityKey(payload.identity),
                    page.at(-1)!.memoryId,
                  ]),
                  memoryBackfillRequestedInformationKind,
                  {
                    payload: {
                      ...payload,
                      afterMemoryId: page.at(-1)!.memoryId,
                    },
                  },
                );
            }
            await context.commitTerminal(
              "kaguya.memory.index.terminal.v1",
              request.informationId,
              memoryIndexCompletedInformationKind,
              {
                payload: {
                  status: matches
                    ? ("completed" as const)
                    : ("superseded" as const),
                },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: request.informationId,
                  },
                ],
              },
            );
          },
        ),
        onInformation(
          memoryIndexRequestedInformationKind,
          {
            subscriptionId: "kaguya.memory.index.execute.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const payload =
              memoryIndexRequestedInformationKind.payloadSchema.parse(
                request.payload,
              );
            let status: "completed" | "missing" | "superseded" = "superseded";
            if (
              embeddingIdentityKey(payload.identity) ===
              embeddingIdentityKey(provider.identity)
            ) {
              const document = await documents.getBySource(
                payload.sourceInformationId,
              );
              status = "missing";
              if (document) {
                const signal = AbortSignal.any([
                  context.signal,
                  AbortSignal.timeout(30_000),
                ]);
                const vector = validateEmbedding(
                  await awaitWithSignal(
                    provider.embed(document.content, signal),
                    signal,
                  ),
                  payload.identity,
                );
                context.signal.throwIfAborted();
                await index.putVector(
                  document.memoryId,
                  payload.identity,
                  vector,
                );
                status = "completed";
              }
            }
            await context.commitTerminal(
              "kaguya.memory.index.terminal.v1",
              request.informationId,
              memoryIndexCompletedInformationKind,
              {
                payload: { status },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: request.informationId,
                  },
                ],
              },
            );
          },
        ),
      ],
    };
  },
});
