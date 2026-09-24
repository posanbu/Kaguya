/**
 * 功能概述：定义 WebUI 主动记忆录入的版本化传输、模型计划和来源契约。
 * 主要职责：submission 限制自然语言与显式身份选择；plan 只允许主体、断言和关系，
 * 不接受 SQL、权限或配置；job 区分持久化排队、澄清、实际写入和失败。
 * 代码库关系：database 校验并执行计划，server 组织模型调用，web 复用相同 DTO。
 * 输入输出与副作用：只有严格 schema 和类型；人工录入统一进入全局记忆，各聊天入口按需召回；
 * 定向修改及可撤销删除引用真实断言。契约版本不匹配由处理器明确拒绝。
 */
import { z } from "zod";

export const MEMORY_INGESTION_VERSION = 2;
export const USER_STATEMENT_KIND = "agent.user.statement";
export const USER_INPUT_KIND = "agent.user.input";
export const USER_SUBJECT_KIND = "agent.user.subject.entity";
export const USER_MEMORY_SCOPE_KIND = "agent.user.scope.entity";
export const GLOBAL_MEMORY_SCOPE_ID = "memory:access:global";
const id = z.string().trim().min(1).max(512);
const label = z.string().trim().min(1).max(128);
export const memoryIngestionSubmissionSchema = z
  .object({
    requestId: z.uuid(),
    sessionId: z.uuid(),
    scopeInformationId: z
      .literal(GLOBAL_MEMORY_SCOPE_ID)
      .default(GLOBAL_MEMORY_SCOPE_ID),
    targetClaimId: id.nullable().default(null),
    text: z.string().trim().min(1).max(12000),
    sourceType: z.enum(["user_statement", "character_setting"]),
    resolutions: z
      .array(z.object({ label, entityInformationId: id }).strict())
      .max(16)
      .default([]),
  })
  .strict();
export type MemoryIngestionSubmission = z.infer<
  typeof memoryIngestionSubmissionSchema
>;

export const memoryIngestionPlanSchema = z
  .object({
    version: z.literal(MEMORY_INGESTION_VERSION),
    subjects: z
      .array(
        z
          .object({
            key: label,
            label,
            existingEntityId: id.nullable(),
            evidenceQuote: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(16),
    claims: z
      .array(
        z
          .object({
            subjectKey: label,
            predicate: z.string().trim().min(1).max(128),
            value: z.string().trim().min(1).max(2000),
            objectSubjectKey: label.nullable(),
            evidenceQuote: z.string().min(1).max(4000),
            epistemic: z.enum(["assertion", "inference", "uncertain"]),
            supersedesClaimId: id.nullable(),
            supplementsClaimId: id.nullable().default(null),
            validFrom: z.iso.datetime({ offset: true }).nullable(),
            validTo: z.iso.datetime({ offset: true }).nullable(),
          })
          .strict(),
      )
      .max(32),
    questions: z.array(z.string().min(1).max(1000)).max(8),
    unprocessed: z.array(z.string().min(1).max(1000)).max(32),
  })
  .strict();
export type MemoryIngestionPlan = z.infer<typeof memoryIngestionPlanSchema>;

export const memoryIngestionCandidateSchema = z
  .object({
    entityInformationId: id,
    label,
    description: z.string().max(1000),
  })
  .strict();
export const memoryIngestionResultSchema = z
  .object({
    status: z.enum(["new", "linked", "revised", "unprocessed"]),
    label: z.string(),
    entityInformationId: id.optional(),
    claimId: id.optional(),
    supersedesClaimId: id.optional(),
    sourceInformationId: id.optional(),
  })
  .strict();
export type MemoryIngestionResult = z.infer<typeof memoryIngestionResultSchema>;
export const memoryIngestionJobSchema = z
  .object({
    // 旧任务仍可读取并显示 incompatible_contract，不能通过新版 submission 重放。
    ...memoryIngestionSubmissionSchema.shape,
    scopeInformationId: id,
    contractVersion: z.number().int(),
    submitter: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    status: z.enum([
      "queued",
      "processing",
      "clarification",
      "succeeded",
      "partial",
      "failed",
    ]),
    attempt: z.number().int().nonnegative(),
    questions: z.array(z.string()),
    ambiguities: z.array(
      z
        .object({ label, candidates: z.array(memoryIngestionCandidateSchema) })
        .strict(),
    ),
    results: z.array(memoryIngestionResultSchema),
    errorCode: z.string().nullable(),
  })
  .strict();
export type MemoryIngestionJob = z.infer<typeof memoryIngestionJobSchema>;
export const memoryIngestionJobsSchema = z
  .object({ jobs: z.array(memoryIngestionJobSchema) })
  .strict();
export const memoryIngestionRecordSchema = z
  .object({
    claimId: id,
    subjectInformationId: id,
    subjectLabel: label,
    predicate: z.string(),
    value: z.string(),
    sourceType: z.enum(["user_statement", "character_setting"]),
    sourceInformationId: id,
    evidenceText: z.string(),
    deleted: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type MemoryIngestionRecord = z.infer<typeof memoryIngestionRecordSchema>;
export const memoryIngestionRecordsSchema = z
  .object({
    records: z.array(memoryIngestionRecordSchema),
    hasMore: z.boolean(),
  })
  .strict();
export const memoryIngestionMutationSchema = z
  .object({
    operationId: z.uuid(),
    claimId: id,
    action: z.enum(["delete", "restore"]),
  })
  .strict();
export type MemoryIngestionMutation = z.infer<
  typeof memoryIngestionMutationSchema
>;
export const userStatementPayloadSchema = z
  .object({
    requestId: z.uuid(),
    sessionId: z.uuid(),
    scopeInformationId: id,
    sourceType: z.enum(["user_statement", "character_setting"]),
    submitter: z.literal("webui:management"),
    text: z.string().min(1).max(12000),
    originalSourceInformationId: id.nullable().default(null),
    scope: z
      .object({
        platform: id,
        adapterId: id,
        destination: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("group"), groupId: id }).strict(),
          z.object({ kind: z.literal("private"), userId: id }).strict(),
          z.object({ kind: z.literal("web") }).strict(),
        ]),
      })
      .strict(),
  })
  .strict();
