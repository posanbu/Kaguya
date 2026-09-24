/**
 * 功能概述：定义第一方通用事件、可追溯断言与实体 Wiki 的持久化端口，不替代 Information 身份账本。
 * 主要职责：各严格 schema 限制正文、证据和分页；MemoryKnowledgeAccess 暴露追加、冻结检索、撤回、Wiki CAS 接口。
 * 代码库关系：database 实现本端口；memory-knowledge 模块经 capability 写入真实事件并生成可重建 Wiki；Runtime 检索只重载原始来源。
 * 输入输出与副作用：本文件只有验证与类型；事件 recordedAt 来自数据库，所有业务读取必须显式指定 scope，历史查询同时冻结事件和记录时间。
 */
import { defineModuleCapability } from "@kaguya/sdk";
import { z } from "@kaguya/schema";

const id = z.string().trim().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
export const knowledgeEntityResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), entityInformationId: id }).strict(),
  z
    .object({
      status: z.literal("unresolved"),
      label: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      status: z.literal("ambiguous"),
      label: z.string().min(1).max(512),
      candidateInformationIds: z.array(id).min(2).max(16),
    })
    .strict(),
]);
export type EntityResolution = z.infer<typeof knowledgeEntityResolutionSchema>;
export const knowledgeEventInputSchema = z
  .object({
    sourceInformationId: id,
    scopeInformationId: id,
    occurredAt: timestamp,
    content: z.string().min(1).max(16000),
    eventType: z.string().min(1).max(128),
    actor: knowledgeEntityResolutionSchema,
    subjects: z.array(knowledgeEntityResolutionSchema).max(32),
    replyTo: z
      .object({
        sourceInformationId: id.optional(),
        externalMessageId: id.optional(),
      })
      .strict()
      .refine((v) => !!v.sourceInformationId || !!v.externalMessageId)
      .optional(),
    mediaReferences: z
      .array(
        z
          .object({
            uri: z.string().min(1).max(2048),
            startMs: z.number().nonnegative().optional(),
            endMs: z.number().nonnegative().optional(),
          })
          .strict()
          .refine(
            (v) =>
              v.startMs === undefined ||
              v.endMs === undefined ||
              v.endMs >= v.startMs,
          ),
      )
      .max(16)
      .optional(),
    actionStatus: z
      .enum([
        "requested",
        "generated",
        "started",
        "completed",
        "failed",
        "interrupted",
        "responded",
      ])
      .optional(),
  })
  .strict();
export type KnowledgeEventInput = z.infer<typeof knowledgeEventInputSchema>;
export type KnowledgeEvent = KnowledgeEventInput & {
  readonly sourceKind: string;
  readonly recordedAt: string;
};
export const knowledgeClaimInputSchema = z
  .object({
    claimId: id,
    scopeInformationId: id,
    subjectInformationId: id,
    speakerInformationId: id.optional(),
    predicate: z.string().min(1).max(256),
    value: z.string().max(8000),
    epistemic: z.enum(["fact", "assertion", "inference", "uncertain"]),
    validFrom: timestamp,
    validTo: timestamp.optional(),
    evidenceSourceInformationIds: z.array(id).min(1).max(32),
    supersedesClaimId: id.optional(),
    retractsClaimId: id.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.validTo === undefined ||
      Date.parse(v.validTo) >= Date.parse(v.validFrom),
  )
  .refine((v) => !(v.supersedesClaimId && v.retractsClaimId));
export type KnowledgeClaimInput = z.infer<typeof knowledgeClaimInputSchema>;
export type KnowledgeClaim = KnowledgeClaimInput & {
  readonly recordedAt: string;
};
export const knowledgeCutoffSchema = z
  .object({ occurredBefore: timestamp, recordedBefore: timestamp })
  .strict();
export type KnowledgeCutoff = z.infer<typeof knowledgeCutoffSchema>;
export const knowledgeRecallQuerySchema = knowledgeCutoffSchema
  .extend({
    scopeInformationId: id,
    entityInformationId: id.optional(),
    query: z
      .string()
      .refine((value) => Array.from(value).length <= 512)
      .optional(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export type KnowledgeRecallQuery = z.infer<typeof knowledgeRecallQuerySchema>;
export interface KnowledgeRecallResult {
  readonly events: readonly KnowledgeEvent[];
  readonly claims: readonly KnowledgeClaim[];
  readonly evidenceSourceInformationIds: readonly string[];
  readonly reasons: readonly string[];
  readonly missing: readonly string[];
  readonly truncated: boolean;
}
export const wikiSectionSchema = z
  .object({
    heading: z.string().min(1).max(256),
    content: z.string().min(1).max(8000),
    evidenceSourceInformationIds: z.array(id).min(1).max(100),
    claimIds: z.array(id).max(100),
  })
  .strict();
export const wikiRevisionInputSchema = z
  .object({
    operationId: id,
    scopeInformationId: id,
    entityInformationId: id,
    expectedVersion: z.number().int().nonnegative(),
    expectedDirtyVersion: z.number().int().nonnegative(),
    evidenceCutoff: knowledgeCutoffSchema,
    generatorVersion: z.string().min(1).max(256),
    sections: z.array(wikiSectionSchema).max(16),
  })
  .strict();
export type WikiRevisionInput = z.infer<typeof wikiRevisionInputSchema>;
export type WikiRevision = Omit<
  WikiRevisionInput,
  "expectedVersion" | "expectedDirtyVersion"
> & { readonly version: number; readonly recordedAt: string };
export interface WikiPage {
  readonly scopeInformationId: string;
  readonly entityInformationId: string;
  readonly version: number;
  readonly dirtyVersion: number;
  readonly dirty: boolean;
  readonly reasons: readonly string[];
  readonly latestRevision?: WikiRevision;
}
export const knowledgeEpisodeInputSchema = z
  .object({
    episodeId: id,
    scopeInformationId: id,
    title: z.string().min(1).max(256),
    evidenceSourceInformationIds: z.array(id).min(1).max(100),
  })
  .strict();
export type KnowledgeEpisodeInput = z.infer<typeof knowledgeEpisodeInputSchema>;
export type KnowledgeEpisode = KnowledgeEpisodeInput & {
  readonly recordedAt: string;
};
export interface MemoryKnowledgeAccess {
  putEvent(
    input: KnowledgeEventInput,
  ): Promise<{ event: KnowledgeEvent; created: boolean }>;
  filterAvailableSourceIds(input: {
    scopeInformationId?: string;
    sourceInformationIds: readonly string[];
  }): Promise<readonly string[]>;
  getEvent(
    sourceInformationId: string,
    scopeInformationId: string,
  ): Promise<KnowledgeEvent | undefined>;
  appendClaim(
    input: KnowledgeClaimInput,
  ): Promise<{ claim: KnowledgeClaim; created: boolean }>;
  putEpisode(
    input: KnowledgeEpisodeInput,
  ): Promise<{ episode: KnowledgeEpisode; created: boolean }>;
  recall(input: KnowledgeRecallQuery): Promise<KnowledgeRecallResult>;
  listDirtyPages(input: {
    limit: number;
    after?: { scopeInformationId: string; entityInformationId: string };
  }): Promise<readonly WikiPage[]>;
  listWikiPages(input: {
    limit: number;
    before?: {
      recordedAt: string;
      scopeInformationId: string;
      entityInformationId: string;
    };
  }): Promise<readonly WikiPage[]>;
  readWikiPage(input: {
    scopeInformationId: string;
    entityInformationId: string;
  }): Promise<WikiPage | undefined>;
  writeWikiRevision(input: WikiRevisionInput): Promise<WikiRevision>;
  listWikiRevisions(input: {
    scopeInformationId: string;
    entityInformationId: string;
    limit: number;
    beforeVersion?: number;
  }): Promise<readonly WikiRevision[]>;
  revokeSource(input: {
    scopeInformationId: string;
    sourceInformationId: string;
    reason: string;
  }): Promise<void>;
  invalidateEntity(input: {
    operationId: string;
    scopeInformationId: string;
    entityInformationId: string;
    reason: string;
  }): Promise<void>;
}
export class KnowledgeConflictError extends Error {
  constructor() {
    super("Memory knowledge write conflict");
    this.name = "KnowledgeConflictError";
  }
}
export class KnowledgeEvidenceError extends Error {
  constructor() {
    super("Invalid Memory knowledge evidence");
    this.name = "KnowledgeEvidenceError";
  }
}
export const memoryKnowledgeCapability =
  defineModuleCapability<MemoryKnowledgeAccess>("memory:knowledge", 1);
export const MEMORY_KNOWLEDGE_RETRIEVAL_STRATEGY_ID = "memory.knowledge";

// 与 first-party 模块的命名对齐，保持唯一 schema 和错误类型。
export const memoryEventInputSchema = knowledgeEventInputSchema;
export const memoryClaimInputSchema = knowledgeClaimInputSchema;
export { KnowledgeConflictError as MemoryWikiConflictError };
