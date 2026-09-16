/**
 * 功能概述：把新增消息和历史回填转换为可靠、有界的 embedding 任务。
 * memoryIndexModule 启动时通过窄 bootstrap capability 登记回填根；每页只读取最多 50 个文档，
 * 先登记逐文档 request 与下一页 continuation，再提交本页终态，崩溃后用唯一槽位恢复。
 * worker 仅从 MemoryDocumentReader 读取持久化正文，验证冻结模型身份后调用 embedding/vector capability；
 * 模型切换保留旧任务为 superseded，新的 revision 独立回填；不产生任何在线回合信号。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
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
  displayName: "记忆向量索引请求",
  description:
    "原始记忆写回后按来源和模型版本登记索引请求；向量处理器据此生成可恢复的派生向量，不修改原文。",
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
  displayName: "记忆向量回填请求",
  description:
    "启动向量回填时冻结模型身份、游标和批量大小；处理器按有界分页恢复历史记忆索引。",
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
  displayName: "记忆向量处理结果",
  description:
    "单条索引或回填页处理结束后登记完成、来源缺失或版本过期；维护流程据此追踪进度而不唤醒在线回合。",
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
    inspection: firstPartyInspection["agent.memory.index"],
    displayName: "记忆向量索引",
    summary: "为原始记忆建立按模型版本隔离的可恢复向量。",
    description:
      "消费写回完成事实和有界回填请求，通过嵌入能力建立派生向量并记录处理结果；保留原始记忆，支持分页恢复，不触发在线回合。",
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
