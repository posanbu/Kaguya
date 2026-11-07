/**
 * Inspection 导出 GUI 结果的纯 metadata 校验计划，无 blob 读取或工具执行。
 * native-tool-loop 导出宿主工具注册、任务路由和持久协调器，不在导入时执行工具。
 * linux-gui 导出桌面/窗口观察与一次性输入 schema，运行时许可仍由 LinuxEnvironmentClient 和 broker 校验。
 * 功能概述：汇总 Runtime 的最终信息原子 API，导出 kind 与
 * `KaguyaRuntime` ingress 与宿主 MessageTargetService/查询契约；model-task 导出通用 capability token、请求/结果契约与 ModelTaskClient；environment 导出 Linux broker 客户端。
 * 主要职责：稳定 re-export，不创建数据库、Core、模块或 transport；事件 dispatch、
 * workflow 和旧 service locator 已从公共面删除。
 * 代码库关系：apps/server 与 demo 从包入口消费 Runtime；Runtime 实现并消费
 * platform-adapters 定义的 `InformationIngress`/transport 契约。本 barrel 依次重导出
 * allowlist、kind、Model Task 与组合 Runtime，停止导出旧 reply-only lifecycle；所有入站数据都通过 `InformationIngress.submit`，
 * 无需事件桥接或重复 definition。
 * 输入输出与副作用：仅静态导出符号，无运行时 I/O；所有 kind definition 保持其原始对象身份。
 */
export * from "./gateway-allowlist.js";
export * from "./information-kinds.js";
export * from "./model-task.js";
export * from "@kaguya/scheduler";
export * from "./runtime.js";
export * from "./media-input.js";
export * from "./media-resource-store.js";
export { executionExhaustedInformationKind } from "@kaguya/engine";

export * from "./message-targets.js";

export { ActionExecutor, type ActionExecutorOptions } from "./action.js";
export {
  LinuxEnvironmentClient,
  createUnixBrokerTransport,
  type BrokerTransport,
  type ActionEnvironment,
  type EnvironmentControl,
  type HumanOperation,
  type HumanReceipt,
} from "./environment.js";

export * from "./native-tool-loop.js";
export {
  LinuxToolsHost,
  linuxShellSchema,
  linuxToolsConfigurationSchema,
  type LinuxToolsConfiguration,
} from "./linux-tools.js";

export { createNativeMemoryTools } from "./native-memory-tools.js";
export {
  linuxBrowserObservationSchema,
  linuxBrowserObserveSchema,
  linuxBrowserActSchema,
  linuxBrowserVerifySchema,
} from "./linux-browser.js";
export {
  linuxGuiTargetSchema,
  linuxGuiObservationSchema,
  linuxGuiObserveSchema,
  linuxGuiActSchema,
  linuxGuiVerifySchema,
} from "./linux-gui.js";

export {
  GuiTaskService,
  guiTaskInputSchema,
  type GuiTaskHost,
} from "./gui-tasks.js";

export { planNativeToolResults } from "./native-tool-results.js";
