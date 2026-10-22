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
