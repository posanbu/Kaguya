/**
 * 功能概述：声明事件记忆、历史回填和 Wiki 更新的可靠 Information 协议。
 * 主要职责：event submitted 携带显式事件归属与来源；refresh 冻结页面版本和双时间截止点；
 * updated 保存可审计的只读页面表示；completed 标识请求处理终态，不能作为动作成功证据。
 * 代码库关系：memory-knowledge/index.ts 消费本文件定义，composition 使用 bootstrap 启动回填；
 * 业务实体仍由 Information ledger 提供，数据库能力只保存有证据的派生投影。
 * 输入输出与副作用：仅 schema 与 capability 定义；不访问数据库或模型，不推断实体身份。
 */
import {
  memoryEventInputSchema,
  memoryClaimInputSchema,
  knowledgeEpisodeInputSchema,
} from "@kaguya/memory";
import { z, type JsonObject } from "@kaguya/schema";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";

const inherited = {
  "core:caused-by": { required: false, multiple: false },
  "core:context": {
    required: false,
    multiple: false,
    targetKinds: ["core.runtime.context"],
  },
} as const;

export const memoryEventSubmittedInformationKind = defineInformationKind({
  kind: "memory.knowledge.event.submitted",
  displayName: "通用记忆事件登记",
  description:
    "显式登记消息、观测或动作反馈的原始来源、场景和实体归属，可靠保存后再更新派生页面。",
  payloadSchema: memoryEventInputSchema as unknown as z.ZodType<JsonObject>,
  references: {
    ...inherited,
    "agent:source": { required: true, multiple: false },
    "agent:scope": { required: true, multiple: false },
    "agent:entity": { required: false, multiple: true },
  },
  log: { enabled: false },
});

export const memoryKnowledgeBackfillInformationKind = defineInformationKind({
  kind: "memory.knowledge.backfill.requested",
  displayName: "事件记忆历史回填",
  description:
    "按账本登记顺序逐页重放身份终态与显式事件，每页最多 50 条；停机后继续未完成页面。",
  payloadSchema: z
    .object({
      afterInformationId: z.string().nullable(),
    })
    .strict(),
  references: inherited,
  log: { enabled: false },
});

export const memoryKnowledgeMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("claim"), input: memoryClaimInputSchema })
    .strict(),
  z
    .object({
      operation: z.literal("episode"),
      input: knowledgeEpisodeInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("revoke-source"),
      input: z
        .object({
          scopeInformationId: z.string().min(1),
          sourceInformationId: z.string().min(1),
          reason: z.string().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("invalidate-entity"),
      input: z
        .object({
          scopeInformationId: z.string().min(1),
          entityInformationId: z.string().min(1),
          reason: z.string().min(1).max(512),
        })
        .strict(),
    })
    .strict(),
]);
export const memoryKnowledgeMutationInformationKind = defineInformationKind({
  kind: "memory.knowledge.mutation.requested",
  displayName: "记忆证据修订请求",
  description:
    "通过可靠任务追加显式断言或经历、撤回原始证据或使实体派生认识失效，随后安排受影响脏页恢复。",
  payloadSchema:
    memoryKnowledgeMutationSchema as unknown as z.ZodType<JsonObject>,
  references: {
    ...inherited,
    "agent:scope": { required: true, multiple: false },
    "agent:source": { required: true, multiple: true },
    "agent:entity": { required: false, multiple: true },
  },
  log: { enabled: false },
});
export const memoryKnowledgeMaintenanceInformationKind = defineInformationKind({
  kind: "memory.knowledge.maintenance.requested",
  displayName: "记忆脏页恢复",
  description:
    "逐页扫描持久化失效页并安排版本化刷新；失败页面不阻塞其后的页面。",
  payloadSchema: z
    .object({
      after: z
        .object({
          scopeInformationId: z.string().min(1),
          entityInformationId: z.string().min(1),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  references: inherited,
  log: { enabled: false },
});

export const memoryWikiRefreshInformationKind = defineInformationKind({
  kind: "memory.knowledge.wiki.refresh.requested",
  displayName: "Wiki 页面刷新请求",
  description:
    "冻结页面及失效版本、事件时间和入库时间截止点，以比较并交换方式生成可追溯修订。",
  payloadSchema: z
    .object({
      scopeInformationId: z.string().min(1),
      entityInformationId: z.string().min(1),
      expectedVersion: z.number().int().nonnegative(),
      expectedDirtyVersion: z.number().int().nonnegative(),
      evidenceSourceInformationIds: z.array(z.string().min(1)).max(100),
      evidenceCutoff: z
        .object({
          occurredBefore: z.iso.datetime({ offset: true }),
          recordedBefore: z.iso.datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
  references: {
    ...inherited,
    "agent:scope": { required: true, multiple: false },
    "agent:entity": { required: true, multiple: false },
  },
  log: { enabled: false },
});

export const memoryWikiUpdatedInformationKind = defineInformationKind({
  kind: "memory.knowledge.wiki.updated",
  displayName: "Wiki 页面修订",
  description:
    "保存有界页面章节、修订版本和原始证据引用，供开发者只读检查；不替代执行反馈或语义验证。",
  payloadSchema: z
    .object({
      scopeInformationId: z.string().min(1),
      entityInformationId: z.string().min(1),
      version: z.number().int().positive(),
      generatorVersion: z.string().min(1),
      evidenceCutoff: z
        .object({ occurredBefore: z.string(), recordedBefore: z.string() })
        .strict(),
      text: z.string().max(65536),
      sourceInformationIds: z.array(z.string()).max(100),
      truncated: z.boolean(),
    })
    .strict(),
  references: {
    ...inherited,
    "agent:source": { required: false, multiple: true },
    "agent:scope": { required: true, multiple: false },
    "agent:entity": { required: true, multiple: false },
  },
  log: { enabled: false },
});

export const memoryKnowledgeCompletedInformationKind = defineInformationKind({
  kind: "memory.knowledge.completed",
  displayName: "事件记忆处理结果",
  description:
    "记录投影或回填任务完成、跳过和版本竞争结果；失败交给可靠任务重试与耗尽记录。",
  payloadSchema: z
    .object({ status: z.enum(["completed", "skipped", "superseded"]) })
    .strict(),
  references: {
    ...inherited,
    "core:status-of": { required: true, multiple: false },
  },
  log: { enabled: false },
});

export const memoryKnowledgeBootstrapCapability = defineModuleCapability<{
  requestBackfill(): Promise<void>;
  requestMaintenance(): Promise<void>;
}>("memory:knowledge.bootstrap", 1);
