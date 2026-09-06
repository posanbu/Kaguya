/**
 * 功能概述：定义 durable one-shot scheduler 的跨模块输入、提交与回执契约。
 * 主要职责：描述 schedule/replace/finish 能力、Core 提交边界、fencing guard 及其返回结果。
 * 代码库关系：依赖 schema 的信息原子与 JSON 类型，并依赖 SDK 的 capability/activation 类型；
 * Runtime、Core 和模块 capability client 以这些类型对接，具体存储与计时实现位于相邻包。
 * 输入输出与副作用：本文件仅提供类型和 capability token，不执行 I/O、计时或持久化；
 * schedule 与 terminal 请求由调用方携带 operation key、来源信息和 activation 以保证幂等与追溯。
 */
import type { DeepReadonly, InformationAtom, InformationId, InformationReference, JsonObject } from "@kaguya/schema";
import { defineModuleCapability, type ModuleActivationProvenance } from "@kaguya/sdk";

export type { ModuleActivationProvenance } from "@kaguya/sdk";
export type { DeepReadonly, InformationAtom, InformationId, InformationReference, JsonObject } from "@kaguya/schema";

export interface OneShotScheduleRequest { readonly operationKey: string; readonly sourceInformationId: InformationId; readonly dueAt: string; readonly input: JsonObject; readonly activation: ModuleActivationProvenance; readonly references?: readonly InformationReference[]; }
export interface OneShotScheduleReplacement extends OneShotScheduleRequest { readonly previousScheduleInformationId: InformationId; }
export type OneShotScheduleReceipt = { readonly scheduleInformationId: InformationId; readonly created: boolean; };
export type OneShotReplacementReceipt = OneShotScheduleReceipt & { readonly previousOutcome: "superseded" | "already-terminal"; readonly previousTerminalInformationId: InformationId; };
export interface OneShotTerminalResult { readonly scheduleInformationId: InformationId; readonly terminalInformationId: InformationId; readonly status: "fired" | "superseded" | "failed"; readonly created: boolean; }
export interface OneShotDueReceipt { readonly scheduleInformationId: InformationId; readonly dueInformationId: InformationId; readonly created: boolean; }
export type OneShotTerminalRequest = { readonly scheduleInformationId: InformationId; readonly status: "fired"; } | { readonly scheduleInformationId: InformationId; readonly status: "failed"; readonly failureKind: "consumer-failed" | "input-unavailable"; };
export interface OneShotScheduleCapability { schedule(input: OneShotScheduleRequest): Promise<OneShotScheduleReceipt>; replace(input: OneShotScheduleReplacement): Promise<OneShotReplacementReceipt>; finish(input: OneShotTerminalRequest): Promise<OneShotTerminalResult>; }
export interface OneShotScheduleCorePort { scheduleOneShot(input: OneShotScheduleRequest): Promise<OneShotScheduleReceipt>; replaceOneShot(input: OneShotScheduleReplacement): Promise<OneShotReplacementReceipt>; finishOneShot(input: OneShotTerminalRequest): Promise<OneShotTerminalResult>; }
export interface OneShotFencingGuard { readonly subscriptionId: string; readonly informationId: InformationId; readonly token: string; readonly attempt: number; readonly leaseUntil: string; readonly signal?: AbortSignal; }
export interface OneShotCreateCommit { readonly operationKey: string; readonly schedule: DeepReadonly<InformationAtom>; readonly dueAt: string; readonly guard?: OneShotFencingGuard; }
export interface OneShotReplaceCommit { readonly operationKey: string; readonly previousScheduleInformationId: InformationId; readonly schedule: DeepReadonly<InformationAtom>; readonly superseded: DeepReadonly<InformationAtom>; readonly dueAt: string; readonly guard?: OneShotFencingGuard; }
export interface OneShotDueCommit { readonly scheduleInformationId: InformationId; readonly due: DeepReadonly<InformationAtom>; }
export interface OneShotTerminalCommit { readonly scheduleInformationId: InformationId; readonly terminal: DeepReadonly<InformationAtom>; readonly guard?: OneShotFencingGuard; }
export const oneShotScheduleCapability = defineModuleCapability<OneShotScheduleCapability>("kaguya:schedule.one-shot", 1);
