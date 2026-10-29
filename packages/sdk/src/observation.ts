/**
 * 功能概述：声明按 scene 与消费者独立推进的持久观察端口，不将观察完成等同于推理或副作用成功。
 * observationInputSchema 固定消费身份、地址、策略和来源 Kind；ObservationSnapshot 保存来源清单及补充版本。
 * ObservationAccess.freezeNext 按操作键分配有界范围，无键调用保留旧串行接口；finish 合并连续成功段，fail/defer/supersede 不确认范围。
 * 代码库关系：database 实现事务、唯一约束和进度，Runtime 注入 observationCapability；业务模块无 SQL 权限。
 * 输入输出与副作用：schema 校验无 I/O；端口可产生持久快照，失败不得推进成功水位。
 */
import {
  informationIdSchema,
  platformDestinationSchema,
  z,
  type SceneAddress,
  type DeepReadonly,
} from "@kaguya/schema";
import { defineModuleCapability } from "./modules.js";

/** 冻结时的证据与知识边界；正文保存在 manifest，不查询后来发布的版本。 */
export const observationManifestSchema = z
  .object({
    version: z.literal(1),
    runInformationId: informationIdSchema,
    frozenInformationId: informationIdSchema,
    sourceInformationIds: z.array(informationIdSchema),
    knowledgeCutoff: z
      .object({
        informationId: informationIdSchema,
        memoryRevisions: z.array(
          z
            .object({ id: z.string(), revision: z.number().int().positive() })
            .strict(),
        ),
      })
      .strict(),
    content: z.record(z.string(), z.json()),
  })
  .strict();
export type ObservationManifest = z.infer<typeof observationManifestSchema>;

export const observationInputSchema = z
  .object({
    consumerId: z.string().trim().min(1).max(200),
    policyVersion: z.string().trim().min(1).max(100),
    address: z
      .object({
        platform: z.string().min(1),
        adapterId: z.string().min(1),
        destination: platformDestinationSchema,
      })
      .strict(),
    kinds: z.array(z.string().min(1)).min(1).max(32),
    // 完成事实须使用此 Kind，payload.observationId 绑定本次快照，并直接引用全部冻结证据。
    resultKind: z.string().min(1),
    startAfterInformationId: informationIdSchema.optional(),
    // 旧 cognition 私聊额外按 sender 隔离，不因 scene 统一而扩大读取范围。
    senderId: z.string().min(1).optional(),
  })
  .strict();
export type ObservationInput = z.infer<typeof observationInputSchema>;
export interface ObservationSnapshot {
  readonly observationId: string;
  readonly operationKey: string | null;
  readonly manifest: DeepReadonly<ObservationManifest> | null;
  readonly complete: boolean;
  readonly receivedThroughPosition: string;
  readonly deferredUntil: string | null;
  readonly replacementObservationId: string | null;
  readonly contract: DeepReadonly<ObservationInput>;
  /** 冻结时仍有本次上界内的来源未进入本页；后到来源不回写该标志。 */
  readonly hasMore: boolean;
  readonly sceneId: string;
  readonly consumerId: string;
  readonly policyVersion: string;
  readonly address: SceneAddress;
  readonly afterPosition: string;
  readonly throughPosition: string;
  readonly sourceInformationIds: readonly string[];
  readonly contextInformationIds: readonly string[];
  readonly recordedAt: string;
  readonly status: "frozen" | "completed" | "failed";
  readonly resultInformationId: string | null;
  readonly errorCode: string | null;
}
export const observationFreezeSchema = observationInputSchema
  .extend({
    operationKey: z.string().min(1).max(1000).optional(),
    manifest: observationManifestSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(64),
    throughInformationId: informationIdSchema.optional(),
    contextInformationIds: z.array(informationIdSchema).max(100).default([]),
  })
  .strict();
export type ObservationFreezeInput = z.input<typeof observationFreezeSchema>;
export interface ObservationProgress {
  readonly sceneId: string;
  readonly consumerId: string;
  readonly policyVersion: string;
  readonly address: SceneAddress;
  readonly throughPosition: string;
  readonly throughInformationId: string | null;
  readonly discoveredThroughPosition: string;
  readonly allocatedThroughPosition: string;
  readonly revision: number;
  readonly latestObservationId: string | null;
}
export interface ObservationAccess {
  discover(input: ObservationInput): Promise<ObservationProgress>;
  pending(input: ObservationInput): Promise<readonly ObservationSnapshot[]>;
  defer(
    observationId: string,
    until: string,
    scheduleInformationId: string,
  ): Promise<void>;
  replace(
    observationId: string,
    operationKey: string,
    manifest: ObservationManifest,
  ): Promise<ObservationSnapshot>;
  supersede(
    observationId: string,
    replacementObservationId: string,
  ): Promise<void>;
  freezeNext(
    input: ObservationFreezeInput,
  ): Promise<ObservationSnapshot | undefined>;
  finish(
    observationId: string,
    resultInformationId: string,
  ): Promise<ObservationSnapshot>;
  fail(observationId: string, errorCode: string): Promise<void>;
  read(observationId: string): Promise<ObservationSnapshot | undefined>;
  progress(input: ObservationInput): Promise<ObservationProgress | undefined>;
}
export const observationCapability = defineModuleCapability<ObservationAccess>(
  "agent:observation",
  1,
);
export class ObservationConflictError extends Error {
  constructor() {
    super("Observation contract or result conflict");
    this.name = "ObservationConflictError";
  }
}
