/**
 * 冻结上下文门禁覆盖千条输入、Light/Heavy 持久请求分页与缺失授权，使用真实 Selector 和数据库。
 * GUI 门禁包括原始图片 SDK 请求体、固定模型恢复以及人工控制丢回执与清理。
 * 功能概述：将 PR 必须执行的集成测试列为关键门禁，复用根 Vitest 配置和分片策略。
 * 主要职责：criticalTests 固定完整文件清单；校验文件存在后合并配置，禁止按用例名称缩小范围。
 * 代码库关系：CI 的关键分片调用本文件；包含观察仓储、Runtime/环境执行接线、Memory 重挂载、Demo DAG 及 Lifecycle/Router/Heartbeat 回归。
 * MCP 门禁以真实 stdio/HTTP 合成进程覆盖冻结目录、取消清理和 Server/W3 持久闭环。
 * W11 双数据库重放验证正式 writer；Lifecycle 活动、调度目录、配置迁移和当前情境一起验收。
 * 媒体权限/冻结恢复、unknown资源保留、旧Heavy升级防重发、真实Identity并发与离线迁移拒绝均收集完整文件。
 * 输入输出与副作用：只配置测试收集，不改变生产代码、测试断言或等待预算。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// PR 必须执行这些文件中的全部用例。通过分片控制耗时，不按用例名称过滤。
// 新增关键行为时维护此清单。每日全量测试仍使用基础配置收集全部测试。
const criticalTests = [
  "packages/database/src/continuity-store.test.ts",
  "packages/composition/src/continuity.test.ts",
  "packages/composition/src/continuity-delivery.test.ts",
  "packages/modules/src/first-party/continuity/index.test.ts",
  "packages/config/src/model.test.ts",
  "packages/config/src/manager.test.ts",
  "packages/config/src/module-config.test.ts",
  "packages/config/src/startup-validation.test.ts",
  "packages/database/src/schema.test.ts",
  "packages/database/src/observation-store.test.ts",
  "packages/mcp/src/host.test.ts",
  "apps/server/src/mcp-host.test.ts",
  "apps/server/src/inspection-domain.test.ts",
  "apps/server/src/issue279-replay.test.ts",
  "apps/server/src/inspection-situation.test.ts",
  "packages/runtime/src/action.test.ts",
  "packages/runtime/src/native-tool-loop.test.ts",
  "packages/runtime/src/native-tool-results.test.ts",
  "apps/server/src/native-gui-wire.test.ts",
  "packages/runtime/src/environment-human.test.ts",
  "apps/server/src/linux-environment-routes.test.ts",
  "packages/llm/src/client.test.ts",
  "packages/runtime/src/environment.test.ts",
  "packages/runtime/src/linux-tools.test.ts",
  "apps/server/src/linux-tools-host.test.ts",
  "packages/platform-adapters/src/napcat.test.ts",
  "packages/database/src/native-memory.test.ts",
  "packages/database/src/native-memory-revisions.test.ts",
  "packages/modules/src/first-party/memory-native/index.test.ts",
  "packages/modules/src/first-party/memory-native/recovery.test.ts",
  "packages/modules/src/first-party/heavy/recall.test.ts",
  "packages/modules/src/first-party/heavy/message-context.test.ts",
  "packages/modules/src/first-party/heavy/frozen-context-persistence.test.ts",
  "packages/modules/src/first-party/memory-native/formation.test.ts",
  "packages/modules/src/first-party/memory-native/formation-prompt.test.ts",
  "promptfoo/portrait-behavior-provider.test.ts",
  "packages/modules/src/first-party/memory-native/prompt.test.ts",
  "packages/runtime/src/observation-runtime.test.ts",
  "packages/runtime/src/runtime.test.ts",
  "packages/modules/src/first-party/router/index.test.ts",
  "packages/modules/src/first-party/lifecycle/index.test.ts",
  "packages/modules/src/first-party/lifecycle/activity.test.ts",
  "packages/modules/src/first-party/lifecycle/inspection.test.ts",
  "apps/server/src/lifecycle-migration.test.ts",
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
  "apps/server/src/postgres-cli.test.ts",
  "apps/server/src/gateway-auth.test.ts",
  "apps/server/src/web-chat.integration.test.ts",
  "apps/server/src/speech-planner.test.ts",
  "apps/web/src/memory-graph-model.test.ts",
  "apps/web/src/memory-graph-colors.test.ts",
  "apps/web/src/components/AppShell.test.tsx",
  "examples/plugins/qwen-tts/provider.test.mjs",
  "examples/plugins/qwen-tts/plugin.test.mjs",
  "examples/plugins/qwen-tts/runtime.test.mjs",
  "packages/runtime/src/media-resource-store.test.ts",
  "packages/runtime/src/media-resource-retention.test.ts",
  "packages/runtime/src/media-input.test.ts",
  "apps/server/src/media-output.test.ts",
  "packages/runtime/src/media-input-wire.test.ts",
  "packages/runtime/src/media-vision.test.ts",
  "packages/runtime/src/image-decoder.test.ts",
  "packages/database/src/media-resource-store.test.ts",
  "apps/server/src/media-download.test.ts",
  "packages/runtime/src/model-task.test.ts",
  "packages/modules/src/first-party/heavy/index.test.ts",
  "packages/modules/src/first-party/heavy/confirmation.test.ts",
  "packages/modules/src/first-party/heavy/pacing-recovery.test.ts",
  "packages/modules/src/first-party/memory-native/experience-operations.test.ts",
  "packages/modules/src/first-party/identity/durable.test.ts",
  "packages/modules/src/first-party/lifecycle/observation-scene.test.ts",
  "packages/modules/src/first-party/router/focus.test.ts",
  "apps/server/src/offline-upgrade.test.ts",
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
