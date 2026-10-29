/**
 * 功能概述：将 PR 必须执行的集成测试列为关键门禁，复用根 Vitest 配置和分片策略。
 * 主要职责：criticalTests 固定完整文件清单；校验文件存在后合并配置，禁止按用例名称缩小范围。
 * 代码库关系：CI 的关键分片调用本文件；包含观察仓储、Runtime 接线、Memory 重挂载、Demo DAG 及 Lifecycle/Router/Heartbeat 回归。
 * 输入输出与副作用：只配置测试收集，不改变生产代码、测试断言或等待预算。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// PR 必须执行这些文件中的全部用例。通过分片控制耗时，不按用例名称过滤。
// 新增关键行为时维护此清单。每日全量测试仍使用基础配置收集全部测试。
const criticalTests = [
  "packages/config/src/model.test.ts",
  "packages/config/src/manager.test.ts",
  "packages/config/src/module-config.test.ts",
  "packages/config/src/startup-validation.test.ts",
  "packages/database/src/schema.test.ts",
  "packages/database/src/observation-store.test.ts",
  "packages/runtime/src/observation-runtime.test.ts",
  "packages/runtime/src/runtime.test.ts",
  "packages/modules/src/first-party/router/index.test.ts",
  "packages/modules/src/first-party/lifecycle/index.test.ts",
  "packages/modules/src/first-party/heartbeat/observation.test.ts",
  "packages/modules/src/first-party/heartbeat/index.test.ts",
  "apps/demo/src/index.test.ts",
  "packages/database/src/memory-graph.test.ts",
  "packages/database/src/reliable-core.test.ts",
  "packages/database/src/reliable-repository.test.ts",
  "packages/database/src/reliable-runner.test.ts",
  "packages/engine/src/module-security.test.ts",
  "packages/runtime/src/gateway-allowlist.test.ts",
  "packages/runtime/src/model-task-persistence.test.ts",
  "packages/runtime/src/native-input.test.ts",
  "packages/modules/src/first-party/router/agent-contracts.test.ts",
  "packages/modules/src/first-party/situation-model.test.ts",
  "apps/server/src/memory-graph-routes.test.ts",
  "apps/server/src/app.test.ts",
  "apps/server/src/configuration-application.test.ts",
  "apps/server/src/feature-management.test.ts",
  "apps/server/src/server-composition.test.ts",
  "apps/server/src/gateway-auth.test.ts",
  "apps/server/src/web-chat.integration.test.ts",
  "apps/server/src/speech-planner.test.ts",
  "apps/web/src/memory-graph-model.test.ts",
  "apps/web/src/memory-graph-colors.test.ts",
  "apps/web/src/components/AppShell.test.tsx",
];

// Vitest 的位置参数是过滤器，失效的文件名可能被静默忽略。
// 使用精确 include，并在运行任何分片前检查完整清单。
for (const path of criticalTests) {
  if (!existsSync(fileURLToPath(new URL(path, import.meta.url)))) {
    throw new Error(`Critical test file is missing: ${path}`);
  }
}

if (process.env.CI && !process.env.KAGUYA_TEST_DATABASE_URL?.trim()) {
  throw new Error("Critical CI tests require KAGUYA_TEST_DATABASE_URL");
}

export default mergeConfig(baseConfig, {
  test: {
    include: criticalTests,
    passWithNoTests: false,
    allowOnly: false,
    bail: 0,
  },
});
