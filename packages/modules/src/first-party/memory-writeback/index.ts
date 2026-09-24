/**
 * 功能概述：将身份终态对应的原始 inbound 可靠写入独立 Memory，不依赖在线回合或人物解析成功。
 * 主要职责：memoryWritebackModule 登记每个 source 的唯一 request，worker 经 memoryCapability.put
 * 幂等写入并提交 completed/empty/failed；writebackSourceSelector 沿显式引用重载来源。
 * 代码库关系：消费 identity 模块的 person.context.completed，由 composition 在 Memory 开启时激活；
 * 数据库瞬时故障留给 Reliable Runner 重试/耗尽，关闭时不取消 pending request。
 * 输入输出与副作用：只持久化 inbound 文本；request/terminal 不复制正文，身份只作关联而非主键。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import {
  InvalidMemoryInputError,
  MemorySourceConflictError,
  memoryCapability,
} from "@kaguya/memory";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationModule,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import {
  inboundTextInformationKind,
  personContextCompletedInformationKind,
} from "../information-kinds.js";

export const memoryWritebackRequestedInformationKind = defineInformationKind({
  kind: "memory.writeback.requested",
  displayName: "原始记忆写回请求",
  description:
    "入站消息身份处理结束后登记仅引用来源的写回意图；可靠消费者重载正文并幂等写入独立记忆。",
  payloadSchema: z.object({ version: z.literal(1) }).strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "agent:source": {
      required: true,
      multiple: false,
      targetKinds: [inboundTextInformationKind.kind],
    },
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [personContextCompletedInformationKind.kind],
    },
  },
  log: {
    enabled: true,
    level: "debug",
    project: () => ({ event: "memory.writeback.requested" }),
  },
});
function terminalKind<S extends "completed" | "empty" | "failed">(status: S) {
  return defineInformationKind({
    kind: `memory.writeback.${status}` as const,
    displayName: {
      completed: "原始记忆写回完成",
      empty: "原始记忆内容为空",
      failed: "原始记忆写回失败",
    }[status],
    description: {
      completed:
        "原始入站正文幂等保存成功后登记的唯一结果；向量索引等派生处理据此读取已持久化记忆。",
      empty:
        "写回发现来源正文为空时登记的唯一结果；用于说明该请求已处理但没有可保存的记忆。",
      failed:
        "写回发现输入不合法或来源冲突时登记的唯一失败结果；用于审计无法保存原文的原因，瞬时存储故障由可靠执行重试。",
    }[status],
    payloadSchema: z
      .object({
        status: z.literal(status),
        version: z.literal(1),
      })
      .strict(),
    references: {
      "core:context": {
        required: true,
        multiple: false,
        targetKinds: ["core.runtime.context"],
      },
      "core:caused-by": { required: true, multiple: false },
      "core:status-of": {
        required: true,
        multiple: false,
        targetKinds: [memoryWritebackRequestedInformationKind.kind],
      },
    },
    log: {
      enabled: true,
      level: "debug",
      project: () => ({ event: "memory.writeback.terminal", status }),
    },
  });
}
export const memoryWritebackCompletedInformationKind =
  terminalKind("completed");
export const memoryWritebackEmptyInformationKind = terminalKind("empty");
export const memoryWritebackFailedInformationKind = terminalKind("failed");
export const writebackSourceSelector = defineInformationSelector({
  selectorId: "memory.writeback.source",
  select: async ({ sourceAtom, ledger }) => {
    const relation =
      sourceAtom.kind === personContextCompletedInformationKind.kind
        ? "core:status-of"
        : "agent:source";
    return (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation,
        direction: "outgoing",
        limit: 2,
      })
    ).map((atom) => atom.informationId);
  },
});
export const memoryWritebackModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "memory.writeback",
    tags: ["memory"],
    inspection: firstPartyInspection["memory.writeback"],
    displayName: "原始记忆",
    summary: "将入站原文可靠保存到独立记忆存储。",
    description:
      "消费消息身份终态并沿引用重载原始入站文本，提交幂等写回请求及完成、空内容或失败结果；即使回合不发言也保存原文，向量与认知处理独立进行。",
    settingsSchema: z.object({}).strict(),
    consumes: [
      personContextCompletedInformationKind,
      memoryWritebackRequestedInformationKind,
    ],
    produces: [
      memoryWritebackRequestedInformationKind,
      memoryWritebackCompletedInformationKind,
      memoryWritebackEmptyInformationKind,
      memoryWritebackFailedInformationKind,
    ],
    selectors: [writebackSourceSelector],
    promptRenderers: [],
    requires: [memoryCapability],
    provides: [],
  },
  create: (_config, lifecycle) => {
    const memory = lifecycle.use(memoryCapability);
    return {
      provisions: [],
      subscriptions: [
        onInformation(
          personContextCompletedInformationKind,
          {
            subscriptionId: "memory.writeback.request.v1",
            delivery: "durable",
          },
          async (identity, context) => {
            const sources = await context.select(writebackSourceSelector);
            const source = sources[0];
            if (
              sources.length !== 1 ||
              source?.kind !== inboundTextInformationKind.kind
            )
              throw new Error("Invalid writeback identity source");
            await context.registerOnce(
              "memory.writeback.request.v1",
              source.informationId,
              memoryWritebackRequestedInformationKind,
              {
                payload: { version: 1 as const },
                references: [
                  {
                    relation: "agent:source",
                    informationId: source.informationId,
                  },
                ],
              },
            );
          },
        ),
        onInformation(
          memoryWritebackRequestedInformationKind,
          {
            subscriptionId: "memory.writeback.execute.v1",
            delivery: "durable",
          },
          async (request, context) => {
            const sources = await context.select(writebackSourceSelector);
            const source = sources[0];
            let status: "completed" | "empty" | "failed" = "failed";
            if (
              sources.length === 1 &&
              source?.kind === inboundTextInformationKind.kind
            ) {
              const parsed = inboundTextInformationKind.payloadSchema.safeParse(
                source.payload,
              );
              if (parsed.success) {
                const { text, source: address } = parsed.data;
                if (!text.trim()) status = "empty";
                else {
                  try {
                    context.signal.throwIfAborted();
                    await memory.put({
                      sourceInformationId: source.informationId,
                      sourceKind: source.kind,
                      content: text,
                      occurredAt: source.occurredAt,
                      address: {
                        platform: address.platform,
                        adapterId: address.adapterId,
                        platformMessageId: address.platformMessageId,
                        accountId: address.senderId,
                        destination: address.destination,
                      },
                    });
                    status = "completed";
                  } catch (error) {
                    if (
                      !(error instanceof InvalidMemoryInputError) &&
                      !(error instanceof MemorySourceConflictError)
                    )
                      throw error;
                  }
                }
              }
            }
            const references = [
              {
                relation: "core:status-of" as const,
                informationId: request.informationId,
              },
            ];
            if (status === "completed")
              await context.commitTerminal(
                "memory.writeback.terminal.v1",
                request.informationId,
                memoryWritebackCompletedInformationKind,
                {
                  payload: {
                    version: 1 as const,
                    status: "completed" as const,
                  },
                  references,
                },
              );
            else if (status === "empty")
              await context.commitTerminal(
                "memory.writeback.terminal.v1",
                request.informationId,
                memoryWritebackEmptyInformationKind,
                {
                  payload: { version: 1 as const, status: "empty" as const },
                  references,
                },
              );
            else
              await context.commitTerminal(
                "memory.writeback.terminal.v1",
                request.informationId,
                memoryWritebackFailedInformationKind,
                {
                  payload: { version: 1 as const, status: "failed" as const },
                  references,
                },
              );
          },
        ),
      ],
    };
  },
});
