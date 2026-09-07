/**
 * 功能概述：声明可靠消费耗尽后的可见终态；这是执行事实，不定义任何 Agent 策略。
 * 主要职责：executionExhaustedInformationKind 保存稳定 subscription ID 和次数，以 caused-by/status-of 引用 source。
 * 代码库关系：Core 启动时登记，Runner 在有界失败后经数据库同事务写入并封闭 delivery。
 * 输入输出与副作用：定义本身无 I/O；payload 与日志不包含输入正文或原始异常。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
export const executionExhaustedInformationKind = defineInformationKind({
  kind: "execution.exhausted",
  payloadSchema: z
    .object({
      subscriptionId: z.string(),
      attempts: z.number().int().nonnegative(),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
  },
  log: {
    enabled: true,
    level: "error",
    project: ({ payload }) => ({
      event: "execution.exhausted",
      subscriptionId: payload.subscriptionId,
      attempts: payload.attempts,
    }),
  },
});
