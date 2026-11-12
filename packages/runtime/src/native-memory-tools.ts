/**
 * 功能概述：把宿主 Memory 工具目录接到 W3 provider；模型只拿到有界 schema 与稳定别名。
 * createNativeMemoryTools 固定 provider/策略版本；scope、step 和 run 由 bind 绑定，写入走数据库同锁复验。
 * Runtime 只有同时开启 Memory 与 nativeTools.memory 才安装；外部目录不能占用保留 provider 名。
 */
import {
  NativeMemoryTools,
  nativeMemoryToolSchemas,
  type KaguyaDatabase,
} from "@kaguya/database";
import type { ActionProvider } from "@kaguya/sdk";
import type { NativeToolRegistration } from "./native-tool-loop.js";
export function createNativeMemoryTools(db: KaguyaDatabase): {
  registrations: NativeToolRegistration[];
  provider: ActionProvider;
} {
  const store = new NativeMemoryTools(db.sql);
  return {
    registrations: Object.entries(nativeMemoryToolSchemas).map(
      ([id, inputSchema]) => ({
        id,
        version: "1",
        description: {
          "memory.query": "查询当前冻结知识中的相关 Memory。",
          "memory.read": "按明确节点及修订读取完整 Memory。",
          "memory.history": "按冻结范围分页读取节点历史。",
          "memory.correct":
            "用选定行动回执修订自身 Memory；不改身份、锁、来源历史或人工事实。",
          "memory.record":
            "将选定工具回执保存为自身工具观察；unknown/partial 不代表成功，也不是他人的自述。",
        }[id]!,
        inputSchema,
        providerId: "core.native-memory",
        providerVersion: "1",
        executor: "host:memory",
        policyVersion: "1",
        readonly: !["memory.correct", "memory.record"].includes(id),
        independent: false,
        bind: async (input) => ({
          target: {
            runInformationId: input.runInformationId,
            stepInformationId: input.stepInformationId,
            scope: input.scope,
          },
        }),
        authorize: async ({ intent }) =>
          intent.providerId === "core.native-memory" &&
          intent.executor === "host:memory" &&
          intent.target.scope === intent.scope,
      }),
    ),
    provider: {
      id: "core.native-memory",
      version: "1",
      capabilities: {
        cancellation: "none",
        idempotency: "operation",
        reconciliation: false,
        successEvidence: "effect-verified",
        fencing: "none",
      },
      execute: async (input) => ({
        status: "succeeded",
        evidence: "effect-verified",
        result: await store.execute(input),
        artifacts: [],
        truncated: false,
      }),
    },
  };
}
