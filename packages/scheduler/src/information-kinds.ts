/**
 * 功能概述：声明 one-shot scheduler 写入信息 ledger 的五种稳定 information kind。
 * 主要职责：为 requested、due 与 fired/superseded/failed terminal payload 提供严格 JSON schema，
 * 并声明 caused-by、replaces、status-of 引用约束，保证调度事实可追溯且可验证。
 * 代码库关系：Runtime/InformationCore 将这些 definition 注册进 Registry；scheduler client 仅提交数据。
 * 输入输出与副作用：定义创建时同步校验并冻结 metadata；无数据库、timer 或其他 I/O。
 */
import { informationIdSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

const activationSchema = z.object({ instanceId: z.string().trim().min(1), definitionId: z.string().trim().min(1) }).strict();
const opaqueJsonObjectSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const requestedPayloadSchema = z.object({ operationKey: z.string().trim().min(1), dueAt: z.iso.datetime({ offset: true }), input: opaqueJsonObjectSchema, activation: activationSchema }).strict();
const duePayloadSchema = z.object({ scheduleInformationId: informationIdSchema, dueAt: z.iso.datetime({ offset: true }), deliveredAt: z.iso.datetime({ offset: true }) }).strict();
const terminalReference = { "core:status-of": { required: true, multiple: false, targetKinds: ["core.schedule.one-shot.requested"] } } as const;
export const oneShotRequestedInformationKind = defineInformationKind({ kind: "core.schedule.one-shot.requested", payloadSchema: requestedPayloadSchema, references: { "core:caused-by": { required: true, multiple: false }, "core:replaces": { required: false, multiple: false } }, log: { enabled: false } });
export const oneShotDueInformationKind = defineInformationKind({ kind: "core.schedule.one-shot.due", payloadSchema: duePayloadSchema, references: terminalReference, log: { enabled: false } });
export const oneShotFiredInformationKind = defineInformationKind({ kind: "core.schedule.one-shot.fired", payloadSchema: z.object({}).strict(), references: terminalReference, log: { enabled: false } });
export const oneShotSupersededInformationKind = defineInformationKind({ kind: "core.schedule.one-shot.superseded", payloadSchema: z.object({}).strict(), references: terminalReference, log: { enabled: false } });
export const oneShotFailedInformationKind = defineInformationKind({ kind: "core.schedule.one-shot.failed", payloadSchema: z.object({ failureKind: z.enum(["consumer-failed", "input-unavailable"]) }).strict(), references: terminalReference, log: { enabled: false } });
export const oneShotInformationKinds = [oneShotRequestedInformationKind, oneShotDueInformationKind, oneShotFiredInformationKind, oneShotSupersededInformationKind, oneShotFailedInformationKind] as const;
