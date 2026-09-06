/**
 * 功能概述：提供模块侧 one-shot scheduler capability client，负责边界校验与 Core port 转发。
 * 主要职责：normalizeDueAt 将带时区 deadline 规范化为 UTC；schedule/replace/finish 解析完整输入，
 * 然后分别调用 Core 的同名 durable 操作，并原样传播底层错误。
 * 代码库关系：依赖 contracts 与 schema；由 Runtime capability factory 构造，Core 负责 Registry、数据库和 fencing。
 * 输入输出与副作用：校验失败不会调用 Core；成功调用只产生一个异步 port 请求，不改写回执或异常。
 */
import { informationIdSchema, informationReferenceSchema, jsonObjectSchema, z } from "@kaguya/schema";
import type { OneShotScheduleCorePort, OneShotScheduleRequest, OneShotScheduleReplacement, OneShotTerminalRequest } from "./contracts.js";
export function normalizeDueAt(value: string): string { if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new Error("one-shot schedule requires an absolute dueAt"); const epoch = Date.parse(value); if (!Number.isFinite(epoch)) throw new Error("invalid one-shot dueAt"); return new Date(epoch).toISOString(); }
const activationSchema = z.object({ instanceId: z.string().trim().min(1), definitionId: z.string().trim().min(1) }).strict();
const scheduleSchema = z.object({ operationKey: z.string().trim().min(1), sourceInformationId: informationIdSchema, dueAt: z.string(), input: jsonObjectSchema, activation: activationSchema, references: z.array(informationReferenceSchema).readonly().optional() }).strict();
const replacementSchema = scheduleSchema.extend({ previousScheduleInformationId: informationIdSchema }).strict();
const terminalSchema = z.discriminatedUnion("status", [z.object({ scheduleInformationId: informationIdSchema, status: z.literal("fired") }).strict(), z.object({ scheduleInformationId: informationIdSchema, status: z.literal("failed"), failureKind: z.enum(["consumer-failed", "input-unavailable"]) }).strict()]);
export class OneShotScheduleClient {
  constructor(private readonly core: OneShotScheduleCorePort) {}
  async schedule(input: OneShotScheduleRequest) { const parsed = scheduleSchema.parse(input); const normalized = parsed.references === undefined ? { operationKey: parsed.operationKey, sourceInformationId: parsed.sourceInformationId, dueAt: normalizeDueAt(parsed.dueAt), input: parsed.input, activation: parsed.activation } : { ...parsed, dueAt: normalizeDueAt(parsed.dueAt), references: parsed.references }; return this.core.scheduleOneShot(normalized); }
  async replace(input: OneShotScheduleReplacement) { const parsed = replacementSchema.parse(input); const normalized = parsed.references === undefined ? { operationKey: parsed.operationKey, sourceInformationId: parsed.sourceInformationId, dueAt: normalizeDueAt(parsed.dueAt), input: parsed.input, activation: parsed.activation, previousScheduleInformationId: parsed.previousScheduleInformationId } : { ...parsed, dueAt: normalizeDueAt(parsed.dueAt), references: parsed.references }; return this.core.replaceOneShot(normalized); }
  async finish(input: OneShotTerminalRequest) { const parsed = terminalSchema.parse(input); return this.core.finishOneShot(parsed); }
}
