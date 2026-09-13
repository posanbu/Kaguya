/**
 * 功能概述：定义 Engine 内建的信息 kind；当前唯一内建事实是消费者失败记录。
 * 主要职责：`consumerFailedInformationKind` 约束失败消费者身份、无堆栈的错误摘要，
 * 并要求用 `core:caused-by` 引用触发失败的已提交原子；若输入属于单一运行 context，
 * `consumer.failed` 还可继承一个不绑定 Runtime kind 的 `core:context` 引用。
 * 代码库关系：`InformationCore` 在消费者 reject 后注册此定义，并在构造时将其作为
 * Registry 内建 kind 注册；Runtime 后续只能复用此同一导出，不能重新定义该 kind。
 * 输入输出与副作用：仅创建冻结的 kind 定义，无 I/O；payload 只包含 consumer 与
 * error.errorType/error.message，避免保留原始异常对象或 stack。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

export const consumerFailedInformationKind = defineInformationKind({
  kind: "consumer.failed",
  displayName: "信息消费者失败",
  description:
    "信息订阅处理抛出异常时由 Core 记录消费者身份和安全错误；诊断沿因果引用定位来源，不保留原始异常堆栈。",
  payloadSchema: z
    .object({
      consumer: z.union([
        z.object({ consumerId: z.string().min(1) }).strict(),
        z
          .object({
            consumerId: z.string().min(1),
            definitionId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            consumerId: z.string().min(1),
            instanceId: z.string().min(1),
          })
          .strict(),
        z
          .object({
            consumerId: z.string().min(1),
            definitionId: z.string().min(1),
            instanceId: z.string().min(1),
          })
          .strict(),
      ]),
      error: z
        .object({
          errorType: z.string().min(1).max(128),
          message: z.string().max(1024),
        })
        .strict(),
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
    },
    "core:context": {
      required: false,
      multiple: false,
    },
  },
  log: {
    enabled: true,
    level: "error",
    project: ({ payload }) => ({
      event: "consumer.failed",
      consumerId: payload.consumer.consumerId,
      ...("definitionId" in payload.consumer
        ? { definitionId: payload.consumer.definitionId }
        : {}),
      ...("instanceId" in payload.consumer
        ? { instanceId: payload.consumer.instanceId }
        : {}),
      errorType: payload.error.errorType,
    }),
  },
});
